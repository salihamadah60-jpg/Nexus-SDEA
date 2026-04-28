/**
 * Phase 13.7 — Anti-Patterns Library (counterpart to Memory of Wins)
 *
 * Whenever `inspectPreviewHealth` (autopilotService) detects a compile error,
 * crash, or unhealthy body — i.e. the preview was withheld from the user
 * because the build was broken — Nexus snapshots the failing files into a
 * permanent failure library (`.nexus/antipatterns.json`).
 *
 * On every future generation request, the library is scanned for past
 * failures whose intent overlaps the current user goal, and the top matches
 * are surfaced to the model as "AVOID THESE FAILURES" — so the AI learns
 * from its own mistakes and doesn't repeat the same broken patterns.
 *
 * Symmetric to winsLibraryService.ts: writes are rare, reads happen on every
 * chat turn. Storage is a single JSON file capped at MAX_ANTIPATTERNS entries
 * (LRU by recency — recent failures are more relevant than old ones).
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const AP_PATH = path.join(process.cwd(), ".nexus", "antipatterns.json");
const MAX_ANTIPATTERNS = 30;
const MAX_FILES_PER_AP = 4;
const MAX_FILE_BYTES = 12 * 1024;
const MAX_EXCERPT_BYTES = 1200;
/** Only record files modified within this window before the failure was detected. */
const RECENT_WRITE_WINDOW_MS = 5 * 60 * 1000;

export interface AntiPatternEntry {
  id: string;
  timestamp: string;
  sessionId: string;
  intent: string;        // user goal that produced this failure (best-effort)
  reason: string;        // health-scan reason, e.g. "Module not found"
  bodyExcerpt: string;   // small slice of the failing response body for context
  tags: string[];        // tokenized intent for jaccard match
  files: Array<{
    path: string;
    excerpt: string;
    fullSize: number;
    mtimeMs: number;
  }>;
}

interface AntiPatternsFile {
  version: 1;
  entries: AntiPatternEntry[];
}

async function loadAP(): Promise<AntiPatternsFile> {
  try {
    const raw = await fs.readFile(AP_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) return parsed;
  } catch {}
  return { version: 1, entries: [] };
}

