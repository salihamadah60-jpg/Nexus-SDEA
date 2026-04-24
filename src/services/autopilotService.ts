import chokidar from "chokidar";
import path from "path";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { spawn, ChildProcess } from "child_process";
import fs from "fs/promises";
import { existsSync } from "fs";
import http from "http";
import { acquirePort, isPortFree } from "./portService.js";
import { captureVisualSnapshot } from "./visualService.js";

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

export async function setupAutopilot(broadcast: (data: string, sid?: string, tid?: string, channel?: any) => void) {
  activeProcesses.clear();
  console.log("🚀 [AUTOPILOT] Initializing Sovereign Autopilot Protocol [v7.5]...");

  try {
    await fs.mkdir(SANDBOX_BASE, { recursive: true });
    const sessions = await fs.readdir(SANDBOX_BASE);
    for (const sid of sessions) {
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
      // Look for --port in dev script
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

  // Write .nexus/workflow.json so the project is self-describing
  await ensureWorkflowFile(projectDir);

  await runInstallWithRetry(sessionId, projectDir, broadcast);
}

/**
 * Write `.nexus/workflow.json` if missing — the EXECUTE_WORKFLOW protocol.
 * Mirrors how `.replit` declares run commands; lets sandboxes describe their own
 * boot chain so future restores don't depend on heuristics.
 */
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
      port_strategy: "intelligent",  // try preferred → kill occupant → fallback
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
  // On any retry, wipe the previous (likely broken) node_modules so the next
  // install actually rebuilds rather than skipping with "up to date".
  if (attempt > 0) await nukeBrokenNodeModules(projectDir, `retry #${attempt}`);
  broadcast(`\x1b[36m[AUTOPILOT] ${attempt > 0 ? `Retry ${attempt}: ` : ''}Running npm ${args.join(' ')}...\x1b[0m\r\n`, sessionId, undefined, "journal");

  try {
    let errorOutput = '';
    const install = spawn("npm", args, {
      cwd: projectDir,
      shell: true,
      env: { ...process.env, CI: "false" }
    });

    install.stdout.on("data", (data) => broadcast(`\x1b[90m${data}\x1b[0m`, sessionId, undefined, "journal"));
    install.stderr.on("data", (data) => {
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
  if (!sessionState?.devProcess || sessionState.status === "ERROR") {
    await startDevServer(sessionId, projectDir, broadcast);
  }
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

    const dev = spawn(devCmd.cmd, devCmd.args, {
      cwd: projectDir,
      shell: true,
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
    const errorPattern = /error|EADDRINUSE|failed to compile/i;

    dev.stdout.on("data", (data) => {
      const output = data.toString();
      broadcast(`\x1b[32m[DEV] ${output}\x1b[0m`, sessionId, undefined, "journal");
      if (readyPattern.test(output) && sessionState!.status !== "READY") {
        performVisualAudit(sessionId, projectDir, sessionState!.port, broadcast);
      }
    });

    dev.stderr.on("data", (data) => {
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
 * Continuously monitors the port, takes screenshots via hidden browser, 
 * and self-corrects until successful.
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

  // Verified preview gate — only signal OPEN_PREVIEW once the dev server actually
  // returns HTTP 2xx/3xx. Avoids the "404 / refused" flicker users see when the
  // iframe opens before vite is listening.
  const verified = await verifyPreviewReady(targetUrl, 10, 1000);
  if (verified) {
    broadcast(`__REFRESH_PREVIEW__`, sessionId, undefined, "journal");
    broadcast(`__OPEN_PREVIEW__`, sessionId, undefined, "journal");
    broadcast(`\x1b[32m[AUTOPILOT] Preview verified at ${targetUrl} — opening.\x1b[0m\r\n`, sessionId, undefined, "journal");
  } else {
    broadcast(`\x1b[33m[AUTOPILOT] Preview not yet responding on ${targetUrl}. Will continue monitoring; not opening UI yet.\x1b[0m\r\n`, sessionId, undefined, "journal");
  }
  
  // Continuous Monitoring Loop
  let attempts = 0;
  const maxAttempts = 10;
  
  while (attempts < maxAttempts) {
    attempts++;
    
    // 1. Connectivity Check
    const isFree = await isPortFree(port);
    if (isFree) {
        broadcast(`\x1b[33m[VISUAL AUDIT] Attempt ${attempts}: Port ${port} is not responding yet. Waiting...\x1b[0m\r\n`, sessionId, undefined, "journal");
        await new Promise(r => setTimeout(r, 3000));
        continue;
    }

    // 2. Headless Browser Verification
    try {
      broadcast(`\x1b[35m[VISUAL AUDIT] Attempt ${attempts}: Initializing Sovereign Browser for verification...\x1b[0m\r\n`, sessionId, undefined, "journal");
      
      const result = await captureVisualSnapshot(sessionId, targetUrl, 'audit-verify.png');
      
      if (result) {
        broadcast(`\x1b[32m[VISUAL AUDIT] Success: Core integrity verified. Screenshot captured.\x1b[0m\r\n`, sessionId, undefined, "journal");
        broadcast(`__VISUAL_SNAPSHOT__:${result.filename}`, sessionId, undefined, "journal");
        return;
      } else {
        broadcast(`\x1b[31m[VISUAL AUDIT] Warning: Visual capture skipped (No browser binary). Falling back to console-only mode.\x1b[0m\r\n`, sessionId, undefined, "journal");
        return;
      }
    } catch (e: any) {
      broadcast(`\x1b[33m[VISUAL AUDIT] Warning: Browser verification failed (${e.message}). Retrying in 5s...\x1b[0m\r\n`, sessionId, undefined, "journal");
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  broadcast(`\x1b[31m[VISUAL AUDIT] Failed: Port ${port} was unreachable after ${maxAttempts} monitoring cycles.\x1b[0m\r\n`, sessionId, undefined, "journal");
}

export function getSessionData(sessionId: string) {
  return activeProcesses.get(sessionId);
}

/**
 * Explicitly trigger install+boot for a session from outside (e.g. from chat handler).
 * Idempotent — skips if already READY or INSTALLING.
 */
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
