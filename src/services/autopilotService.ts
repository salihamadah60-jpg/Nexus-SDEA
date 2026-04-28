import chokidar from "chokidar";
import path from "path";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { spawn, ChildProcess } from "child_process";
import fs from "fs/promises";
import { existsSync } from "fs";
import http from "http";
import { acquirePort, isPortFree, findPidsOnPort, killPid } from "./portService.js";
import { captureVisualSnapshot } from "./visualService.js";
import { db } from "./stateDb.js";
import { requestAIFileFix } from "./orchestratorService.js";

/** Probe a URL repeatedly until it returns HTTP 2xx/3xx, or attempts run out. */
async function verifyPreviewReady(url: string, attempts: number, intervalMs: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const ok = await new Promise<boolean>(resolve => {
      try {
        const req = http.get(url, { timeout: 1500 }, res => {
          const good = !!res.statusCode && res.statusCode < 500;
          res.resume();
          resolve(good);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
      } catch { resolve(false); }
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Phase 13.7 — Health-scan the served HTML/JS body for compile errors BEFORE
 * the preview is opened to the user. The HTTP probe only confirms a process is
 * listening — it cannot tell you the dev server is serving an error overlay
 * (Vite serves a 200 with the error inlined). This catches that case.
 *
 * Returns {ok: true} if no error markers are detected, {ok: false, reason}
 * with a human-readable explanation otherwise.
 */
async function inspectPreviewHealth(url: string): Promise<{ ok: boolean; reason?: string }> {
  return new Promise(resolve => {
    try {
      const req = http.get(url, { timeout: 4000 }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          // Cap at 256 KB — we only need the head to find error markers
          if (body.length > 256 * 1024) {
            req.destroy();
            resolve(scanBodyForErrors(body));
          }
        });
        res.on('end', () => resolve(scanBodyForErrors(body)));
      });
      req.on('error', (e) => resolve({ ok: false, reason: `Request error: ${e.message}` }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'Body fetch timed out' }); });
    } catch (e: any) {
      resolve({ ok: false, reason: e?.message || 'unknown error' });
    }
  });
}

function scanBodyForErrors(body: string): { ok: boolean; reason?: string } {
  const markers: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /vite-error-overlay/i,                 label: 'Vite error overlay detected' },
    { pattern: /\[vite\]\s+(?:Internal|Pre-transform)\s+error/i, label: 'Vite reported an internal error' },
    { pattern: /Failed to compile/i,                  label: 'Compilation failed' },
    { pattern: /SyntaxError:/,                        label: 'Syntax error in source' },
    { pattern: /Cannot find module/i,                 label: 'Missing module import' },
    { pattern: /Module not found/i,                   label: 'Module not found' },
    { pattern: /ReferenceError:/,                     label: 'Reference error in source' },
    { pattern: /\bECONNREFUSED\b/,                    label: 'Connection refused by upstream' },
  ];
  for (const m of markers) {
    if (m.pattern.test(body)) return { ok: false, reason: m.label };
  }
  // A truly empty body from a dev server usually means the bundler crashed silently
  if (body.trim().length === 0) return { ok: false, reason: 'Empty response body' };
  return { ok: true };
}

export type SessionStatus = "IDLE" | "INSTALLING" | "STARTING" | "READY" | "ERROR";

interface SessionProcess {
  devProcess: ChildProcess | null;
  status: SessionStatus;
  port: number;
  projectDir: string;
  installAttempts: number;
  startAttempts: number;
  // Loop Guard (Phase 12.5): captures the dev process's recent stderr so
  // we can compute a "failure signature" on close. If two consecutive
  // start attempts crash with the SAME signature, the autopilot aborts
  // immediately instead of burning the full MAX_ATTEMPTS on the same bug.
  recentStderr: string;
  lastFailureSig: string | null;
  // Phase 13.4 — Visual self-improvement loop. Counts how many times the
  // Visual Auditor scored < threshold and we re-asked the writer to revise
  // the UI. Capped at MAX_VISUAL_REVISIONS to prevent ping-ponging.
  visualRevisionAttempts: number;
  bestVisualScore: number;
}

const activeProcesses = new Map<string, SessionProcess>();
const START_PORT = 3001;
const MAX_ATTEMPTS = 3;
// Phase 13.4 — Visual Self-Improvement Loop tuning
const VISUAL_REVISION_THRESHOLD = 75;   // verdict score below this triggers a revision
const MAX_VISUAL_REVISIONS = 2;          // hard cap on auto-revision passes per boot

/** Phase 12.5 — Get session IDs that actually exist in SQLite. */
function getLiveSessions(): Set<string> {
  try {
    const rows = db().prepare("SELECT id FROM sessions").all() as { id: string }[];
    return new Set(rows.map(r => r.id));
  } catch {
    return new Set();
  }
}

/** Phase 12.5 — Purge sandbox dirs that have no matching session in SQLite. */
export async function garbageCollectSandboxes(): Promise<string[]> {
  const liveSessions = getLiveSessions();
  const purged: string[] = [];
  try {
    const dirs = await fs.readdir(SANDBOX_BASE);
    for (const dir of dirs) {
      if (!liveSessions.has(dir)) {
        // Kill any running process for orphan session
        const state = activeProcesses.get(dir);
        if (state?.devProcess) {
          state.devProcess.kill("SIGTERM");
        }
        activeProcesses.delete(dir);
        purged.push(dir);
        console.log(`[AUTOPILOT][GC] Skipping orphan sandbox dir: ${dir} (no matching session in DB)`);
      }
    }
  } catch {}
  return purged;
}

async function findProjectRoot(baseDir: string): Promise<string | null> {
  if (existsSync(path.join(baseDir, "package.json"))) return baseDir;
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const subDir = path.join(baseDir, entry.name);
        if (existsSync(path.join(subDir, "package.json"))) return subDir;
      }
    }
  } catch {}
  return null;
}

function getDevCommand(pkg: any, port: number): { cmd: string; args: string[] } {
  if (pkg.scripts?.dev) {
    return { cmd: "npm", args: ["run", "dev", "--", "--port", port.toString(), "--host", "0.0.0.0"] };
  }
  if (pkg.scripts?.start) {
    return { cmd: "npm", args: ["start"] };
  }
  return { cmd: "npx", args: ["http-server", "-p", port.toString(), "--cors", "-c-1"] };
}

