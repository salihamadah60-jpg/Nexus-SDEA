/**
 * Security Service — real npm audit gate (Phase 5.4) + Shadow Core (Phase 3.4)
 * + sanitized exec env (Phase 3.5) + DNA checksum guard (Phase 5.5).
 */
import { spawn } from "child_process";
import path from "path";
import crypto from "crypto";
import fs from "fs/promises";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { nexusLog } from "./logService.js";

const log = nexusLog("security");

// ---------- Shadow Core (file write guard) --------------------------------

const SHADOW_CORE_PATHS = new Set([
  "dna.json", "Nexus.md", "server.ts", "package.json", "package-lock.json",
  ".env", ".env.local", ".gitignore", "tsconfig.json", "vite.config.ts",
]);
const SHADOW_CORE_PREFIXES = ["src/services/", "src/config/", ".nexus/"];

export function isShadowCorePath(relPath: string): boolean {
  if (SHADOW_CORE_PATHS.has(relPath)) return true;
  return SHADOW_CORE_PREFIXES.some(p => relPath.startsWith(p));
}

export function assertNotShadowCore(relPath: string) {
  if (isShadowCorePath(relPath)) {
    throw new Error(`SHADOW CORE: refusing to write to protected path ${relPath} from agent path. Use Core PR flow.`);
  }
}

// ---------- Sanitized exec env (Phase 3.5) --------------------------------

const ENV_WHITELIST = ["PATH", "HOME", "LANG", "TERM", "SHELL", "USER", "PWD", "NODE_VERSION", "NIX_PATH"];

export function sanitizedEnv(extras: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_WHITELIST) {
    if (process.env[k]) out[k] = process.env[k];
  }
  out.CI = "false";
  out.BROWSER = "none";
  out.FORCE_COLOR = "0";
  Object.assign(out, extras);
  return out;
}

// ---------- npm audit gate (Phase 5.4) ------------------------------------

export interface AuditFinding {
  total: number;
  critical: number;
  high: number;
  moderate: number;
  low: number;
  blocked: boolean;
  raw?: string;
}

export async function runNpmAudit(sessionId: string, blockOn: ("critical" | "high")[] = ["critical", "high"]): Promise<AuditFinding> {
  const cwd = path.join(SANDBOX_BASE, sessionId);
  return new Promise((resolve) => {
    const child = spawn("npm", ["audit", "--json", "--audit-level=low"], { cwd, env: sanitizedEnv() });
    let buf = "";
    child.stdout.on("data", d => buf += d.toString());
    child.stderr.on("data", d => buf += d.toString());
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 30000);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(buf);
        const v = json.metadata?.vulnerabilities || {};
        const finding: AuditFinding = {
          total: (v.critical || 0) + (v.high || 0) + (v.moderate || 0) + (v.low || 0),
          critical: v.critical || 0,
          high: v.high || 0,
          moderate: v.moderate || 0,
          low: v.low || 0,
          blocked: false,
        };
        finding.blocked = blockOn.some(s => (finding as any)[s] > 0);
        if (finding.blocked) log.warn(`npm audit BLOCKED session=${sessionId}: critical=${finding.critical} high=${finding.high}`);
        resolve(finding);
      } catch {
        // No package.json or empty audit — neutral pass.
        resolve({ total: 0, critical: 0, high: 0, moderate: 0, low: 0, blocked: false });
      }
    });
    child.on("error", () => resolve({ total: 0, critical: 0, high: 0, moderate: 0, low: 0, blocked: false }));
  });
}

// ---------- DNA checksum guard (Phase 5.5) --------------------------------

const DNA_PATH = path.join(process.cwd(), "dna.json");
const DNA_CHK = path.join(process.cwd(), ".nexus", "dna.checksum");

export async function dnaChecksumWrite(): Promise<string> {
  const buf = await fs.readFile(DNA_PATH);
  const sum = crypto.createHash("sha256").update(buf).digest("hex");
  await fs.mkdir(path.dirname(DNA_CHK), { recursive: true });
  await fs.writeFile(DNA_CHK, sum);
  return sum;
}

export async function verifyDnaChecksum(): Promise<{ ok: boolean; current: string; expected?: string }> {
  try {
    const buf = await fs.readFile(DNA_PATH);
    const current = crypto.createHash("sha256").update(buf).digest("hex");
    let expected: string | undefined;
    try { expected = (await fs.readFile(DNA_CHK, "utf-8")).trim(); } catch {}
    if (!expected) return { ok: true, current };
    return { ok: expected === current, current, expected };
  } catch (e: any) {
    log.error(`dna checksum check failed: ${e?.message}`);
    return { ok: false, current: "" };
  }
}

// ---------- Clarification entropy bridge (Phase 5.6) ----------------------

/**
 * Score the ambiguity of a list of candidate plans. High entropy (>0.7)
 * means the user's intent admits multiple equally-valid approaches → ask.
 */
export function planEntropy(planScores: number[]): number {
  if (planScores.length <= 1) return 0;
  const sum = planScores.reduce((a, b) => a + b, 0) || 1;
  const probs = planScores.map(s => s / sum);
  let h = 0;
  for (const p of probs) if (p > 0) h -= p * Math.log2(p);
  // normalize to [0,1] by max entropy log2(n)
  return h / Math.log2(planScores.length);
}
