/**
 * Phase 13.6 — Memory of Wins (Design Library)
 *
 * Whenever the Visual Auditor scores a rendered design ≥ WIN_THRESHOLD,
 * Nexus snapshots the winning UI files into a permanent design library
 * (`.nexus/wins.json`). On every future generation request, the library is
 * scanned for past wins whose intent overlaps the current user goal, and
 * the top matches are surfaced to the model as "PROVEN PATTERNS" — so the
 * AI can copy structure, depth, and copy quality from its own best work
 * instead of starting from a blank canvas every prompt.
 *
 * This is a write-rare / read-often service: writes happen ~once per
 * successful boot, reads happen on every chat turn. Storage is a single
 * JSON file capped at MAX_WINS entries (LRU by score+recency).
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const WINS_PATH = path.join(process.cwd(), ".nexus", "wins.json");
const WIN_THRESHOLD = 85;
const MAX_WINS = 30;
const MAX_FILES_PER_WIN = 6;
const MAX_FILE_BYTES = 12 * 1024;
const MAX_EXCERPT_BYTES = 1500;

export interface WinEntry {
  id: string;
  score: number;
  timestamp: string;
  sessionId: string;
  intent: string;       // user goal that produced this win (best-effort)
  summary: string;      // short verdict summary from the auditor
  tags: string[];       // tokenized intent for jaccard match
  files: Array<{
    path: string;
    excerpt: string;    // first MAX_EXCERPT_BYTES chars
    fullSize: number;   // original byte size for reference
  }>;
}

interface WinsFile {
  version: 1;
  wins: WinEntry[];
}

async function loadWins(): Promise<WinsFile> {
  try {
    const raw = await fs.readFile(WINS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.wins)) return parsed;
  } catch {}
  return { version: 1, wins: [] };
}

async function saveWins(data: WinsFile): Promise<void> {
  await fs.mkdir(path.dirname(WINS_PATH), { recursive: true });
  await fs.writeFile(WINS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/** Tokenize an intent string for cheap jaccard comparison. */
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
 * Record a winning design. Called by the autopilot's visual self-improvement
 * loop when the Visual Auditor returns a verdict with score ≥ WIN_THRESHOLD.
 *
 * `projectDir` is the sandbox root; we re-read up to MAX_FILES_PER_WIN UI
 * files from disk so we capture the EXACT bytes the auditor saw, not the
 * pre-revision draft.
 */
export async function recordWin(args: {
  sessionId: string;
  projectDir: string;
  score: number;
  summary: string;
  intent: string;
  filePaths: string[];     // candidate sandbox-relative paths
}): Promise<WinEntry | null> {
  if (args.score < WIN_THRESHOLD) return null;

  const filesOut: WinEntry["files"] = [];
  for (const rel of args.filePaths.slice(0, MAX_FILES_PER_WIN)) {
    try {
      const abs = path.join(args.projectDir, rel);
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(abs, "utf-8");
      filesOut.push({
        path: rel,
        excerpt: content.slice(0, MAX_EXCERPT_BYTES),
        fullSize: stat.size,
      });
    } catch {}
  }
  if (filesOut.length === 0) return null;

  const entry: WinEntry = {
    id: crypto.randomBytes(6).toString("hex"),
    score: args.score,
    timestamp: new Date().toISOString(),
    sessionId: args.sessionId,
    intent: args.intent.slice(0, 280),
    summary: args.summary.slice(0, 280),
    tags: tokenize(args.intent),
    files: filesOut,
  };

  const data = await loadWins();
  data.wins.unshift(entry);

  // Trim with weighted ranking: score (0..100) + recency bonus.
  // Newest entries already sit at the top thanks to unshift; we cap at MAX_WINS
  // by keeping the strongest scores when the pool overflows.
  if (data.wins.length > MAX_WINS) {
    data.wins.sort((a, b) => {
      const ra = new Date(a.timestamp).getTime();
      const rb = new Date(b.timestamp).getTime();
      return (b.score + rb / 1e13) - (a.score + ra / 1e13);
    });
    data.wins = data.wins.slice(0, MAX_WINS);
  }

  await saveWins(data);
  return entry;
}

/** Find past wins whose intent overlaps the current user goal. */
export async function lookupRelevantWins(userGoal: string, k = 3): Promise<WinEntry[]> {
  const data = await loadWins();
  if (data.wins.length === 0) return [];
  const query = tokenize(userGoal);
  if (query.length === 0) return [];

  const scored = data.wins.map(w => ({
    win: w,
    rel: jaccard(query, w.tags) * (w.score / 100),
  }));
  scored.sort((a, b) => b.rel - a.rel);
  return scored.filter(s => s.rel > 0.05).slice(0, k).map(s => s.win);
}

/** Render the wins block that gets appended to the writer's system prompt. */
export function formatWinsForPrompt(wins: WinEntry[]): string {
  if (wins.length === 0) return "";
  const lines: string[] = [
    "━━━ PROVEN PATTERNS — YOUR PAST WINS ━━━",
    "These designs YOU produced earned a Visual Auditor score of " +
      `${WIN_THRESHOLD}+/100. Treat them as a quality reference: copy the structural depth,`,
    "section composition, and visual richness — DO NOT regress below this bar.",
    "Adapt the patterns to the current intent; don't paste blindly.",
    "",
  ];
  wins.forEach((w, i) => {
    lines.push(`──── WIN #${i + 1} (score ${w.score}/100) ────`);
    lines.push(`Intent: ${w.intent}`);
    lines.push(`Summary: ${w.summary}`);
    lines.push(`Files (${w.files.length}):`);
    for (const f of w.files) {
      lines.push(`  • ${f.path} (${f.fullSize} bytes)`);
    }
    // Inline only the first file's excerpt — keeps prompt size sane.
    if (w.files[0]) {
      lines.push(`First-file excerpt (${w.files[0].path}):`);
      lines.push("```");
      lines.push(w.files[0].excerpt);
      lines.push("```");
    }
    lines.push("");
  });
  return lines.join("\n");
}

/** Public for the UI panel: list all wins newest-first. */
export async function listWins(): Promise<WinEntry[]> {
  const data = await loadWins();
  return data.wins;
}

/** Delete a win by id (UI prune). */
export async function deleteWin(id: string): Promise<boolean> {
  const data = await loadWins();
  const before = data.wins.length;
  data.wins = data.wins.filter(w => w.id !== id);
  if (data.wins.length === before) return false;
  await saveWins(data);
  return true;
}

export const WINS_THRESHOLD = WIN_THRESHOLD;
