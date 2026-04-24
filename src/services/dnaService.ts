/**
 * DNA Service — Intent → Diff pattern miner with confidence decay & cold archiving.
 *
 * Pipeline:
 *   A) MINE: after a successful build, store {intent, summary, diff, checksum}
 *   B) MATCH: incoming user message → semantic+keyword match top patterns
 *   C) DECAY: failed reuse decrements confidence; <0.3 → archive
 *   D) WEIGHT: selection score = success_rate × recency_factor × log(1+tokens_saved)
 *   E) ARCHIVE: cold patterns (no use in 30d, archived flag) gz'd to disk
 */
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
import { db } from "./stateDb.js";
import { nexusLog } from "./logService.js";

const log = nexusLog("dna");
const COLD_PATH = path.join(process.cwd(), ".nexus", "vault_cold.json.gz");
const COLD_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface DnaPattern {
  id: string;
  intent: string;
  summary: string;
  diff: string;
  uses: number;
  successes: number;
  confidence: number;
  tokens_saved: number;
  checksum: string;
  created_at: number;
  last_used: number;
  archived: number;
}

function sha(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function minePattern(input: { intent: string; summary: string; diff: string; tokensSaved?: number }) {
  const checksum = sha(input.diff);
  const id = `dna_${checksum}`;
  const d = db();
  const existing = d.prepare(`SELECT id FROM dna_patterns WHERE id=?`).get(id) as any;
  const now = Date.now();
  if (existing) {
    d.prepare(`UPDATE dna_patterns SET uses=uses+1, last_used=?, archived=0 WHERE id=?`).run(now, id);
  } else {
    d.prepare(
      `INSERT INTO dna_patterns (id, intent, summary, diff, uses, successes, confidence, tokens_saved, checksum, created_at, last_used, archived)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, input.intent.slice(0, 400), input.summary.slice(0, 2000), input.diff.slice(0, 12000), 0, 0, 0.5, input.tokensSaved || 0, checksum, now, now, 0);
    log.info(`mined pattern ${id}: "${input.intent.slice(0, 60)}"`);
  }
  return id;
}

function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface DnaMatch {
  pattern: DnaPattern;
  similarity: number;
  weighted: number;
}

/** Match user intent against active patterns. Returns ranked list. */
export function matchIntent(query: string, threshold = 0.35): DnaMatch[] {
  const qt = tokens(query);
  const rows = db().prepare(`SELECT * FROM dna_patterns WHERE archived=0 ORDER BY confidence DESC LIMIT 200`).all() as DnaPattern[];
  const now = Date.now();
  const matches: DnaMatch[] = [];
  for (const p of rows) {
    const sim = jaccard(qt, tokens(p.intent + " " + p.summary));
    if (sim < threshold) continue;
    const successRate = p.uses > 0 ? p.successes / p.uses : 0.5;
    const recencyFactor = Math.exp(-(now - p.last_used) / (14 * 24 * 60 * 60 * 1000)); // 14-day half-life
    const weighted = sim * (0.4 + 0.6 * successRate) * (0.5 + 0.5 * recencyFactor) * Math.log(1 + p.tokens_saved + 1);
    matches.push({ pattern: p, similarity: sim, weighted });
  }
  matches.sort((a, b) => b.weighted - a.weighted);
  return matches.slice(0, 5);
}

/** Verify the stored diff hasn't been tampered with. Returns true if hash matches. */
export function verifyChecksum(p: DnaPattern): boolean {
  return sha(p.diff) === p.checksum;
}

/** Record reuse outcome (Phase C: failed reuse decays confidence). */
export function recordReuseOutcome(patternId: string, success: boolean) {
  const d = db();
  const p = d.prepare(`SELECT * FROM dna_patterns WHERE id=?`).get(patternId) as DnaPattern | undefined;
  if (!p) return;
  const uses = p.uses + 1;
  const successes = p.successes + (success ? 1 : 0);
  let confidence = success ? Math.min(1, p.confidence + 0.1) : Math.max(0, p.confidence - 0.2);
  const archived = confidence < 0.3 ? 1 : 0;
  d.prepare(`UPDATE dna_patterns SET uses=?, successes=?, confidence=?, archived=?, last_used=? WHERE id=?`)
    .run(uses, successes, confidence, archived, Date.now(), patternId);
  if (archived) log.warn(`pattern ${patternId} archived (confidence=${confidence.toFixed(2)})`);
}

export function listActivePatterns(limit = 50): DnaPattern[] {
  return db().prepare(`SELECT * FROM dna_patterns WHERE archived=0 ORDER BY confidence DESC, last_used DESC LIMIT ?`).all(limit) as DnaPattern[];
}
export function listArchivedPatterns(limit = 50): DnaPattern[] {
  return db().prepare(`SELECT * FROM dna_patterns WHERE archived=1 ORDER BY last_used DESC LIMIT ?`).all(limit) as DnaPattern[];
}

/** Move stale archived patterns to disk (gzip). Idempotent. */
export async function coldArchive(): Promise<{ moved: number }> {
  const cutoff = Date.now() - COLD_AGE_MS;
  const stale = db().prepare(`SELECT * FROM dna_patterns WHERE archived=1 AND last_used < ?`).all(cutoff) as DnaPattern[];
  if (stale.length === 0) return { moved: 0 };
  let existing: DnaPattern[] = [];
  try {
    const buf = await fs.readFile(COLD_PATH);
    existing = JSON.parse(zlib.gunzipSync(buf).toString("utf-8"));
  } catch {}
  const merged = [...existing, ...stale];
  await fs.mkdir(path.dirname(COLD_PATH), { recursive: true });
  await fs.writeFile(COLD_PATH, zlib.gzipSync(Buffer.from(JSON.stringify(merged))));
  const ids = stale.map(s => s.id);
  const ph = ids.map(() => "?").join(",");
  db().prepare(`DELETE FROM dna_patterns WHERE id IN (${ph})`).run(...ids);
  log.info(`cold-archived ${stale.length} patterns to ${COLD_PATH}`);
  return { moved: stale.length };
}

export function dnaStats() {
  const r = db().prepare(`SELECT
    COUNT(*) as total,
    SUM(CASE WHEN archived=0 THEN 1 ELSE 0 END) as active,
    SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) as archived,
    AVG(confidence) as avg_confidence,
    SUM(tokens_saved) as tokens_saved
    FROM dna_patterns`).get() as any;
  return r;
}
