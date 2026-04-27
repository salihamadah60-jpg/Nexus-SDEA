import dotenv from "dotenv";
import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { setupIdentityWatcher } from "./src/services/identityService.js";
import { connectDB } from "./src/config/db.js";
import { setupMiddleware } from "./src/config/middleware.js";
import { setupWebSocket } from "./src/config/ws.js";
import apiRoutes from "./src/routes/api.js";
import { createChatHandler } from "./src/services/aiService.js";
import { SANDBOX_BASE } from "./src/config/backendConstants.js";
import fs from "fs/promises";
import { existsSync } from "fs";
import { setupAutopilot, getSessionData, getAllSessionStatuses, killSession, triggerSessionBoot } from "./src/services/autopilotService.js";
import { e2bManager } from "./src/services/e2bService.js";
import { acquirePort, registerNexusPort } from "./src/services/portService.js";
import { performPreFlightCleanup } from "./src/services/journalService.js";
import { db, closeDb } from "./src/services/stateDb.js";
import { resumeAfterCrash } from "./src/services/blackboardService.js";
import { dnaChecksumWrite, verifyDnaChecksum } from "./src/services/securityService.js";
import { coldArchive } from "./src/services/dnaService.js";
import { chatLimiter } from "./src/routes/sovereign.js";
import { nexusLog } from "./src/services/logService.js";
import httpProxy from "http-proxy";

const boot = nexusLog("boot");

const proxy = httpProxy.createProxyServer({});

