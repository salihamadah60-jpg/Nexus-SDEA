import { Router } from "express";
import fs from "fs/promises";
import path from "path";
import { SANDBOX_BASE, NEXUS_MD_PATH } from "../config/backendConstants.js";
import { SOVEREIGN_BACKUP } from "../constants.js";
import { Session, Message } from "../models/Schemas.js";
import { isDbConnected } from "../config/db.js";
import { getFilesRecursive } from "../services/blueprintService.js";
import { createBackup, rollback } from "../services/backupService.js";
import { closeShell } from "../services/terminalService.js";
import { aggregateIdea, getProactiveSuggestions } from "../services/ideationService.js";
import { triggerSessionBoot, getSessionData, killSession } from "../services/autopilotService.js";
import { scaffoldProject } from "../services/scaffoldService.js";
import { e2bManager } from "../services/e2bService.js";
import { validatePath } from "../services/guardService.js";
import { keyPool } from "../services/keyPoolService.js";
import { memorySnapshot, clearSessionMemory } from "../services/memoryService.js";
import { eventStream } from "../services/eventStreamService.js";
import sovereignRoutes from "./sovereign.js";

const router = Router();
router.use("/", sovereignRoutes);
const ephemeralSessions = new Map<string, any>();

router.get("/kernel/ideation/suggestions", async (req, res) => {
  const { sessionId } = req.query;
  try {
    const suggestions = await getProactiveSuggestions(sessionId as string);
    res.json({ suggestions });
  } catch { res.json({ suggestions: [] }); }
});

router.post("/kernel/ideation/note", async (req, res) => {
  const { sessionId, topic, content } = req.body;
  try {
    const idea = await aggregateIdea(sessionId, topic, content);
    res.json({ idea });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to store idea: " + err.message });
  }
});

router.post("/kernel/checkpoint", async (req, res) => {
  const { sessionId, affectedFiles = [] } = req.body;
  try {
    const checkpointId = await createBackup(sessionId, affectedFiles);
    res.json({ checkpointId });
  } catch (err: any) {
    res.status(500).json({ error: "Checkpoint failed: " + err.message });
  }
});

router.post("/kernel/rollback", async (req, res) => {
  const { sessionId, checkpointId } = req.body;
  try {
    await rollback(sessionId, checkpointId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Rollback failed: " + err.message });
  }
});

router.post("/kernel/dna/lessons", async (req, res) => {
  const { lesson, taskId } = req.body;
  const dnaPath = path.join(process.cwd(), "dna.json");
  try {
    const dna = JSON.parse(await fs.readFile(dnaPath, "utf-8"));
    if (!dna.lessons_learned) dna.lessons_learned = [];
    dna.lessons_learned.push({
      topic: `Task Analysis [${taskId}]`,
      lesson: lesson,
      implemented: true,
      timestamp: new Date().toISOString()
    });
    await fs.writeFile(dnaPath, JSON.stringify(dna, null, 2));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "DNA update failed: " + err.message });
  }
});

router.get("/status", (req, res) => {
  const GEMINI_API_KEY = (process.env.NEXUS_AI_KEY || process.env.NEXUS_SECRET_KEY || process.env.NEXUS_KEY || process.env.GEMINI_API_KEY)?.trim();
  const ALT_GEMINI_KEY = process.env.ALT_GEMINI_KEY?.trim();
  const GITHUB_TOKEN = (process.env.GITHUB_GPT || process.env.GITHUB_TOKEN)?.trim();
  const HUGGINGFACE_TOKEN = process.env.HUGGINGFACE_TOKEN?.trim();
  const GROQ_API_KEY = process.env.GROQ_API_KEY?.trim();

  res.json({
    database: isDbConnected() ? "CONNECTED" : "DISCONNECTED",
    github: GITHUB_TOKEN ? "ACTIVE" : "MISSING",
    gemini: (GEMINI_API_KEY || ALT_GEMINI_KEY) ? "ACTIVE" : "MISSING",
    hf: HUGGINGFACE_TOKEN ? "ACTIVE" : "MISSING",
    groq: GROQ_API_KEY ? "ACTIVE" : "MISSING",
  });
});

