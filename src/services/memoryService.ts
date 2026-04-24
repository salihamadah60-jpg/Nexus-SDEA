/**
 * Nexus Memory Hygiene — bounded, compactable conversation memory.
 *
 * Why: long sessions blow past every model's context window. When the raw
 * history is shoved in, models start hallucinating "I already wrote that file"
 * for files that no longer exist, or contradicting earlier decisions.
 *
 * Strategy:
 *   - Keep the LAST `keepRecent` turns verbatim.
 *   - Compact older turns into a structured summary line per turn:
 *       [user → built X with files A, B; npm install ok; preview READY]
 *   - Track facts (files written, packages installed, ports in use) as a
 *     stable side-table that the prompt builder injects separately.
 */

export interface MemoryTurn {
  role: "user" | "assistant";
  content: string;
  ts?: number;
}

export interface SessionFacts {
  filesWritten: Set<string>;
  packagesInstalled: Set<string>;
  portsUsed: Set<number>;
  lastBuildSummary?: string;
  decisions: string[];   // short bullet log of architectural decisions
}

const SESSION_FACTS = new Map<string, SessionFacts>();

export function getFacts(sessionId: string): SessionFacts {
  let f = SESSION_FACTS.get(sessionId);
  if (!f) {
    f = { filesWritten: new Set(), packagesInstalled: new Set(), portsUsed: new Set(), decisions: [] };
    SESSION_FACTS.set(sessionId, f);
  }
  return f;
}

export function recordFiles(sessionId: string, files: string[]) {
  const f = getFacts(sessionId);
  for (const p of files) f.filesWritten.add(p);
}

export function recordPackages(sessionId: string, pkgs: string[]) {
  const f = getFacts(sessionId);
  for (const p of pkgs) f.packagesInstalled.add(p);
}

export function recordPort(sessionId: string, port: number) {
  getFacts(sessionId).portsUsed.add(port);
}

export function recordDecision(sessionId: string, decision: string) {
  const f = getFacts(sessionId);
  f.decisions.push(`${new Date().toISOString().slice(11, 19)} ${decision}`);
  if (f.decisions.length > 30) f.decisions.splice(0, f.decisions.length - 30);
}

/**
 * Compact a long history into a slim list ready for the LLM:
 *   - tail of `keepRecent` turns kept as-is
 *   - everything older summarized into a single synthetic system turn
 */
export function compactHistory(history: MemoryTurn[], keepRecent = 8): MemoryTurn[] {
  if (history.length <= keepRecent) return history;
  const old = history.slice(0, history.length - keepRecent);
  const recent = history.slice(history.length - keepRecent);

  const summaryLines: string[] = [];
  for (const t of old) {
    const text = (t.content || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length <= 140) {
      summaryLines.push(`${t.role === "user" ? "U" : "A"}: ${text}`);
    } else {
      summaryLines.push(`${t.role === "user" ? "U" : "A"}: ${text.slice(0, 137)}…`);
    }
  }
  const summary: MemoryTurn = {
    role: "assistant",
    content: `[MEMORY DIGEST — ${old.length} earlier turns compacted]\n${summaryLines.join("\n")}`,
    ts: Date.now(),
  };
  return [summary, ...recent];
}

/** Render facts as a compact string for prompt injection. */
export function renderFacts(sessionId: string): string {
  const f = getFacts(sessionId);
  const parts: string[] = [];
  if (f.filesWritten.size) parts.push(`FILES_WRITTEN(${f.filesWritten.size}): ${Array.from(f.filesWritten).slice(-20).join(", ")}`);
  if (f.packagesInstalled.size) parts.push(`PACKAGES: ${Array.from(f.packagesInstalled).slice(-15).join(", ")}`);
  if (f.portsUsed.size) parts.push(`PORTS_USED: ${Array.from(f.portsUsed).join(", ")}`);
  if (f.decisions.length) parts.push(`RECENT_DECISIONS:\n  - ${f.decisions.slice(-10).join("\n  - ")}`);
  return parts.length ? `\n━━━ SESSION FACTS (authoritative — trust over memory) ━━━\n${parts.join("\n")}\n` : "";
}

/** Detect probable hallucination: response references files the system has never written. */
export function detectHallucinatedFiles(sessionId: string, mentionedFiles: string[]): string[] {
  const f = getFacts(sessionId);
  return mentionedFiles.filter(p => !f.filesWritten.has(p));
}

/** Memory health snapshot for /api/kernel/memory. */
export function memorySnapshot() {
  const out: Record<string, any> = {};
  for (const [sid, f] of SESSION_FACTS.entries()) {
    out[sid] = {
      files: f.filesWritten.size,
      packages: f.packagesInstalled.size,
      ports: Array.from(f.portsUsed),
      decisions: f.decisions.length,
      lastBuildSummary: f.lastBuildSummary,
    };
  }
  return out;
}

/** Drop a session's facts (e.g. on session delete). */
export function clearSessionMemory(sessionId: string) {
  SESSION_FACTS.delete(sessionId);
}