function getLoadingHtml(status: string, sessionId: string) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Syncing | Nexus AI</title>
      <style>
        body { margin: 0; background: #030306; display: flex; align-items: center; justify-content: center; height: 100vh; overflow: hidden; font-family: sans-serif; color: #d4af37; }
        .pulse { width: 80px; height: 80px; background: rgba(212, 175, 55, 0.2); border: 2px solid #d4af37; border-radius: 20px; animation: pulse-anim 2s infinite ease-in-out; display: flex; align-items: center; justify-content: center; }
        @keyframes pulse-anim { 0% { transform: scale(0.9); opacity: 0.5; box-shadow: 0 0 0 0 rgba(212, 175, 55, 0.4); } 70% { transform: scale(1.1); opacity: 1; box-shadow: 0 0 0 20px rgba(212, 175, 55, 0); } 100% { transform: scale(0.9); opacity: 0.5; } }
        .nexus-log { position: absolute; bottom: 40px; text-align: center; }
        .status { font-size: 10px; text-transform: uppercase; letter-spacing: 0.3em; font-weight: bold; margin-bottom: 8px; }
        .id { font-size: 8px; opacity: 0.4; letter-spacing: 0.1em; }
        .spinner { border: 2px solid rgba(212, 175, 55, 0.1); border-top: 2px solid #d4af37; border-radius: 50%; width: 12px; height: 12px; animation: spin 1s linear infinite; margin: 0 auto 10px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      </style>
      <script>
        setTimeout(() => window.location.reload(), 2000);
      </script>
    </head>
    <body>
      <div class="pulse">
        <div style="font-size: 24px; font-weight: 900;">N</div>
      </div>
      <div class="nexus-log">
        <div class="spinner"></div>
        <div class="status">${status}</div>
        <div class="id">ID: ${sessionId}</div>
      </div>
    </body>
    </html>
  `;
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on("unhandledRejection", (reason: any) => {
  console.warn(`[PROCESS] Unhandled rejection (non-fatal): ${reason?.message || reason}`);
});
process.on("uncaughtException", (err: any) => {
  console.warn(`[PROCESS] Uncaught exception (non-fatal): ${err?.message || err}`);
});

async function bootstrap() {
  // 0. Environment Validation
  const envPaths = [".env", ".env.local"];
  envPaths.forEach(p => {
    if (existsSync(path.join(process.cwd(), p))) {
      dotenv.config({ path: path.join(process.cwd(), p) });
    }
  });

  // Soft validation: Nexus only needs *one* working AI provider key. Any of the
  // accepted variants (Gemini, Nexus, Groq, GitHub GPT, HuggingFace) unlocks boot.
  const AI_KEY_CANDIDATES = [
    "GEMINI_API_KEY", "NEXUS_AI_KEY", "NEXUS_KEY", "NEXUS_SECRET_KEY",
    "ALT_GEMINI_KEY", "GROQ_API_KEY", "GITHUB_TOKEN", "GITHUB_GPT",
    "ALT_GITHUB_GPT", "HUGGINGFACE_TOKEN", "HF_TOKEN"
  ];
  const present = AI_KEY_CANDIDATES.filter(v => (process.env[v] || "").trim().length > 0);
  if (present.length === 0) {
    console.warn(`⚠️  No AI provider keys detected. Nexus will boot in degraded mode (UI works; chat will return a "no providers" message until a key is added).`);
  } else {
    console.log(`🔑 AI providers active via: ${present.join(", ")}`);
  }

  const app = express();
  const server = createServer(app);
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 5000;

  // 1. Initializations
  await performPreFlightCleanup();
  setupIdentityWatcher();
  await connectDB();
  await fs.mkdir(SANDBOX_BASE, { recursive: true });

  // 1.1 Persistent state (SQLite) + crash-resume + DNA integrity
  try {
    db().prepare("SELECT 1").get();
    resumeAfterCrash();
    const ck = await verifyDnaChecksum();
    if (!ck.expected) {
      const sum = await dnaChecksumWrite();
      boot.info(`dna.json checksum recorded (${sum.slice(0, 12)}…)`);
    } else if (!ck.ok) {
      boot.warn(`⚠ dna.json checksum MISMATCH (expected ${ck.expected.slice(0,12)}…, got ${ck.current.slice(0,12)}…) — re-pinning`);
      await dnaChecksumWrite();
    } else {
      boot.info(`dna.json integrity verified`);
    }
    coldArchive().then(r => r.moved && boot.info(`cold-archived ${r.moved} stale DNA patterns`)).catch(() => {});
  } catch (e: any) {
    boot.error(`SQLite init failed: ${e?.message}`);
  }

  // 2. Middleware & WebSocket
  setupMiddleware(app);
  const { broadcast } = setupWebSocket(server);

  // 3. Routes
  app.use("/api", apiRoutes);
  app.post("/api/chat", chatLimiter, createChatHandler(broadcast));

  // 3.1 Visual Debug / Snapshot Exposure
  app.get("/api/visual-debug/:sessionId/:filename", async (req, res) => {
    const { sessionId, filename } = req.params;
    const projectPath = path.join(SANDBOX_BASE, sessionId);
    const snapPath = path.join(projectPath, ".nexus", "snapshots", filename);
    if (existsSync(snapPath)) {
      res.sendFile(snapPath);
    } else {
      res.status(404).send("Not found");
    }
  });

  app.get("/api/visual-audit/:sessionId/:filename", async (req, res) => {
    const { sessionId, filename } = req.params;
    const projectPath = path.join(SANDBOX_BASE, sessionId);
    const auditPath = path.join(projectPath, ".nexus", "snapshots", filename.replace(".png", ".json"));
    if (existsSync(auditPath)) {
      res.sendFile(auditPath);
    } else {
      res.status(404).send("Not found");
    }
  });

  app.get("/api/e2b/status", (req, res) => {
    res.json({ active: !!process.env.E2B_API_KEY });
  });

  // ── Sandbox Self-Healing Dashboard API ──────────────────────────────────────
  // GET  /api/autopilot/sessions  — list all active sandboxes + their status
  // POST /api/autopilot/sessions/:sessionId/kill  — SIGTERM the dev server
  // POST /api/autopilot/sessions/:sessionId/boot  — trigger a fresh boot
  app.get("/api/autopilot/sessions", (_req, res) => {
    res.json({ sessions: getAllSessionStatuses() });
  });

  app.post("/api/autopilot/sessions/:sessionId/kill", (req, res) => {
    const { sessionId } = req.params;
    if (!sessionId || /[/\\]/.test(sessionId)) return res.status(400).json({ error: "Bad session id" });
    try {
      killSession(sessionId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/autopilot/sessions/:sessionId/boot", async (req, res) => {
    const { sessionId } = req.params;
    if (!sessionId || /[/\\]/.test(sessionId)) return res.status(400).json({ error: "Bad session id" });
    try {
      await triggerSessionBoot(sessionId, broadcast);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Direct static-file preview for sandbox sessions. Serves whatever the
  // Sovereign Blackboard wrote into sandbox/projects/<sessionId>/. Used by
  // the Preview pane for static-only outputs (no autopilot needed).
  app.get(["/sandbox-preview/:sessionId", "/sandbox-preview/:sessionId/", "/sandbox-preview/:sessionId/*"], (req, res) => {
    // Block path-traversal attempts in the raw URL before Express normalisation strips them.
    const rawUrl = req.originalUrl || "";
    if (/\.\.(\/|\\|%2f|%5c|%2F|%5C)/i.test(rawUrl) || decodeURIComponent(rawUrl).includes("../")) {
      return res.status(400).send("Bad path — traversal detected");
    }
    const sessionId = req.params.sessionId;
    // Reject session IDs that look like path segments (extra safety).
    if (/[/\\]/.test(sessionId)) return res.status(400).send("Bad session id");
    const root = path.join(SANDBOX_BASE, sessionId);
    if (!existsSync(root)) return res.status(404).send("Session sandbox not found");
    const rel = (req.params as any)[0] || "index.html";
    const safe = path.normalize(rel).replace(/^([./\\])+/, "");
    const target = path.join(root, safe);
    if (!target.startsWith(root)) return res.status(400).send("Bad path");
    if (!existsSync(target)) return res.status(404).send("File not found");
    res.sendFile(target);
  });

  // 3.2 Sovereign Proxy Layer (Native Preview Architecture — v8.0)
  //
  // Two cooperating handlers:
  //
  // (a) The explicit  /api/preview/:sessionId/...  proxy STRIPS the
  //     /api/preview/<sid> prefix from the URL before forwarding so the
  //     dev server (Vite, Next, http-server, …) sees the path it actually
  //     expects ("/", "/src/main.tsx", …).  Without this strip, Vite
  //     never matched any route and returned its SPA index.html for every
  //     request → blank iframe.
  //
  // (b) An asset interceptor mounted just below this block forwards
  //     Vite-internal asset requests (e.g. /src/foo.tsx, /@vite/client,
  //     /node_modules/...) whose `Referer` originates inside a preview
  //     iframe to that session's dev server.  This is what makes the
  //     module graph load instead of 404'ing on the Nexus origin.
  const VITE_ASSET_RE = /^\/(?:src|@vite|@id|@fs|@react-refresh|@vite-plugin|node_modules|__vite|@import-map)/;
  const VITE_ASSET_EXT = /\.(?:m?jsx?|tsx?|css|s[ac]ss|svg|png|jpe?g|webp|gif|woff2?|ttf|otf|ico|json|map|wasm)(?:\?.*)?$/i;

  app.all("/api/preview/:sessionId*", (req, res) => {
    const sessionId = (req.params as any)['sessionId'];
    if (!sessionId || /[/\\]/.test(sessionId)) {
      return res.status(400).send("Bad session id");
    }
    const session = getSessionData(sessionId);
    if (!session) {
      return res.status(200).send(getLoadingHtml("Initializing Native Preview...", sessionId));
    }
    if (session.status !== "READY") {
      const statusMap = {
        "IDLE": "Warming up DNA...",
        "INSTALLING": "Neural Synthesis: npm install...",
        "STARTING": "Native Boot: npx http-server...",
        "ERROR": "Critical Fault: Check Terminal logs"
      };
      return res.status(200).send(
        getLoadingHtml(statusMap[session.status as keyof typeof statusMap] || "Processing...", sessionId)
      );
    }
    // Strip /api/preview/<sessionId> so the dev server sees the actual
    // app path. originalUrl still has the prefix.
    const prefix = `/api/preview/${sessionId}`;
    const stripped = req.originalUrl.startsWith(prefix)
      ? req.originalUrl.slice(prefix.length)
      : req.originalUrl;
    req.url = stripped || "/";
    const target = `http://localhost:${session.port || 3001}`;
    proxy.web(req, res, { target, changeOrigin: true, ignorePath: false }, (err) => {
      console.error(`[PROXY ERROR] Session ${sessionId} on ${target}:`, err.message);
      if (!res.headersSent) res.status(200).send(getLoadingHtml("Neural Re-Syncing...", sessionId));
    });
  });

  // (b) Asset interceptor — forwards requests originating from inside a
  //     preview iframe to the matching session's dev server. Mounted as
  //     a regular middleware so it runs before Vite's middleware below.
  app.use((req, res, next) => {
    const referer = req.get("referer") || "";
    const m = referer.match(/\/api\/preview\/([0-9a-zA-Z._-]+)/);
    if (!m) return next();
    // Don't hijack our own admin/api routes.
    if (req.path.startsWith("/api/") && !VITE_ASSET_EXT.test(req.path)) return next();
    if (!VITE_ASSET_RE.test(req.path) && !VITE_ASSET_EXT.test(req.path)) return next();
    const sessionId = m[1];
    const session = getSessionData(sessionId);
    if (!session || session.status !== "READY") return next();
    const target = `http://localhost:${session.port || 3001}`;
    proxy.web(req, res, { target, changeOrigin: true, ignorePath: false }, (err) => {
      console.error(`[ASSET-PROXY] ${req.method} ${req.url} -> ${target}: ${err.message}`);
      if (!res.headersSent) next(err);
    });
  });

  // 3.1.5 — Probe E2B reachability (non-blocking; cached result used by /api/status)
  e2bManager.probeConnectivity().catch(() => {});

  // 3.2 Autopilot Initiation
  await setupAutopilot(broadcast);

  // 4. Static Assets / Vite
  if (process.env.NODE_ENV === "production") {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }

  // Single deterministic bind. On Replit (and most container hosts) the public URL
  // is mapped to a single fixed port — relocating to PORT+1 makes the app invisible.
  // If the port is taken we kill the holder ONCE, then bind. No silent relocation.
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`💥 Server error: ${err.code} ${err.message}`);
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is occupied and could not be reclaimed. Exiting.`);
    }
    process.exit(1);
  });

  try {
    const { findPidsOnPort, killPid, isPortFree } = await import("./src/services/portService.js");
    if (!(await isPortFree(PORT))) {
      const pids = (await findPidsOnPort(PORT)).filter(p => p !== process.pid);
      if (pids.length) {
        console.warn(`⚠️ Port ${PORT} occupied by PID(s) ${pids.join(", ")} — reclaiming.`);
        for (const pid of pids) await killPid(pid);
        await new Promise(r => setTimeout(r, 600));
      }
    }
  } catch (e: any) {
    console.warn(`[BOOT] Port preflight skipped: ${e?.message || e}`);
  }

  server.listen(PORT, "0.0.0.0", () => {
    registerNexusPort(PORT);
    console.log(`🚀 Nexus AI Sovereign IDE v8.0 on http://0.0.0.0:${PORT}`);
    console.log(`🔒 Reserved port ${PORT} — sandbox projects will skip it.`);
  });

  // 9.4 — graceful shutdown
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    boot.warn(`received ${sig} — draining…`);
    try { server.close(() => boot.info("HTTP closed")); } catch {}
    try { closeDb(); boot.info("SQLite WAL flushed & closed"); } catch {}
    setTimeout(() => process.exit(0), 1500);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch(console.error);