function applyInstallFix(attempt: number, errorOutput: string): string[] {
  if (attempt === 1 || errorOutput.includes("ERESOLVE") || errorOutput.includes("peer dep")) {
    return ["install", "--legacy-peer-deps"];
  }
  if (attempt === 2 || errorOutput.includes("ENOTFOUND") || errorOutput.includes("network")) {
    return ["install", "--prefer-offline", "--legacy-peer-deps"];
  }
  return ["install", "--legacy-peer-deps", "--force"];
}

/**
 * Vite frequently fails with "Failed to resolve entry for package react-dom" when
 * an earlier broken install left a partial node_modules. Detect that pattern and
 * nuke node_modules + lockfile so the next attempt is a true clean install.
 */
async function nukeBrokenNodeModules(projectDir: string, reason: string): Promise<void> {
  try {
    await fs.rm(path.join(projectDir, "node_modules"), { recursive: true, force: true });
    await fs.rm(path.join(projectDir, "package-lock.json"), { force: true });
    console.log(`[AUTOPILOT] Cleared node_modules in ${path.basename(projectDir)} (${reason})`);
  } catch {}
}

/** Kill any lingering sandbox dev-server processes from a previous run.
 * Scans ports 3001–3030; skips the reserved main-server port (5000). */
async function sweepStaleSandboxPorts(): Promise<void> {
  const RESERVED = new Set([5000]);
  const sweepRange = Array.from({ length: 30 }, (_, i) => 3001 + i);
  const kills: Promise<void>[] = [];
  for (const port of sweepRange) {
    if (RESERVED.has(port)) continue;
    kills.push(
      findPidsOnPort(port).then(async (pids) => {
        for (const pid of pids) {
          if (pid === process.pid) continue; // never self-kill
          try { await killPid(pid); } catch {}
        }
      }).catch(() => {})
    );
  }
  await Promise.allSettled(kills);
  // Brief pause so the OS releases the sockets
  await new Promise(r => setTimeout(r, 400));
}

/**
 * Strip invalid // comments from CSS. Called when Tailwind v4 Vite plugin throws
 * "Invalid declaration" because the AI wrote // comments inside a .css file.
 */
function sanitizeCssContent(css: string): string {
  return css.split('\n').reduce<string[]>((acc, line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) return acc; // drop pure // comment lines
    if (trimmed.includes('//') && trimmed.includes('@import')) {
      // e.g. "// TailwindCSS import @import \"tailwindcss\"" → "@import \"tailwindcss\""
      acc.push(trimmed.slice(trimmed.indexOf('@import')));
      return acc;
    }
    acc.push(line);
    return acc;
  }, []).join('\n');
}

// Track in-flight AI fix attempts to prevent hammering the API on repeated errors
const _aiFixInFlight = new Set<string>();

/**
 * Autopilot Error Recovery: detect Vite "Pre-transform error" / "Invalid declaration"
 * in stderr, parse the offending file path, then:
 *   1. Try a fast pattern-based fix (CSS // comments)
 *   2. Fall back to an AI-powered fix via requestAIFileFix()
 * Vite's HMR picks up the rewritten file automatically — no restart needed.
 */
async function autoFixVitePreTransformError(
  errorOutput: string,
  projectDir: string,
  sessionId: string,
  broadcast: (data: string, sid?: string, tid?: string, channel?: any) => void
): Promise<void> {
  // Dedupe: ignore if we already ran a fix in the last 5 seconds for this session+file
  const fileMatch = errorOutput.match(/File:\s*([^\n\r]+)/);
  if (!fileMatch) return;

  const offendingPath = fileMatch[1].trim();
  const dedupeKey = `vtfix:${sessionId}:${offendingPath}`;
  const lastFix = (autoFixVitePreTransformError as any)._lastFix ?? {};
  const now = Date.now();
  if (lastFix[dedupeKey] && now - lastFix[dedupeKey] < 5000) return;
  lastFix[dedupeKey] = now;
  (autoFixVitePreTransformError as any)._lastFix = lastFix;

  broadcast(`\x1b[35m[AUTOPILOT] Pre-transform error in ${path.basename(offendingPath)} — running self-healing...\x1b[0m\r\n`, sessionId, undefined, "journal");

  let original: string;
  try {
    original = await fs.readFile(offendingPath, 'utf-8');
  } catch (err: any) {
    broadcast(`\x1b[31m[AUTOPILOT] Cannot read ${path.basename(offendingPath)}: ${err.message}\x1b[0m\r\n`, sessionId, undefined, "journal");
    return;
  }

  // ── Pass 1: Pattern-based fix (instant, no AI call) ──────────────────────
  if (offendingPath.endsWith('.css')) {
    const patternFixed = sanitizeCssContent(original);
    if (patternFixed !== original) {
      await fs.writeFile(offendingPath, patternFixed, 'utf-8');
      broadcast(`\x1b[32m[AUTOPILOT] Pattern-fix applied to ${path.basename(offendingPath)} (removed invalid // comments) — Vite HMR reloading.\x1b[0m\r\n`, sessionId, undefined, "journal");
      return;
    }
  }

  // ── Pass 2: AI-powered fix for any remaining error types ─────────────────
  if (_aiFixInFlight.has(dedupeKey)) return;
  _aiFixInFlight.add(dedupeKey);

  broadcast(`\x1b[35m[AUTOPILOT] Pattern-fix insufficient — invoking AI self-healer for ${path.basename(offendingPath)}...\x1b[0m\r\n`, sessionId, undefined, "journal");

  try {
    const relativePath = path.relative(projectDir, offendingPath);
    const aiFixed = await requestAIFileFix(relativePath, original, errorOutput, sessionId);

    if (!aiFixed) {
      broadcast(`\x1b[33m[AUTOPILOT] AI self-healer: no fix generated (AI busy or key exhausted). Check terminal for details.\x1b[0m\r\n`, sessionId, undefined, "journal");
      return;
    }

    await fs.writeFile(offendingPath, aiFixed, 'utf-8');
    broadcast(`\x1b[32m[AUTOPILOT] AI self-healer fixed ${path.basename(offendingPath)} — Vite HMR reloading.\x1b[0m\r\n`, sessionId, undefined, "journal");
  } catch (err: any) {
    broadcast(`\x1b[31m[AUTOPILOT] AI self-healer error for ${path.basename(offendingPath)}: ${err.message}\x1b[0m\r\n`, sessionId, undefined, "journal");
  } finally {
    _aiFixInFlight.delete(dedupeKey);
  }
}

