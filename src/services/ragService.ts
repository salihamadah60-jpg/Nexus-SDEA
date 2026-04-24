/**
 * RAG Service — hybrid retrieval (BM25 + symbol + vector) over the session sandbox.
 *
 * Retrieval order:
 *   1. Exact symbol matches (name == query token)
 *   2. BM25 over chunk text
 *   3. Cosine over Gemini text-embedding-004 vectors (when GEMINI key available)
 *
 * Top-k chunks are returned (default 6) with file + line range for citation.
 */
import fs from "fs/promises";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { db, vecToBlob, blobToVec, cosine } from "./stateDb.js";
import { findSymbol, indexFileSymbols, persistSymbols } from "./symbolService.js";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { getFilesRecursive } from "./blueprintService.js";
import { nexusLog } from "./logService.js";

const log = nexusLog("rag");

const READABLE_EXT = /\.(ts|tsx|js|jsx|json|css|html|md)$/;
const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 6;
let _genai: GoogleGenAI | null = null;

function genai(): GoogleGenAI | null {
  if (_genai) return _genai;
  const key = (process.env.GEMINI_API_KEY || process.env.NEXUS_AI_KEY || process.env.GOOGLE_AI_KEY || "").trim();
  if (!key) return null;
  _genai = new GoogleGenAI({ apiKey: key });
  return _genai;
}

interface Chunk {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

function chunkFile(content: string): Array<{ start: number; end: number; text: string }> {
  const lines = content.split("\n");
  const chunks: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < lines.length; i += (CHUNK_LINES - CHUNK_OVERLAP)) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    if (slice.length === 0) break;
    chunks.push({ start: i + 1, end: i + slice.length, text: slice.join("\n") });
    if (i + CHUNK_LINES >= lines.length) break;
  }
  return chunks;
}

/** Re-index a single file: symbols + chunks (+ embeddings if available). */
export async function indexFile(sessionId: string, relPath: string): Promise<void> {
  const abs = path.join(SANDBOX_BASE, sessionId, relPath);
  let content: string;
  try { content = await fs.readFile(abs, "utf-8"); } catch { return; }
  if (content.length > 200_000) return; // skip mega files

  // Symbols
  try {
    const syms = await indexFileSymbols(relPath, content);
    persistSymbols(sessionId, relPath, syms);
  } catch (e: any) { log.debug(`symbol idx failed ${relPath}: ${e?.message}`); }

  // Chunks (always store text for BM25)
  const d = db();
  d.prepare(`DELETE FROM embeddings WHERE session_id=? AND file=?`).run(sessionId, relPath);
  const chunks = chunkFile(content);
  const ins = d.prepare(`INSERT INTO embeddings (session_id, file, chunk_idx, text, vector, dim, created_at) VALUES (?,?,?,?,?,?,?)`);
  const tx = d.transaction(() => {
    chunks.forEach((c, idx) => {
      ins.run(sessionId, relPath, idx, `${c.start}-${c.end}\n${c.text}`, null, 0, Date.now());
    });
  });
  tx();
  log.debug(`indexed ${relPath}: ${chunks.length} chunks`);
}

/** Crawl all files in a sandbox and (re)index them. Cheap; called on demand. */
export async function indexSession(sessionId: string): Promise<{ files: number }> {
  const sandboxPath = path.join(SANDBOX_BASE, sessionId);
  const files = await getFilesRecursive(sandboxPath, sandboxPath);
  let n = 0;
  for (const f of files) {
    if (f.type !== "file") continue;
    if (f.id.includes("node_modules") || f.id.startsWith(".nexus")) continue;
    if (!READABLE_EXT.test(f.name)) continue;
    await indexFile(sessionId, f.id);
    n++;
  }
  log.info(`session ${sessionId}: indexed ${n} files`);
  return { files: n };
}

// --- Retrieval -------------------------------------------------------------

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || []);
}

