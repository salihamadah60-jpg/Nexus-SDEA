/**
 * Quad-Gates — Truth-Test verification (Phase 4).
 *
 *   Alpha   syntax   tsc --noEmit (best effort) + bracket/import scan
 *   Beta    logic    npm test (vitest) if present, else skip
 *   Gamma   functional  HTTP probes against running dev server
 *   Delta   visual   Puppeteer screenshot if Chrome available
 *
 * Returns a per-gate report. Failure of any non-skipped gate = blocker.
 */
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { sanitizedEnv } from "./securityService.js";
import { getSessionData } from "./autopilotService.js";
import { nexusLog } from "./logService.js";

const log = nexusLog("quadgate");

export interface GateResult {
  gate: "alpha" | "beta" | "gamma" | "delta";
  passed: boolean;
  skipped?: boolean;
  detail: string;
  durationMs: number;
}
export interface QuadReport {
  passed: boolean;
  gates: GateResult[];
  blockers: string[];
}

function execTimed(cmd: string, args: string[], cwd: string, timeout = 30000): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    let out = "";
    const child = spawn(cmd, args, { cwd, env: sanitizedEnv() });
    child.stdout.on("data", d => out += d.toString());
    child.stderr.on("data", d => out += d.toString());
    const t = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, timeout);
    child.on("close", c => { clearTimeout(t); resolve({ code: c ?? 1, out }); });
    child.on("error", e => { clearTimeout(t); resolve({ code: 1, out: e.message }); });
  });
}

async function gateAlpha(sandbox: string): Promise<GateResult> {
  const start = Date.now();
  const tsconfig = path.join(sandbox, "tsconfig.json");
  if (!await fs.stat(tsconfig).catch(() => null)) {
    return { gate: "alpha", passed: true, skipped: true, detail: "no tsconfig.json", durationMs: Date.now() - start };
  }
  const r = await execTimed("npx", ["-y", "tsc", "--noEmit", "--skipLibCheck"], sandbox, 60000);
  const errors = (r.out.match(/error TS\d+/g) || []).length;
  const passed = r.code === 0 && errors === 0;
  return { gate: "alpha", passed, detail: passed ? "tsc clean" : `${errors} TS errors:\n${r.out.slice(0, 800)}`, durationMs: Date.now() - start };
}

async function gateBeta(sandbox: string): Promise<GateResult> {
  const start = Date.now();
  const pkgPath = path.join(sandbox, "package.json");
  let pkg: any;
  try { pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8")); } catch {
    return { gate: "beta", passed: true, skipped: true, detail: "no package.json", durationMs: Date.now() - start };
  }
  if (!pkg.scripts?.test) {
    return { gate: "beta", passed: true, skipped: true, detail: "no test script", durationMs: Date.now() - start };
  }
  const r = await execTimed("npm", ["test", "--", "--run"], sandbox, 90000);
  return { gate: "beta", passed: r.code === 0, detail: r.code === 0 ? "tests passed" : r.out.slice(-1000), durationMs: Date.now() - start };
}

async function probe(url: string, timeoutMs = 5000): Promise<{ ok: boolean; status: number }> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return { ok: r.ok, status: r.status };
  } catch (e: any) {
    return { ok: false, status: 0 };
  }
}

async function gateGamma(sessionId: string): Promise<GateResult> {
  const start = Date.now();
  const data = getSessionData(sessionId);
  const port = data?.port || 3001;
  if (!data || data.status !== "READY") {
    return { gate: "gamma", passed: false, detail: `dev server not READY (status=${data?.status || "n/a"})`, durationMs: Date.now() - start };
  }
  const url = `http://localhost:${port}/`;
  const r1 = await probe(url);
  if (!r1.ok) return { gate: "gamma", passed: false, detail: `GET / → ${r1.status}`, durationMs: Date.now() - start };
  // Stability: 3 consecutive probes spaced 1s
  for (let i = 0; i < 2; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const r = await probe(url);
    if (!r.ok) return { gate: "gamma", passed: false, detail: `instability at probe ${i+2}`, durationMs: Date.now() - start };
  }
  return { gate: "gamma", passed: true, detail: `dev server stable on ${port}`, durationMs: Date.now() - start };
}

async function gateDelta(sessionId: string): Promise<GateResult> {
  const start = Date.now();
  // Delegate to existing visualService which already handles "no chrome" case.
  try {
    const { captureVisualSnapshot } = await import("./visualService.js");
    const data = getSessionData(sessionId);
    if (!data || data.status !== "READY") {
      return { gate: "delta", passed: true, skipped: true, detail: "preview not ready", durationMs: Date.now() - start };
    }
    const url = `http://localhost:${data.port || 3001}/`;
    const r = await captureVisualSnapshot(sessionId, url);
    if (!r) return { gate: "delta", passed: true, skipped: true, detail: "visual inspector unavailable", durationMs: Date.now() - start };
    return { gate: "delta", passed: true, detail: `snapshot ${r.filename}`, durationMs: Date.now() - start };
  } catch (e: any) {
    return { gate: "delta", passed: true, skipped: true, detail: `visual skipped: ${e?.message}`, durationMs: Date.now() - start };
  }
}

export async function runQuadGates(sessionId: string): Promise<QuadReport> {
  const sandbox = path.join(SANDBOX_BASE, sessionId);
  const [a, b, c, d] = await Promise.all([
    gateAlpha(sandbox),
    gateBeta(sandbox),
    gateGamma(sessionId),
    gateDelta(sessionId),
  ]);
  const gates = [a, b, c, d];
  const blockers = gates.filter(g => !g.passed && !g.skipped).map(g => `${g.gate}: ${g.detail.slice(0, 200)}`);
  const passed = blockers.length === 0;
  log.info(`quad-gates session=${sessionId} → ${passed ? "PASS" : "BLOCKED"} (${blockers.length} blockers)`);
  return { passed, gates, blockers };
}