export async function setupAutopilot(broadcast: (data: string, sid?: string, tid?: string, channel?: any) => void) {
  activeProcesses.clear();
  console.log("🚀 [AUTOPILOT] Initializing Sovereign Autopilot Protocol [v7.5]...");

  // Kill stale dev-server processes from the previous run so port 3001 is clean.
  await sweepStaleSandboxPorts();

  // Phase 12.5 — Only restore sessions that exist in SQLite
  const liveSessions = getLiveSessions();
  const hasLiveSessionsInDb = liveSessions.size > 0;

  try {
    await fs.mkdir(SANDBOX_BASE, { recursive: true });
    const sessions = await fs.readdir(SANDBOX_BASE);
    for (const sid of sessions) {
      // Phase 12.5 — skip orphan sandbox dirs (no matching DB row)
      if (hasLiveSessionsInDb && !liveSessions.has(sid)) {
        console.log(`[AUTOPILOT][GC] Skipping orphan sandbox: ${sid.slice(-8)} (not in DB)`);
        continue;
      }
      const sessionDir = path.join(SANDBOX_BASE, sid);
      try {
        const stat = await fs.stat(sessionDir);
        if (!stat.isDirectory()) continue;
      } catch { continue; }
      const projectDir = await findProjectRoot(sessionDir);
      if (projectDir) {
        console.log(`[AUTOPILOT] Proactive Restore: Booting Session ${sid.slice(-8)}...`);
        await startDevServer(sid, projectDir, broadcast);
      }
    }
  } catch (err: any) {
    console.error("[AUTOPILOT] Initial scan failed:", err.message);
  }

  const watcher = chokidar.watch(SANDBOX_BASE, {
    ignored: /(node_modules|\.git|\.nexus)[\/\\]/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    depth: 4,
  });

  watcher.on("all", async (event, filePath) => {
    try {
      const relativePath = path.relative(SANDBOX_BASE, filePath);
      const parts = relativePath.split(path.sep);
      const sessionId = parts[0];
      if (!sessionId || parts.length < 2) return;

      const fileName = path.basename(filePath);
      const sessionDir = path.join(SANDBOX_BASE, sessionId);

      if (fileName === "package.json" && event === "add") {
        const projectDir = await findProjectRoot(sessionDir);
        if (projectDir) await triggerInstallAndRun(sessionId, projectDir, broadcast);
      } else if (event === "add" || event === "change") {
        const projectDir = await findProjectRoot(sessionDir);
        if (projectDir) await ensureDevServer(sessionId, projectDir, broadcast);
      }
    } catch (err: any) {
      console.warn(`[AUTOPILOT] Watcher handler error (non-fatal): ${err?.message || err}`);
    }
  });
}

async function getPreferredPort(projectDir: string): Promise<number> {
  try {
    const pkgPath = path.join(projectDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
      const devScript = pkg.scripts?.dev || "";
      const portMatch = devScript.match(/--port\s+(\d+)/);
      if (portMatch) return parseInt(portMatch[1], 10);
    }
  } catch {}
  return START_PORT;
}

async function triggerInstallAndRun(
  sessionId: string,
  projectDir: string,
  broadcast: (data: string, sid?: string, tid?: string, channel?: any) => void
) {
  let sessionState = activeProcesses.get(sessionId);
  if (!sessionState) {
    const preferred = await getPreferredPort(projectDir);
    const { port } = await acquirePort({ preferred, killOccupant: true });
    sessionState = { devProcess: null, status: "IDLE", port, projectDir, installAttempts: 0, startAttempts: 0, recentStderr: "", lastFailureSig: null, visualRevisionAttempts: 0, bestVisualScore: 0 };
    activeProcesses.set(sessionId, sessionState);
  }

  if (sessionState.status === "INSTALLING") return;
  if (sessionState.devProcess) {
    sessionState.devProcess.kill("SIGTERM");
    sessionState.devProcess = null;
  }

  sessionState.status = "INSTALLING";
  sessionState.installAttempts = 0;

  await ensureWorkflowFile(projectDir);
  await runInstallWithRetry(sessionId, projectDir, broadcast);
}

async function ensureWorkflowFile(projectDir: string) {
  const wfDir = path.join(projectDir, ".nexus");
  const wfPath = path.join(wfDir, "workflow.json");
  if (existsSync(wfPath)) return;
  try {
    await fs.mkdir(wfDir, { recursive: true });
    let pkg: any = {};
    try { pkg = JSON.parse(await fs.readFile(path.join(projectDir, "package.json"), "utf-8")); } catch {}
    const wf = {
      version: "1.0",
      protocol: "EXECUTE_WORKFLOW",
      created: new Date().toISOString(),
      install: pkg.scripts?.install || "npm install",
      run: pkg.scripts?.dev ? "npm run dev" : (pkg.scripts?.start ? "npm start" : "npx http-server -p {PORT} --cors"),
      port_strategy: "intelligent",
      preferred_port: 3001,
      auto_open_preview: true
    };
    await fs.writeFile(wfPath, JSON.stringify(wf, null, 2));
  } catch {}
}

