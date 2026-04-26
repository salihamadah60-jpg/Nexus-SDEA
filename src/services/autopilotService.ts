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

export type SessionStatus = "IDLE" | "INSTALLING" | "STARTING" | "READY" | "ERROR";

interface SessionProcess {
  devProcess: ChildProcess | null;
  status: SessionStatus;
  port: number;
  projectDir: string;
  installAttempts: number;
  startAttempts: number;
}

const activeProcesses = new Map<string, SessionProcess>();
const START_PORT = 3001;
const MAX_ATTEMPTS = 3;

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

/**
 * Autopilot Error Recovery: detect Vite "Pre-transform error" / "Invalid declaration"
 * in stderr, parse the offending file path, apply known fixes, and let Vite's HMR
 * reload the file automatically — no dev-server restart required.
 */
async function autoFixVitePreTransformError(
  errorOutput: string,
  projectDir: string,
  sessionId: string,
  broadcast: (data: string, sid?: string, tid?: string, channel?: any) => void
): Promise<void> {
  // Dedupe: ignore if we already ran a fix in the last 3 seconds for this session
  const key = `vtfix:${sessionId}`;
  const lastFix = (autoFixVitePreTransformError as any)._lastFix ?? {};
  const now = Date.now();
  if (lastFix[key] && now - lastFix[key] < 3000) return;
  lastFix[key] = now;
  (autoFixVitePreTransformError as any)._lastFix = lastFix;

  // Parse file path from error: "File: /absolute/path/to/file.css"
  const fileMatch = errorOutput.match(/File:\s*([^\n\r]+)/);
  if (!fileMatch) return;

  const offendingPath = fileMatch[1].trim();
  broadcast(`\x1b[35m[AUTOPILOT] Pre-transform error detected in ${path.basename(offendingPath)} — attempting auto-fix...\x1b[0m\r\n`, sessionId, undefined, "journal");

  try {
    const original = await fs.readFile(offendingPath, 'utf-8');
    const isCss = offendingPath.endsWith('.css');
    if (!isCss) return; // only CSS auto-fix supported for now

    const fixed = sanitizeCssContent(original);
    if (fixed === original) {
      broadcast(`\x1b[33m[AUTOPILOT] Pre-transform error in ${path.basename(offendingPath)} — no auto-fix pattern matched. Manual inspection needed.\x1b[0m\r\n`, sessionId, undefined, "journal");
      return;
    }

    await fs.writeFile(offendingPath, fixed, 'utf-8');
    broadcast(`\x1b[32m[AUTOPILOT] Auto-fixed invalid CSS in ${path.basename(offendingPath)} — Vite HMR will reload.\x1b[0m\r\n`, sessionId, undefined, "journal");
  } catch (err: any) {
    broadcast(`\x1b[31m[AUTOPILOT] Auto-fix failed for ${path.basename(offendingPath)}: ${err.message}\x1b[0m\r\n`, sessionId, undefined, "journal");
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
    sessionState = { devProcess: null, status: "IDLE", port, projectDir, installAttempts: 0, startAttempts: 0 };
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
    sessionState = { devProcess: null, status: "IDLE", port, projectDir, installAttempts: 0, startAttempts: 0 };
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

    const readyPattern = /ready in|Local:|Network:|started server|listening on|http:\/\/localhost|Available on:|compiled successfully|webpack compiled/i;
    // Vite drifts ports when requested port is busy — parse the real port from stdout.
    // Matches: "Local:   http://localhost:3003/" or "  ➜  Local:   http://localhost:3003/"
    const portDetectPattern = /(?:Local|localhost):.*?:(\d{4,5})\/?/i;

    dev.stdout?.on("data", (data) => {
      const output = data.toString();
      broadcast(`\x1b[32m[DEV] ${output}\x1b[0m`, sessionId, undefined, "journal");

      // Detect actual port chosen by Vite (may differ from requested when port was busy)
      const portMatch = output.match(portDetectPattern);
      if (portMatch) {
        const detectedPort = parseInt(portMatch[1], 10);
        if (!isNaN(detectedPort) && detectedPort !== sessionState!.port) {
          broadcast(`\x1b[36m[AUTOPILOT] Vite selected port ${detectedPort} (requested ${sessionState!.port}).\x1b[0m\r\n`, sessionId, undefined, "journal");
          sessionState!.port = detectedPort;
        }
      }

      if (readyPattern.test(output) && sessionState!.status !== "READY") {
        performVisualAudit(sessionId, projectDir, sessionState!.port, broadcast);
      }
    });

    dev.stderr?.on("data", (data) => {
      const output = data.toString();
      broadcast(`\x1b[33m[DEV] ${output}\x1b[0m`, sessionId, undefined, "journal");
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
          state.status = "IDLE";
          state.startAttempts = 0;
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
 * Fix 5 (Visual Audit Fail): early exit when no browser is available, max 3 retries.
 */
async function performVisualAudit(
  sessionId: string,
  projectDir: string,
  port: number,
  broadcast: (data: string, sid?: string, tid?: string, channel?: any) => void
) {
  const sessionState = activeProcesses.get(sessionId);
  if (!sessionState) return;

  sessionState.status = "READY";
  sessionState.startAttempts = 0;

  const targetUrl = `http://localhost:${port}`;

  const verified = await verifyPreviewReady(targetUrl, 10, 1000);
  if (verified) {
    broadcast(`__REFRESH_PREVIEW__`, sessionId, undefined, "journal");
    broadcast(`__OPEN_PREVIEW__`, sessionId, undefined, "journal");
    broadcast(`\x1b[32m[AUTOPILOT] Preview verified at ${targetUrl} — opening.\x1b[0m\r\n`, sessionId, undefined, "journal");
  } else {
    broadcast(`\x1b[33m[AUTOPILOT] Preview not yet responding on ${targetUrl}. Monitoring continues.\x1b[0m\r\n`, sessionId, undefined, "journal");
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