router.get("/kernel/core", async (req, res) => {
  try {
    const content = await fs.readFile(NEXUS_MD_PATH, "utf-8");
    res.json({ content });
  } catch { res.json({ content: SOVEREIGN_BACKUP }); }
});

router.get("/sessions", async (req, res) => {
  if (!isDbConnected()) return res.json(Array.from(ephemeralSessions.values()));
  try { res.json(await Session.find().sort({ lastModified: -1 })); } catch { res.json([]); }
});

router.get("/sessions/:id", async (req, res) => {
  try {
    const session = await Session.findOne({ sessionId: req.params.id });
    if (session) res.json(session); else res.status(404).json({ error: "Not found" });
  } catch { res.status(500).json({ error: "Fetch error" }); }
});

router.post("/sessions", async (req, res) => {
  const { sessionId, title, messages } = req.body;
  if (!isDbConnected()) {
    const session = { sessionId, title, messages: messages || [], lastModified: new Date() };
    ephemeralSessions.set(sessionId, session);
    return res.json(session);
  }
  try {
    let session = await Session.findOne({ sessionId });
    if (session) {
      if (title !== undefined) session.title = title;
      if (messages !== undefined) session.messages = messages;
      session.lastModified = new Date();
      await session.save();
    } else {
      session = new Session({ sessionId, title, messages: messages || [] });
      await session.save();
    }
    res.json(session);
  } catch { res.status(500).json({ error: "Save error" }); }
});

router.delete("/sessions/:id", async (req, res) => {
  const sessionId = req.params.id;
  await closeShell(sessionId);
  if (!isDbConnected()) {
    ephemeralSessions.delete(sessionId);
    return res.json({ success: true });
  }
  try {
    await Session.deleteOne({ sessionId });
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Delete error" }); }
});

router.get("/files", async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  const sandboxPath = path.join(SANDBOX_BASE, sessionId as string);
  try {
    await fs.mkdir(sandboxPath, { recursive: true });
    res.json(await getFilesRecursive(sandboxPath, sandboxPath));
  } catch { res.status(500).json({ error: "File fetch error" }); }
});

router.get("/files/content", async (req, res) => {
  const { sessionId, path: filePath } = req.query;
  if (!sessionId || !filePath) return res.status(400).json({ error: "sessionId and path required" });
  try {
    const targetPath = await validatePath(sessionId as string, filePath as string);
    const content = await fs.readFile(targetPath, "utf-8");
    return res.json({ content });
  } catch (err: any) { return res.status(403).json({ error: err.message }); }
});