async function runInstallWithRetry(
  sessionId: string,
  projectDir: string,
  broadcast: (data: string, sid?: string, tid?: string, channel?: any) => void
) {
  const sessionState = activeProcesses.get(sessionId)!;
  const attempt = sessionState.installAttempts;

  if (attempt >= MAX_ATTEMPTS) {
    sessionState.status = "ERROR";
    broadcast(`\x1b[31m[AUTOPILOT] npm install failed after ${MAX_ATTEMPTS} attempts. Manual intervention required.\x1b[0m\r\n`, sessionId, undefined, "journal");
    return;
  }

  const args = attempt === 0 ? ["install"] : applyInstallFix(attempt, "");
  if (attempt > 0) await nukeBrokenNodeModules(projectDir, `retry #${attempt}`);
  broadcast(`\x1b[36m[AUTOPILOT] ${attempt > 0 ? `Retry ${attempt}: ` : ''}Running npm ${args.join(' ')}...\x1b[0m\r\n`, sessionId, undefined, "journal");

  try {
    let errorOutput = '';
    // Fix 4 (EAGAIN): removed shell:true — spawning npm directly avoids the extra
    // intermediate shell process that doubles process count and triggers EAGAIN.
    const install = spawn("npm", args, {
      cwd: projectDir,
      env: { ...process.env, CI: "false" }
    });

    install.stdout?.on("data", (data) => broadcast(`\x1b[90m${data}\x1b[0m`, sessionId, undefined, "journal"));
    install.stderr?.on("data", (data) => {
      const txt = data.toString();
      errorOutput += txt;
      broadcast(`\x1b[33m${txt}\x1b[0m`, sessionId, undefined, "journal");
    });

    install.on("close", async (code) => {
      if (code === 0) {
        sessionState.status = "IDLE";
        broadcast(`\x1b[32m[AUTOPILOT] Dependencies installed. Booting dev server...\x1b[0m\r\n`, sessionId, undefined, "journal");
        await startDevServer(sessionId, projectDir, broadcast);
      } else {
        sessionState.installAttempts++;
        broadcast(`\x1b[33m[AUTOPILOT] Install attempt ${attempt + 1} failed (code ${code}). Applying fix...\x1b[0m\r\n`, sessionId, undefined, "journal");
        await runInstallWithRetry(sessionId, projectDir, broadcast);
      }
    });

    install.on("error", (err: any) => {
      // EAGAIN and other spawn errors
      if (err.code === 'EAGAIN' || err.code === 'ENOMEM') {
        broadcast(`\x1b[31m[AUTOPILOT] System resource limit hit (${err.code}) — waiting 5s before retry...\x1b[0m\r\n`, sessionId, undefined, "journal");
        setTimeout(() => {
          sessionState.installAttempts++;
          runInstallWithRetry(sessionId, projectDir, broadcast);
        }, 5000);
      } else {
        sessionState.status = "ERROR";
        broadcast(`\x1b[31m[AUTOPILOT] Install spawn error: ${err.message}\x1b[0m\r\n`, sessionId, undefined, "journal");
      }
    });
  } catch (error: any) {
    sessionState.status = "ERROR";
    broadcast(`\x1b[31m[AUTOPILOT] Install spawn failed: ${error.message}\x1b[0m\r\n`, sessionId, undefined, "journal");
  }
}

async function ensureDevServer(
  sessionId: string,
  projectDir: string,
  broadcast: (data: string, sid?: string, tid?: string, channel?: any) => void
) {
  const sessionState = activeProcesses.get(sessionId);
  // Don't start a second server if one is already starting/running/errored out.
  // ERROR state is intentionally left alone — only explicit triggerSessionBoot or
  // a fresh file-add after GC should restart after total failure.
  if (!sessionState) {
    await startDevServer(sessionId, projectDir, broadcast);
    return;
  }
  if (sessionState.status === "STARTING" || sessionState.status === "INSTALLING") return;
  if (sessionState.status === "ERROR") return; // silent — don't spam error broadcasts
  if (sessionState.devProcess) return;         // already running
  await startDevServer(sessionId, projectDir, broadcast);
}