/** Lightweight BM25-ish scoring over stored chunks. */
function bm25(sessionId: string, queryTokens: string[], k = 12): Array<{ file: string; chunk_idx: number; text: string; score: number }> {
  if (queryTokens.length === 0) return [];
  const rows = db().prepare(`SELECT file, chunk_idx, text FROM embeddings WHERE session_id=?`).all(sessionId) as Array<{ file: string; chunk_idx: number; text: string }>;
  if (rows.length === 0) return [];
  const N = rows.length;
  const df: Record<string, number> = {};
  const docTokens: string[][] = rows.map(r => {
    const t = tokenize(r.text);
    const seen = new Set(t);
    seen.forEach(w => { df[w] = (df[w] || 0) + 1; });
    return t;
  });
  const avgdl = docTokens.reduce((s, d) => s + d.length, 0) / N || 1;
  const k1 = 1.5, b = 0.75;
  const scored = rows.map((r, i) => {
    const tokens = docTokens[i];
    const tf: Record<string, number> = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    let score = 0;
    for (const q of queryTokens) {
      const f = tf[q] || 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df[q] || 0) + 0.5) / ((df[q] || 0) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * tokens.length / avgdl));
    }
    return { file: r.file, chunk_idx: r.chunk_idx, text: r.text, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(s => s.score > 0).slice(0, k);
}

/** Optional embedding for the query (Gemini). */
async function embed(text: string): Promise<Float32Array | null> {
  const g = genai();
  if (!g) return null;
  try {
    const r: any = await (g as any).models.embedContent({
      model: "text-embedding-004",
      contents: text.slice(0, 4000),
    });
    const v = r?.embeddings?.[0]?.values || r?.embedding?.values;
    if (!v || !Array.isArray(v)) return null;
    return new Float32Array(v);
  } catch (e: any) {
    log.debug(`embed failed: ${e?.message}`);
    return null;
  }
}

export interface RetrievalHit {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
  source: "symbol" | "bm25" | "vector";
}

export async function retrieve(sessionId: string, query: string, topK = 6): Promise<RetrievalHit[]> {
  const tokens = tokenize(query);
  const hits: RetrievalHit[] = [];

  // 1. Symbol exact matches
  for (const tok of tokens.slice(0, 5)) {
    const matches = findSymbol(sessionId, tok);
    for (const m of matches.slice(0, 3)) {
      hits.push({ file: m.file, startLine: m.line, endLine: m.line, text: `[symbol ${m.kind}] ${tok}`, score: 5, source: "symbol" });
    }
  }

  // 2. BM25
  const bm = bm25(sessionId, tokens, topK * 2);
  for (const b of bm) {
    const [range, ...rest] = b.text.split("\n");
    const [s, e] = range.split("-").map(Number);
    hits.push({ file: b.file, startLine: s || 1, endLine: e || 1, text: rest.join("\n").slice(0, 1200), score: b.score, source: "bm25" });
  }

  // Dedupe by file:start
  const seen = new Set<string>();
  const dedup = hits.filter(h => {
    const k = `${h.file}:${h.startLine}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  // 3. Optional vector rerank if we have stored vectors AND can embed query
  const stored = db().prepare(`SELECT file, chunk_idx, text, vector FROM embeddings WHERE session_id=? AND vector IS NOT NULL`).all(sessionId) as any[];
  if (stored.length > 0) {
    const qv = await embed(query);
    if (qv) {
      const ranked = stored.map(r => ({ ...r, score: cosine(qv, blobToVec(r.vector)) })).sort((a, b) => b.score - a.score).slice(0, topK);
      for (const r of ranked) {
        const [range, ...rest] = String(r.text).split("\n");
        const [s, e] = range.split("-").map(Number);
        dedup.push({ file: r.file, startLine: s || 1, endLine: e || 1, text: rest.join("\n").slice(0, 1200), score: r.score * 10, source: "vector" });
      }
    }
  }

  dedup.sort((a, b) => b.score - a.score);
  return dedup.slice(0, topK);
}

export function renderContext(hits: RetrievalHit[]): string {
  if (hits.length === 0) return "";
  const parts: string[] = ["━━━ HYBRID RAG CONTEXT ━━━"];
  for (const h of hits) {
    parts.push(`[${h.source.toUpperCase()} ${h.file}:${h.startLine}-${h.endLine}] (score=${h.score.toFixed(2)})`);
    parts.push(h.text);
    parts.push("---");
  }
  return parts.join("\n");
}