async function saveAP(data: AntiPatternsFile): Promise<void> {
  await fs.mkdir(path.dirname(AP_PATH), { recursive: true });
  await fs.writeFile(AP_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function tokenize(s: string): string[] {
  const stop = new Set([
    "the","a","an","of","to","for","with","and","or","in","on","at","by",
    "is","are","was","were","be","been","this","that","it","my","your","our",
    "make","build","create","need","want","please","can","you","i","me","also",
  ]);
  return Array.from(
    new Set(
      (s.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter(t => !stop.has(t))
    )
  );
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Walk the project sandbox and return the most-recently-modified UI/source
 * files within RECENT_WRITE_WINDOW_MS. These are the files the autopilot
 * just wrote that almost certainly caused the failure.
 */
async function findRecentlyWrittenFiles(projectDir: string, limit: number): Promise<Array<{ rel: string; mtimeMs: number; size: number }>> {
  const out: Array<{ rel: string; mtimeMs: number; size: number }> = [];
  const cutoff = Date.now() - RECENT_WRITE_WINDOW_MS;
  const skip = new Set(["node_modules", ".git", ".vite", "dist", "build", ".next", ".cache"]);
  const exts = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".json"]);

  async function walk(absDir: string, relDir: string, depth: number): Promise<void> {
    if (depth > 5) return;
    let kids: string[] = [];
    try { kids = await fs.readdir(absDir); } catch { return; }
    for (const name of kids) {
      if (skip.has(name) || name.startsWith(".")) continue;
      const abs = path.join(absDir, name);
      const rel = relDir ? path.join(relDir, name) : name;
      let st;
      try { st = await fs.stat(abs); } catch { continue; }
      if (st.isDirectory()) {
        await walk(abs, rel, depth + 1);
      } else if (st.isFile() && exts.has(path.extname(name).toLowerCase())) {
        if (st.mtimeMs >= cutoff && st.size <= MAX_FILE_BYTES) {
          out.push({ rel, mtimeMs: st.mtimeMs, size: st.size });
        }
      }
    }
  }

  await walk(projectDir, "", 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

/**
 * Record a failed build / unhealthy preview. Called by the autopilot's
 * health-scan branch when the preview is withheld from the user.
 */
export async function recordAntiPattern(args: {
  sessionId: string;
  projectDir: string;
  reason: string;
  intent: string;
  bodyExcerpt?: string;
}): Promise<AntiPatternEntry | null> {
  const recents = await findRecentlyWrittenFiles(args.projectDir, MAX_FILES_PER_AP);
  if (recents.length === 0) return null;

  const filesOut: AntiPatternEntry["files"] = [];
  for (const r of recents) {
    try {
      const abs = path.join(args.projectDir, r.rel);
      const content = await fs.readFile(abs, "utf-8");
      filesOut.push({
        path: r.rel,
        excerpt: content.slice(0, MAX_EXCERPT_BYTES),
        fullSize: r.size,
        mtimeMs: r.mtimeMs,
      });
    } catch {}
  }
  if (filesOut.length === 0) return null;

  const entry: AntiPatternEntry = {
    id: crypto.randomBytes(6).toString("hex"),
    timestamp: new Date().toISOString(),
    sessionId: args.sessionId,
    intent: args.intent.slice(0, 280),
    reason: args.reason.slice(0, 200),
    bodyExcerpt: (args.bodyExcerpt || "").slice(0, 600),
    tags: tokenize(args.intent),
    files: filesOut,
  };

  const data = await loadAP();
  data.entries.unshift(entry);
  if (data.entries.length > MAX_ANTIPATTERNS) {
    data.entries = data.entries.slice(0, MAX_ANTIPATTERNS);
  }
  await saveAP(data);
  return entry;
}

/** Find past anti-patterns whose intent overlaps the current user goal. */
export async function lookupRelevantAntiPatterns(userGoal: string, k = 2): Promise<AntiPatternEntry[]> {
  const data = await loadAP();
  if (data.entries.length === 0) return [];
  const query = tokenize(userGoal);
  if (query.length === 0) return [];

  const scored = data.entries.map(e => ({
    entry: e,
    rel: jaccard(query, e.tags),
  }));
  scored.sort((a, b) => b.rel - a.rel);
  return scored.filter(s => s.rel > 0.05).slice(0, k).map(s => s.entry);
}

/** Render the anti-patterns block that gets appended to the writer's system prompt. */
export function formatAntiPatternsForPrompt(entries: AntiPatternEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = [
    "━━━ AVOID THESE FAILURES — YOUR PAST MISTAKES ━━━",
    "These code patterns YOU produced previously caused the dev server to fail or refuse to open the preview.",
    "Read the failure reason and the file excerpts carefully. Do NOT repeat the same import paths,",
    "API calls, syntax shapes, or dependency assumptions. If you must touch the same area, make the",
    "imports/exports/types correct this time.",
    "",
  ];
  entries.forEach((e, i) => {
    lines.push(`──── ANTI-PATTERN #${i + 1} ────`);
    lines.push(`Failure reason: ${e.reason}`);
    lines.push(`Original intent: ${e.intent}`);
    if (e.bodyExcerpt) {
      lines.push(`Error excerpt: ${e.bodyExcerpt.slice(0, 280)}`);
    }
    lines.push(`Files that broke (${e.files.length}):`);
    for (const f of e.files) {
      lines.push(`  • ${f.path} (${f.fullSize} bytes)`);
    }
    if (e.files[0]) {
      lines.push(`First-file excerpt (${e.files[0].path}) — DO NOT regress to this:`);
      lines.push("```");
      lines.push(e.files[0].excerpt);
      lines.push("```");
    }
    lines.push("");
  });
  return lines.join("\n");
}

/** Public for the UI panel: list all anti-patterns newest-first. */
export async function listAntiPatterns(): Promise<AntiPatternEntry[]> {
  const data = await loadAP();
  return data.entries;
}

/** Delete an anti-pattern by id (UI prune). */
export async function deleteAntiPattern(id: string): Promise<boolean> {
  const data = await loadAP();
  const before = data.entries.length;
  data.entries = data.entries.filter(e => e.id !== id);
  if (data.entries.length === before) return false;
  await saveAP(data);
  return true;
}