async function startDevServer(
  sessionId: string,
  projectDir: string,
  broadcast: (data: string, sid?: string, tid?: string, channel?: any) => void
) {
  let sessionState = activeProcesses.get(sessionId);
  if (!sessionState) {
    const preferred = await getPreferredPort(projectDir);
    const { port } = await acquirePort({ preferred, killOccupant: true });
    sessionState = { devProcess: null, status: "IDLE", port, projectDir, installAttempts: 0, startAttempts: 0, recentStderr: "", lastFailureSig: null, visualRevisionAttempts: 0, bestVisualScore: 0 };
    activeProcesses.set(sessionId, sessionState);
  }

  if (sessionState.devProcess) {
    sessionState.devProcess.kill("SIGTERM");
    sessionState.devProcess = null;
  }

  // Guard: if already ERROR after MAX_ATTEMPTS, don't restart from watcher events —
  // only an explicit triggerSessionBoot call (which resets startAttempts) should retry.
  if (sessionState.status === "ERROR") return;

  if (sessionState.startAttempts >= MAX_ATTEMPTS) {
    sessionState.status = "ERROR";
    broadcast(`\x1b[31m[AUTOPILOT] Dev server failed to start after ${MAX_ATTEMPTS} attempts.\x1b[0m\r\n`, sessionId);
    return;
  }

  sessionState.status = "STARTING";
  sessionState.startAttempts++;
  await ensureWorkflowFile(projectDir);
  broadcast(`\x1b[35m[AUTOPILOT] Starting dev server on port ${sessionState.port}...\x1b[0m\r\n`, sessionId, undefined, "journal");

  try {
    let devCmd = { cmd: "npx", args: ["http-server", "-p", sessionState.port.toString(), "--cors", "-c-1"] };

    if (existsSync(path.join(projectDir, "package.json"))) {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(projectDir, "package.json"), "utf-8"));
        devCmd = getDevCommand(pkg, sessionState.port);
      } catch {}
    }

    // Fix 4 (EAGAIN): no shell:true — spawn the command directly.
    const dev = spawn(devCmd.cmd, devCmd.args, {
      cwd: projectDir,
      env: {
        ...process.env,
        PORT: sessionState.port.toString(),
        VITE_PORT: sessionState.port.toString(),
        HOST: "0.0.0.0",
        BROWSER: "none"
      }
    });

    sessionState.devProcess = dev;

    // Only fire when the "Local:" URL line appears — this line always carries the
    // actual port chosen by Vite, so we never call performVisualAudit with the wrong port.
    const localLinePattern = /Local:|Network:|Available on:|started server on|listening on/i;
    const fallbackReadyPattern = /compiled successfully|webpack compiled/i;
    // Vite drifts ports when requested port is busy — parse the real port from stdout.
    // Matches: "Local:   http://localhost:3003/" or "  ➜  Local:   http://localhost:3003/"
    const portDetectPattern = /(?:Local|localhost):.*?:(\d{4,5})\/?/i;

    dev.stdout?.on("data", (data) => {
      const output = data.toString();
      broadcast(`\x1b[32m[DEV] ${output}\x1b[0m`, sessionId, undefined, "journal");

      // 1. Detect actual port chosen by Vite (must happen before ready check below)
      const portMatch = output.match(portDetectPattern);
      if (portMatch) {
        const detectedPort = parseInt(portMatch[1], 10);
        if (!isNaN(detectedPort) && detectedPort !== sessionState!.port) {
          broadcast(`\x1b[36m[AUTOPILOT] Vite selected port ${detectedPort} (requested ${sessionState!.port}).\x1b[0m\r\n`, sessionId, undefined, "journal");
          sessionState!.port = detectedPort;
        }
      }

      // 2. Only trigger the visual audit once the Local URL line (with confirmed port) has appeared.
      //    "ready in" arrives in a separate earlier chunk *before* the Local URL — calling
      //    performVisualAudit there would use the stale port and produce a 503.
      const isLocalLine = localLinePattern.test(output);
      const isFallbackReady = fallbackReadyPattern.test(output);
      if ((isLocalLine || isFallbackReady) && sessionState!.status !== "READY") {
        performVisualAudit(sessionId, projectDir, sessionState!.port, broadcast);
      }
    });

    dev.stderr?.on("data", (data) => {
      const output = data.toString();
      broadcast(`\x1b[33m[DEV] ${output}\x1b[0m`, sessionId, undefined, "journal");
      // Loop Guard: keep last 4 KB of stderr so we can fingerprint the failure on close.
      sessionState!.recentStderr = (sessionState!.recentStderr + output).slice(-4096);
      if (output.includes("EADDRINUSE")) {
        broadcast(`\x1b[33m[AUTOPILOT] Port ${sessionState!.port} taken. Identifying & freeing...\x1b[0m\r\n`, sessionId, undefined, "journal");
        dev.kill("SIGTERM");
        acquirePort({ preferred: sessionState!.port, killOccupant: true }).then(({ port: newPort, action }) => {
          sessionState!.port = newPort;
          broadcast(`\x1b[36m[AUTOPILOT] Acquired port ${newPort} (${action}).\x1b[0m\r\n`, sessionId, undefined, "journal");
          startDevServer(sessionId, projectDir, broadcast);
        }).catch(err => {
          broadcast(`\x1b[31m[AUTOPILOT] Port acquisition failed: ${err.message}\x1b[0m\r\n`, sessionId, undefined, "journal");
        });
      }
      // Detect Vite pre-transform errors (e.g. invalid CSS // comments from AI)
      // and auto-fix the offending file so Vite's HMR can recover without a restart.
      if (output.includes("Pre-transform error") || output.includes("Invalid declaration")) {
        autoFixVitePreTransformError(output, projectDir, sessionId, broadcast).catch(() => {});
      }
    });

    dev.on("error", (err: any) => {
      if (err.code === 'EAGAIN' || err.code === 'ENOMEM') {
        broadcast(`\x1b[31m[AUTOPILOT] System resource limit (${err.code}) hit starting dev server. Retry in 8s...\x1b[0m\r\n`, sessionId, undefined, "journal");
        setTimeout(() => {
          const s = activeProcesses.get(sessionId);
          if (s) { s.devProcess = null; s.status = "IDLE"; }
          startDevServer(sessionId, projectDir, broadcast);
        }, 8000);
      } else {
        sessionState!.status = "ERROR";
        broadcast(`\x1b[31m[AUTOPILOT] Dev server spawn error: ${err.message}\x1b[0m\r\n`, sessionId, undefined, "journal");
      }
    });

    dev.on("close", (code) => {
      broadcast(`\x1b[33m[AUTOPILOT] Dev server exited (code ${code}).\x1b[0m\r\n`, sessionId, undefined, "journal");
      if (activeProcesses.get(sessionId)?.devProcess === dev) {
        const state = activeProcesses.get(sessionId)!;
        state.devProcess = null;

        if (state.status === "READY") {
          // Was healthy, crashed — allow chokidar to restart it on next file change
          state.status = "IDLE";
          state.startAttempts = 0;
        } else if (state.status === "STARTING") {
          // Died before becoming READY (TS errors, missing deps, etc.)
          state.startAttempts++;

          // Loop Guard: compute a coarse signature of THIS crash by extracting
          // error/throw lines from the captured stderr, stripping volatile bits
          // (paths, line:col numbers, ports, timestamps). If two consecutive
          // attempts produce the same signature, the bug is deterministic —
          // restarting again is pure waste, so we abort and surface it.
          const errLines = state.recentStderr
            .split(/\r?\n/)
            .filter(l => /error|throw|cannot|missing|failed|undefined|exception/i.test(l))
            .slice(-6)
            .join("\n");
          const sig = errLines
            .replace(/[A-Za-z]:\\[\S]+|\/[\S]+/g, "<path>")
            .replace(/:\d+:\d+/g, "")
            .replace(/\b\d{2,}\b/g, "<n>")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 400);

          const repeatedFailure = sig.length > 20 && sig === state.lastFailureSig;
          state.lastFailureSig = sig;
          state.recentStderr = "";

          if (repeatedFailure) {
            state.status = "ERROR";
            broadcast(`\x1b[31m[AUTOPILOT][LOOP-GUARD] Same failure signature on attempts ${state.startAttempts - 1} and ${state.startAttempts}. Aborting retries — the bug is deterministic and needs a real fix, not another restart.\x1b[0m\r\n`, sessionId, undefined, "journal");
            broadcast(`\x1b[31m[AUTOPILOT][LOOP-GUARD] Signature: ${sig}\x1b[0m\r\n`, sessionId, undefined, "journal");
          } else if (state.startAttempts >= MAX_ATTEMPTS) {
            state.status = "ERROR";
            broadcast(`\x1b[31m[AUTOPILOT] Dev server crashed ${MAX_ATTEMPTS} times during startup. Status → ERROR.\x1b[0m\r\n`, sessionId, undefined, "journal");
          } else {
            state.status = "IDLE";
            broadcast(`\x1b[33m[AUTOPILOT] Dev server crashed during startup (attempt ${state.startAttempts}/${MAX_ATTEMPTS}). Retrying in 5 s...\x1b[0m\r\n`, sessionId, undefined, "journal");
            setTimeout(() => {
              const s = activeProcesses.get(sessionId);
              if (s && s.status === "IDLE") startDevServer(sessionId, projectDir, broadcast);
            }, 5_000);
          }
        }
      }
    });

    setTimeout(() => {
      if (sessionState!.status === "STARTING") {
        performVisualAudit(sessionId, projectDir, sessionState!.port, broadcast);
      }
    }, 15000);

  } catch (error: any) {
    sessionState.status = "ERROR";
    broadcast(`\x1b[31m[AUTOPILOT] Dev server spawn failed: ${error.message}\x1b[0m\r\n`, sessionId);
  }
}