router.post("/files", async (req, res) => {
  const { sessionId, path: filePath, content = "", isFolder } = req.body;
  if (!sessionId || !filePath) return res.status(400).json({ error: "sessionId and path required" });
  try {
    const targetPath = await validatePath(sessionId, filePath, true);
    if (isFolder) {
      await fs.mkdir(targetPath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(403).json({ error: "Operation failed: " + err.message });
  }
});

router.put("/files/rename", async (req, res) => {
  const { sessionId, oldPath, newPath } = req.body;
  if (!sessionId || !oldPath || !newPath) return res.status(400).json({ error: "sessionId, oldPath, newPath required" });
  try {
    const resolvedOld = await validatePath(sessionId, oldPath);
    const resolvedNew = await validatePath(sessionId, newPath, true);
    await fs.rename(resolvedOld, resolvedNew);
    eventStream.emit("action.file.rename", { from: oldPath, to: newPath }, { sessionId });
    res.json({ success: true });
  } catch (err: any) {
    res.status(403).json({ error: "Rename failed: " + err.message });
  }
});

/** Recursive copy (cp -R) — supports the explorer's copy/cut/paste operations. */
router.post("/files/copy", async (req, res) => {
  const { sessionId, srcPath, destPath, move = false } = req.body;
  if (!sessionId || !srcPath || !destPath) return res.status(400).json({ error: "sessionId, srcPath, destPath required" });
  try {
    const resolvedSrc = await validatePath(sessionId, srcPath);
    const resolvedDst = await validatePath(sessionId, destPath, true);
    await fs.mkdir(path.dirname(resolvedDst), { recursive: true });
    if (move) {
      await fs.rename(resolvedSrc, resolvedDst);
      eventStream.emit("action.file.rename", { from: srcPath, to: destPath }, { sessionId });
    } else {
      await fs.cp(resolvedSrc, resolvedDst, { recursive: true, force: true });
      eventStream.emit("action.file.copy", { from: srcPath, to: destPath }, { sessionId });
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(403).json({ error: "Copy failed: " + err.message });
  }
});

/** Quota / key-pool snapshot for the secrets dashboard. Secrets are masked. */
router.get("/kernel/quota", (_req, res) => {
  res.json({
    keyPool: keyPool.snapshot(),
    runtimeUptimeSec: Math.round(process.uptime()),
    memorySessions: memorySnapshot(),
  });
});

router.get("/kernel/memory", (req, res) => {
  res.json({ sessions: memorySnapshot() });
});

router.delete("/kernel/memory/:sessionId", (req, res) => {
  clearSessionMemory(req.params.sessionId);
  res.json({ success: true });
});

/** Event stream tail (SSE-friendly polling endpoint). */
router.get("/kernel/events", (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
  res.json({ events: eventStream.recent({ sessionId, limit }) });
});

router.delete("/files", async (req, res) => {
  const { sessionId, path: filePath } = req.query;
  if (!sessionId || !filePath) return res.status(400).json({ error: "sessionId and path required" });
  try {
    const targetPath = await validatePath(sessionId as string, filePath as string, true);
    await fs.rm(targetPath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (err: any) {
    res.status(403).json({ error: "Delete failed: " + err.message });
  }
});

// Autopilot control endpoints
router.post("/autopilot/boot/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  try {
    const broadcast = (req as any).broadcast || (() => {});
    await triggerSessionBoot(sessionId, broadcast);
    res.json({ success: true, message: "Boot triggered" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/autopilot/status/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const data = getSessionData(sessionId);
  res.json({
    status: data?.status || 'IDLE',
    port: data?.port || 3001,
    hasProcess: !!data?.devProcess
  });
});

router.post("/autopilot/kill/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  killSession(sessionId);
  res.json({ success: true });
});

/**
 * Phase 11.3 — Rebuild sandbox from scratch.
 *
 * Wipes the on-disk session sandbox, kills the dev process, closes any E2B
 * micro-VM, re-scaffolds the template, and (optionally) re-boots autopilot.
 * Body: { template?: "react-vite" | "node-express" | ... , reboot?: boolean }
 */
router.post("/sessions/:sessionId/rebuild-sandbox", async (req, res) => {
  const { sessionId } = req.params;
  const { template = "react-vite", reboot = true } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  const sandboxPath = path.join(SANDBOX_BASE, sessionId);
  const steps: string[] = [];
  try {
    try { killSession(sessionId); steps.push("autopilot killed"); } catch {}
    try { await closeShell(sessionId); steps.push("shell closed"); } catch {}
    try { await e2bManager.closeSandbox(sessionId); steps.push("E2B sandbox closed"); } catch {}
    try {
      await fs.rm(sandboxPath, { recursive: true, force: true });
      steps.push("on-disk sandbox wiped");
    } catch (e: any) { steps.push(`wipe partial: ${e?.message?.slice(0, 80)}`); }

    await fs.mkdir(sandboxPath, { recursive: true });
    await scaffoldProject(sessionId, { template });
    steps.push(`scaffolded ${template}`);

    if (reboot) {
      try {
        await triggerSessionBoot(sessionId, () => {});
        steps.push("autopilot reboot scheduled");
      } catch (e: any) { steps.push(`reboot deferred: ${e?.message?.slice(0, 80)}`); }
    }

    eventStream.emit("agent.thought", { phase: "sandbox_rebuilt", sessionId, template, steps }, { sessionId });
    res.json({ success: true, sessionId, template, steps });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "rebuild failed", steps });
  }
});

router.get("/visual-debug/:sessionId/:snapshot", async (req, res) => {
  const { sessionId, snapshot } = req.params;
  const filePath = path.join(SANDBOX_BASE, sessionId, ".nexus", "snapshots", snapshot);
  try {
    const content = await fs.readFile(filePath);
    res.setHeader("Content-Type", "image/png");
    res.send(content);
  } catch { res.status(404).json({ error: "Snapshot not found" }); }
});

export default router;