/**
 * Sovereign Visual Audit Protocol
 * Fix 5  (Visual Audit Fail): early exit when no browser is available, max 3 retries.
 * Fix 13.P (Preview READY gate): status is NEVER set to READY before the HTTP probe
 *   confirms something is actually serving. This eliminates the "READY but blank" state.
 */
async function performVisualAudit(
  sessionId: string,
  projectDir: string,
  port: number,
  broadcast: (data: string, sid?: string, tid?: string, channel?: any) => void
) {
  const sessionState = activeProcesses.get(sessionId);
  if (!sessionState) return;

  // Do NOT set status=READY here — that happens only after HTTP probe succeeds below.
  const targetUrl = `http://localhost:${port}`;

  broadcast(`\x1b[36m[AUTOPILOT] HTTP probe: waiting for ${targetUrl} to respond...\x1b[0m\r\n`, sessionId, undefined, "journal");
  // Up to 20 attempts × 1.5 s = 30 s grace window for slow npm installs + Vite cold start
  const verified = await verifyPreviewReady(targetUrl, 20, 1500);

  if (!verified) {
    // Process may have died — check
    if (!sessionState.devProcess || sessionState.devProcess.exitCode !== null) {
      broadcast(`\x1b[31m[AUTOPILOT] Dev server exited before becoming ready. Scheduling retry...\x1b[0m\r\n`, sessionId, undefined, "journal");
      // Let the close handler deal with the retry; just mark as IDLE here.
      if (sessionState.status === "STARTING") {
        sessionState.status = "IDLE";
        sessionState.devProcess = null;
      }
    } else {
      broadcast(`\x1b[33m[AUTOPILOT] Preview not responding on ${targetUrl} after 30 s. Scheduling retry...\x1b[0m\r\n`, sessionId, undefined, "journal");
      // Schedule one more probe pass 15 s later (Vite + large node_modules can be slow)
      setTimeout(async () => {
        const s = activeProcesses.get(sessionId);
        if (s && s.status === "STARTING") {
          const retry = await verifyPreviewReady(targetUrl, 10, 2000);
          if (retry) {
            s.status = "READY";
            s.startAttempts = 0;
            broadcast(`__REFRESH_PREVIEW__`, sessionId, undefined, "journal");
            broadcast(`__OPEN_PREVIEW__`, sessionId, undefined, "journal");
            broadcast(`\x1b[32m[AUTOPILOT] Preview confirmed (delayed) at ${targetUrl}.\x1b[0m\r\n`, sessionId, undefined, "journal");
          } else {
            s.status = "ERROR";
            broadcast(`\x1b[31m[AUTOPILOT] Preview failed to respond. Status → ERROR. Use Boot button to retry.\x1b[0m\r\n`, sessionId, undefined, "journal");
          }
        }
      }, 15_000);
    }
    // Fall through to visual audit attempt regardless
  } else {
    // ── Phase 13.7: HEALTH SCAN before opening — the HTTP probe only confirms
    //    that something is listening, not that it's serving valid output. Vite
    //    serves a 200 even when the bundler crashed (the body contains the
    //    error overlay). We scan the body for those markers and only open
    //    the preview when it's genuinely healthy.
    broadcast(`\x1b[36m[AUTOPILOT] Pre-flight health scan on ${targetUrl}...\x1b[0m\r\n`, sessionId, undefined, "journal");
    const health = await inspectPreviewHealth(targetUrl);
    if (!health.ok) {
      // Compile error or crash detected — surface to the user, do NOT open the preview
      broadcast(`\x1b[31m[AUTOPILOT] Preview NOT opened — health scan failed: ${health.reason}\x1b[0m\r\n`, sessionId, undefined, "journal");
      broadcast(`\x1b[33m[AUTOPILOT] Hold on — fixing the issue before opening the preview...\x1b[0m\r\n`, sessionId, undefined, "journal");
      // Status stays STARTING — the existing self-healing / dev-server-close
      // handlers will kick in and trigger a repair pass. We do NOT broadcast
      // __OPEN_PREVIEW__ in this branch, which is the whole point.
      sessionState.status = "STARTING";
    } else {
      // ── Probe passed AND body looks healthy: only NOW promote to READY ───
      sessionState.status = "READY";
      sessionState.startAttempts = 0;
      broadcast(`__REFRESH_PREVIEW__`, sessionId, undefined, "journal");
      broadcast(`__OPEN_PREVIEW__`, sessionId, undefined, "journal");
      broadcast(`\x1b[32m[AUTOPILOT] Preview verified + healthy at ${targetUrl} — opening.\x1b[0m\r\n`, sessionId, undefined, "journal");
    }
  }

  // Fix 5: Reduced from 10 to 3 audit attempts, and bail immediately if no browser found.
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Connectivity Check
    const isFree = await isPortFree(port);
    if (isFree) {
      broadcast(`\x1b[33m[VISUAL AUDIT] Port ${port} not responding yet (attempt ${attempt}). Waiting...\x1b[0m\r\n`, sessionId, undefined, "journal");
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    try {
      broadcast(`\x1b[35m[VISUAL AUDIT] Attempt ${attempt}: Running browser verification...\x1b[0m\r\n`, sessionId, undefined, "journal");

      const result = await captureVisualSnapshot(sessionId, targetUrl, 'audit-verify.png');

      if (result === null) {
        // null = no browser binary found — no point retrying
        broadcast(`\x1b[33m[VISUAL AUDIT] No browser binary found — skipping visual verification (console-only mode).\x1b[0m\r\n`, sessionId, undefined, "journal");
        return;
      }

      broadcast(`\x1b[32m[VISUAL AUDIT] Success: Screenshot captured.\x1b[0m\r\n`, sessionId, undefined, "journal");
      broadcast(`__VISUAL_SNAPSHOT__:${result.filename}`, sessionId, undefined, "journal");

      // Phase 13.3 + 13.4 — Visual Auditor + Self-Improvement Loop.
      // Fire-and-forget IIFE: vision-model grades the rendered design,
      // and if the score falls below VISUAL_REVISION_THRESHOLD we ask
      // the writer to revise the UI files based on the verdict, write
      // them back, wait for HMR, re-screenshot, and re-audit. Capped
      // at MAX_VISUAL_REVISIONS to prevent ping-ponging.
      (async () => {
        const colour = (s: number) =>
          s >= 80 ? "\x1b[32m" : s >= 75 ? "\x1b[36m" : s >= 50 ? "\x1b[33m" : "\x1b[31m";
        try {
          const {
            auditScreenshot,
            formatVerdictForJournal,
            requestVisualRevision,
            readSandboxUiFiles,
          } = await import("./visualAuditorService.js");

          let currentSnapshot = result.filename;

          for (let pass = 0; pass <= MAX_VISUAL_REVISIONS; pass++) {
            const screenshotPath = path.join(projectDir, ".nexus", "snapshots", currentSnapshot);
            const stage = pass === 0 ? "initial" : `revision ${pass}`;
            broadcast(`\x1b[36m[VISUAL AUDITOR] (${stage}) Sending screenshot to vision model...\x1b[0m\r\n`, sessionId, undefined, "journal");

            const verdict = await auditScreenshot(screenshotPath, `(rendered preview — ${stage})`, undefined, sessionId);
            if (!verdict) {
              broadcast(`\x1b[33m[VISUAL AUDITOR] Skipped (no Gemini key available or screenshot unreadable).\x1b[0m\r\n`, sessionId, undefined, "journal");
              return;
            }

            const s = activeProcesses.get(sessionId);
            if (s && verdict.score > s.bestVisualScore) s.bestVisualScore = verdict.score;

            broadcast(`${colour(verdict.score)}${formatVerdictForJournal(verdict)}\x1b[0m\r\n`, sessionId, undefined, "journal");
            broadcast(`__VISUAL_VERDICT__:${JSON.stringify({ ...verdict, pass })}`, sessionId, undefined, "journal");

            if (verdict.score >= VISUAL_REVISION_THRESHOLD) {
              broadcast(`\x1b[32m[SELF-IMPROVE] Score ${verdict.score} ≥ ${VISUAL_REVISION_THRESHOLD} — design accepted.\x1b[0m\r\n`, sessionId, undefined, "journal");

              // Phase 13.6 — Memory of Wins: snapshot proven designs ≥ 85.
              try {
                const { recordWin, WINS_THRESHOLD } = await import("./winsLibraryService.js");
                if (verdict.score >= WINS_THRESHOLD) {
                  // Discover candidate UI files in the sandbox (App, components, index.css)
                  const filePaths: string[] = [];
                  for (const rel of ["src/App.tsx", "src/App.jsx", "src/index.css"]) filePaths.push(rel);
                  try {
                    const compDir = path.join(projectDir, "src", "components");
                    const entries = await fs.readdir(compDir);
                    for (const e of entries) if (/\.(t|j)sx$/.test(e)) filePaths.push(`src/components/${e}`);
                  } catch {}

                  // Look up the user goal that triggered this build (latest user
                  // message from the session, best-effort via MongoDB).
                  let userGoal = "(unknown intent)";
                  try {
                    const mongoose = (await import("mongoose")).default;
                    if (mongoose.connection.readyState === 1) {
                      const { Session } = await import("../models/Session.js");
                      const sess = await Session.findOne({ sessionId });
                      const lastUser = sess?.messages?.slice().reverse().find((m: any) => m.role === "user");
                      if (lastUser?.content) userGoal = String(lastUser.content).slice(0, 280);
                    }
                  } catch {}

                  const win = await recordWin({
                    sessionId,
                    projectDir,
                    score: verdict.score,
                    summary: verdict.summary,
                    intent: userGoal,
                    filePaths,
                  });
                  if (win) {
                    broadcast(`\x1b[32m[MEMORY OF WINS] Saved win #${win.id} (score ${win.score}/100, ${win.files.length} files) — future builds will reference this pattern.\x1b[0m\r\n`, sessionId, undefined, "journal");
                  }
                }
              } catch (winErr: any) {
                broadcast(`\x1b[33m[MEMORY OF WINS] Snapshot failed: ${String(winErr?.message || winErr).slice(0, 120)}\x1b[0m\r\n`, sessionId, undefined, "journal");
              }
              return;
            }

            if (!s || s.visualRevisionAttempts >= MAX_VISUAL_REVISIONS) {
              broadcast(`\x1b[33m[SELF-IMPROVE] Revision cap reached (${MAX_VISUAL_REVISIONS}). Best score this boot: ${s?.bestVisualScore ?? verdict.score}/100.\x1b[0m\r\n`, sessionId, undefined, "journal");
              return;
            }
            s.visualRevisionAttempts++;

            broadcast(`\x1b[35m[SELF-IMPROVE] Score ${verdict.score} < ${VISUAL_REVISION_THRESHOLD} — running visual revision pass ${s.visualRevisionAttempts}/${MAX_VISUAL_REVISIONS}...\x1b[0m\r\n`, sessionId, undefined, "journal");

            const uiFiles = await readSandboxUiFiles(projectDir, 8);
            if (uiFiles.length === 0) {
              broadcast(`\x1b[33m[SELF-IMPROVE] No UI files found to revise — aborting loop.\x1b[0m\r\n`, sessionId, undefined, "journal");
              return;
            }
            broadcast(`\x1b[36m[SELF-IMPROVE] Sending ${uiFiles.length} file(s) to writer with verdict feedback...\x1b[0m\r\n`, sessionId, undefined, "journal");

            const revised = await requestVisualRevision(uiFiles, verdict, "(visual revision pass)", undefined, sessionId);
            if (!revised || revised.length === 0) {
              broadcast(`\x1b[33m[SELF-IMPROVE] Writer did not return revisions — keeping current design.\x1b[0m\r\n`, sessionId, undefined, "journal");
              return;
            }

            // Write revised files back to the sandbox. Vite HMR will hot-reload them.
            let writtenCount = 0;
            for (const f of revised) {
              try {
                const abs = path.join(projectDir, f.path);
                // Defensive: ensure path stays inside projectDir
                if (!abs.startsWith(projectDir + path.sep) && abs !== projectDir) continue;
                await fs.mkdir(path.dirname(abs), { recursive: true });
                await fs.writeFile(abs, f.content, "utf-8");
                writtenCount++;
              } catch (wErr: any) {
                broadcast(`\x1b[33m[SELF-IMPROVE] Could not write ${f.path}: ${wErr?.message?.slice(0, 80)}\x1b[0m\r\n`, sessionId, undefined, "journal");
              }
            }
            broadcast(`\x1b[36m[SELF-IMPROVE] Wrote ${writtenCount} revised file(s). Waiting for Vite HMR...\x1b[0m\r\n`, sessionId, undefined, "journal");
            broadcast("__REFRESH_FS__", sessionId, undefined, "journal");

            // Give Vite HMR ~5 s to finish recompiling before we re-screenshot.
            await new Promise(r => setTimeout(r, 5000));

            const reShot = await captureVisualSnapshot(sessionId, targetUrl, `audit-revision-${s.visualRevisionAttempts}.png`);
            if (!reShot) {
              broadcast(`\x1b[33m[SELF-IMPROVE] Re-screenshot failed — exiting loop.\x1b[0m\r\n`, sessionId, undefined, "journal");
              return;
            }
            broadcast(`__VISUAL_SNAPSHOT__:${reShot.filename}`, sessionId, undefined, "journal");
            currentSnapshot = reShot.filename;
            // Loop continues with the new snapshot.
          }

          const finalState = activeProcesses.get(sessionId);
          broadcast(`\x1b[33m[SELF-IMPROVE] Loop ended at cap. Best score this boot: ${finalState?.bestVisualScore ?? "?"}/100.\x1b[0m\r\n`, sessionId, undefined, "journal");
        } catch (vErr: any) {
          broadcast(`\x1b[33m[VISUAL AUDITOR] Error: ${String(vErr?.message || vErr).slice(0, 160)}\x1b[0m\r\n`, sessionId, undefined, "journal");
        }
      })();

      return;
    } catch (e: any) {
      broadcast(`\x1b[33m[VISUAL AUDIT] Warning: Browser failed (${e.message}). Retrying in 5s...\x1b[0m\r\n`, sessionId, undefined, "journal");
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  broadcast(`\x1b[33m[VISUAL AUDIT] Completed (${maxAttempts} attempts). Preview is serving on port ${port}.\x1b[0m\r\n`, sessionId, undefined, "journal");
}

export function getSessionData(sessionId: string) {
  return activeProcesses.get(sessionId);
}

/** Return a snapshot of all active sandbox sessions for the Self-Healing dashboard. */
export function getAllSessionStatuses(): Array<{
  sessionId: string;
  status: SessionStatus;
  port: number;
  projectDir: string;
  startAttempts: number;
  installAttempts: number;
}> {
  const result: ReturnType<typeof getAllSessionStatuses> = [];
  for (const [sessionId, proc] of activeProcesses.entries()) {
    result.push({
      sessionId,
      status: proc.status,
      port: proc.port,
      projectDir: proc.projectDir,
      startAttempts: proc.startAttempts,
      installAttempts: proc.installAttempts,
    });
  }
  return result;
}

/**
 * Fix 13.P — Vite config enforcer.
 *
 * Whenever the AI writes a vite.config.ts into a sandbox, it often omits
 * the three settings Replit's mTLS iframe proxy REQUIRES:
 *   • server.host: '0.0.0.0'   — binds to all interfaces, not just 127.0.0.1
 *   • server.allowedHosts: true — accepts requests from the replit.dev domain
 *   • server.hmr.clientPort: 443 — tells Vite's HMR WS to use the HTTPS port
 *
 * This function is called after any vite.config.ts file write.  It does a
 * text-level patch (no AST needed) to inject these values if absent, then
 * overwrites the file in place. Safe to call on scaffold-generated configs too.
 */
export async function patchViteConfig(filePath: string): Promise<void> {
  try {
    let src = await fs.readFile(filePath, "utf-8");

    // Already fully patched — nothing to do
    if (src.includes("allowedHosts") && src.includes("hmr") && src.includes("clientPort")) return;

    // Strategy: find the server: { ... } block and inject missing fields.
    // If there is no server block at all, append one before the closing `})`.

    const serverBlockRe = /server\s*:\s*\{([^}]*)\}/s;
    const serverMatch = serverBlockRe.exec(src);

    if (serverMatch) {
      let block = serverMatch[1];
      if (!/host\s*:/.test(block))         block += `\n    host: '0.0.0.0',`;
      if (!/allowedHosts\s*:/.test(block)) block += `\n    allowedHosts: true,`;
      if (!/hmr\s*:/.test(block))          block += `\n    hmr: { clientPort: 443 },`;
      src = src.replace(serverBlockRe, `server: {${block}}`);
    } else {
      // No server block — inject one before the final closing `})`
      const serverBlock = `\n  server: {\n    host: '0.0.0.0',\n    allowedHosts: true,\n    hmr: { clientPort: 443 },\n  },\n`;
      src = src.replace(/\}\s*\)\s*;?\s*$/, `${serverBlock}});\n`);
    }

    await fs.writeFile(filePath, src, "utf-8");
    console.log(`[AUTOPILOT] Patched vite.config.ts with Replit proxy settings: ${filePath}`);
  } catch (err: any) {
    console.warn(`[AUTOPILOT] Could not patch vite.config.ts at ${filePath}: ${err.message}`);
  }
}

export async function triggerSessionBoot(
  sessionId: string,
  broadcast: (data: string, sid?: string, tid?: string, channel?: any) => void
) {
  const sessionDir = path.join(SANDBOX_BASE, sessionId);
  const projectDir = await findProjectRoot(sessionDir);
  if (!projectDir) {
    console.warn(`[AUTOPILOT] triggerSessionBoot: no package.json found in ${sessionDir}`);
    return;
  }
  const existing = activeProcesses.get(sessionId);
  if (existing?.status === 'READY' || existing?.status === 'INSTALLING') return;
  // Reset ERROR state so that a manual triggerSessionBoot call gets a fresh attempt.
  if (existing?.status === 'ERROR') {
    existing.startAttempts = 0;
    existing.installAttempts = 0;
    existing.status = 'IDLE';
  }
  await triggerInstallAndRun(sessionId, projectDir, broadcast);
}

export function killSession(sessionId: string) {
  const state = activeProcesses.get(sessionId);
  if (state?.devProcess) {
    state.devProcess.kill("SIGTERM");
    state.devProcess = null;
    state.status = "IDLE";
  }
  activeProcesses.delete(sessionId);
}
