/**
 * Sovereign API routes — Phase 8 surfaces + production endpoints.
 *
 * Mounted at /api by server.ts (sub-routed by api.ts main router).
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";
import { runBlackboard, requestAIFileFix } from "../services/orchestratorService.js";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { listSessionTasks, get as getTask, approveTask } from "../services/blackboardService.js";
import { validateKey, ValidationResult } from "../services/keyValidatorService.js";
import { keyPool } from "../services/keyPoolService.js";
import { createCheckpoint, listCheckpoints, rollbackToCheckpoint, pruneCheckpoints } from "../services/checkpointService.js";
import { listActivePatterns, listArchivedPatterns, dnaStats, recordReuseOutcome, coldArchive, verifyChecksum } from "../services/dnaService.js";
import { runQuadGates } from "../services/quadGateService.js";
import { runNpmAudit, verifyDnaChecksum } from "../services/securityService.js";
import { sessionCost, globalCostSummary } from "../services/costService.js";
import { indexSession, retrieve, renderContext } from "../services/ragService.js";
import { symbolStats } from "../services/symbolService.js";
import { db } from "../services/stateDb.js";
import { isDbConnected } from "../config/db.js";
import { nexusLog } from "../services/logService.js";
import { deepseekStatus } from "../services/deepseekService.js";
import { githubModelsStatus } from "../services/githubModelsService.js";

const log = nexusLog("api.sovereign");
const router = Router();

// Phase 9.1 — rate limit on chat-like endpoints (per IP)
export const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded. Please slow down." },
});

// --- Blackboard ----------------------------------------------------------

router.post("/blackboard/run", async (req, res) => {
  const { goal, sessionId, context } = req.body || {};
  if (!goal) return res.status(400).json({ error: "goal required" });
  try {
    const report = await runBlackboard({ goal, sessionId, context });
    res.json(report);
  } catch (e: any) {
    log.error(`blackboard run error: ${e?.message}`);
    res.status(500).json({ error: e.message });
  }
});

router.get("/blackboard/tasks", (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  res.json({ tasks: listSessionTasks(sessionId) });
});

router.get("/blackboard/task/:id", (req, res) => {
  const t = getTask(req.params.id);
  if (!t) return res.status(404).json({ error: "not found" });
  res.json(t);
});

// Phase 7.4 — HITL: caller (UI or CI) approves/rejects a paused plan.
router.post("/blackboard/approve", (req, res) => {
  const { taskId, approved, note } = req.body || {};
  if (!taskId || typeof approved !== "boolean") return res.status(400).json({ error: "taskId + approved required" });
  const ok = approveTask(taskId, approved, note);
  if (!ok) return res.status(409).json({ error: "task not awaiting approval" });
  res.json({ ok: true });
});

// Phase 10.1 — First-Run Key Setup: persist arbitrary env vars to .env.local.
//
// Naming rules are deliberately loose: any valid POSIX env identifier works
// (`[A-Za-z_][A-Za-z0-9_]*`). Power users add raw GITHUB_PAT / OPENROUTER_X /
// FOO_BAR with no UPPER_SNAKE_CASE constraint. Two superpowers:
//   - `autoSuffix:true`  → if the name already exists, pick the next free
//     numeric suffix (FOO → FOO_2 → FOO_3 …). Lets you click "Add" five times
//     for five Google keys without renaming each one yourself.
//   - `overwrite:true`   → opposite intent: replace whatever is there.
// Default behavior (neither flag) overwrites — same as before.

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

async function readEnvFile(envPath: string): Promise<string> {
  try { return await fs.readFile(envPath, "utf-8"); } catch { return ""; }
}

function pickFreeName(body: string, base: string): string {
  const has = (n: string) => new RegExp(`^${n}=`, "m").test(body) || !!process.env[n];
  if (!has(base)) return base;
  // Strip trailing _N if present so FOO_2 grows into FOO_3, not FOO_2_2.
  const m = base.match(/^(.*?)(?:_(\d+))?$/);
  const stem = m?.[1] || base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}_${i}`;
    if (!has(candidate)) return candidate;
  }
  return `${stem}_${Date.now()}`;
}

async function writeOneEnv(envPath: string, body: string, name: string, value: string): Promise<string> {
  const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const re = new RegExp(`^${name}=.*$`, "m");
  const next = re.test(body)
    ? body.replace(re, `${name}="${escaped}"`)
    : `${body}${body && !body.endsWith("\n") ? "\n" : ""}${name}="${escaped}"\n`;
  await fs.writeFile(envPath, next, { mode: 0o600 });
  process.env[name] = String(value);
  return next;
}

/** Surgically remove a single NAME=… line from .env.local + process.env. */
async function removeOneEnv(envPath: string, body: string, name: string): Promise<string> {
  const re = new RegExp(`^${name}=.*\\r?\\n?`, "m");
  const next = body.replace(re, "");
  await fs.writeFile(envPath, next, { mode: 0o600 });
  delete process.env[name];
  return next;
}

router.post("/kernel/env-key", async (req, res) => {
  const { name, value, autoSuffix, validate = true } = req.body || {};
  if (!name || value === undefined || value === null) return res.status(400).json({ error: "name + value required" });
  if (!ENV_NAME_RE.test(String(name))) return res.status(400).json({ error: "name must match [A-Za-z_][A-Za-z0-9_]*" });
  const v = String(value).trim();
  if (v.length === 0) return res.status(400).json({ error: "value cannot be empty" });
  if (v.length > 8192) return res.status(400).json({ error: "value too long (>8 KiB)" });

  const envPath = path.join(process.cwd(), ".env.local");
  let body = await readEnvFile(envPath);
  const finalName = autoSuffix ? pickFreeName(body, String(name)) : String(name);
  body = await writeOneEnv(envPath, body, finalName, v);
  log.info(`env-key ${finalName} written → .env.local (live)`);

  let validation: ValidationResult | null = null;
  let removed = false;
  if (validate) {
    validation = await validateKey(finalName, v);
    if (validation.verdict === "invalid") {
      await removeOneEnv(envPath, body, finalName);
      removed = true;
      log.warn(`env-key ${finalName} REMOVED — ${validation.detail}`);
    }
    keyPool.refresh(true);
  }
  res.json({ ok: !removed, name: finalName, removed, validation, restartRequired: false });
});

// Plural: bulk-push many keys in one call. Each entry is processed sequentially
// against the latest file body so autoSuffix works correctly across the batch.
router.post("/kernel/env-keys", async (req, res) => {
  const { keys, validate = true } = req.body || {};
  if (!Array.isArray(keys) || keys.length === 0) return res.status(400).json({ error: "keys[] required" });
  if (keys.length > 64) return res.status(400).json({ error: "max 64 keys per call" });

  const envPath = path.join(process.cwd(), ".env.local");
  let body = await readEnvFile(envPath);
  const written: Array<{ requested: string; final: string; value: string }> = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const entry of keys) {
    const name = entry?.name && String(entry.name).trim();
    const valueRaw = entry?.value;
    if (!name || valueRaw === undefined || valueRaw === null) {
      errors.push({ name: name || "(blank)", error: "name + value required" });
      continue;
    }
    if (!ENV_NAME_RE.test(name)) { errors.push({ name, error: "invalid name" }); continue; }
    const v = String(valueRaw).trim();
    if (v.length === 0) { errors.push({ name, error: "empty value" }); continue; }
    if (v.length > 8192) { errors.push({ name, error: "value too long" }); continue; }
    const finalName = entry?.autoSuffix ? pickFreeName(body, name) : name;
    body = await writeOneEnv(envPath, body, finalName, v);
    written.push({ requested: name, final: finalName, value: v });
    log.info(`env-key ${finalName} written → .env.local (live, bulk)`);
  }

  // Validate written keys in parallel; surgically remove any 4xx-rejected ones.
  const results: Array<{ requested: string; final: string; kept: boolean; validation: ValidationResult }> = [];
  if (validate && written.length > 0) {
    const verdicts = await Promise.all(written.map(w => validateKey(w.final, w.value)));
    for (let i = 0; i < written.length; i++) {
      const w = written[i]; const v = verdicts[i];
      if (v.verdict === "invalid") {
        body = await removeOneEnv(envPath, body, w.final);
        log.warn(`env-key ${w.final} REMOVED — ${v.detail}`);
        results.push({ requested: w.requested, final: w.final, kept: false, validation: v });
      } else {
        results.push({ requested: w.requested, final: w.final, kept: true, validation: v });
      }
    }
    keyPool.refresh(true);
  } else {
    for (const w of written) results.push({
      requested: w.requested, final: w.final, kept: true,
      validation: { verdict: "unknown", provider: null, detail: "validation skipped" },
    });
  }

  const kept = results.filter(r => r.kept).length;
  const dropped = results.length - kept;
  res.json({
    ok: errors.length === 0 && dropped === 0,
    results,
    written: results.filter(r => r.kept).map(r => ({ requested: r.requested, final: r.final })),
    removed: results.filter(r => !r.kept).map(r => ({ requested: r.requested, final: r.final, reason: r.validation.detail })),
    errors,
    restartRequired: false,
  });
});

// Sweep every key currently in process.env: validate + drop the 4xx ones from
// .env.local. Useful for cleaning up stale/revoked keys without a UI round trip.
router.post("/kernel/env-keys/sweep", async (_req, res) => {
  const envPath = path.join(process.cwd(), ".env.local");
  let body = await readEnvFile(envPath);
  const candidates: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (!/^(GEMINI_|GOOGLE_AI_|GAK|NEXUS_AI_|ALT_GEMINI_|GROQ_|GITHUB_TOKEN|GITHUB_GPT|GITHUB_MODELS_|GITHUB_PAT|HUGGINGFACE_|HF_TOKEN|OPENROUTER)/.test(name)) continue;
    candidates.push({ name, value: String(value) });
  }
  const verdicts = await Promise.all(candidates.map(c => validateKey(c.name, c.value)));
  const removed: string[] = [];
  const kept: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (verdicts[i].verdict === "invalid") {
      body = await removeOneEnv(envPath, body, candidates[i].name);
      removed.push(candidates[i].name);
      log.warn(`sweep removed ${candidates[i].name}: ${verdicts[i].detail}`);
    } else {
      kept.push(candidates[i].name);
    }
  }
  keyPool.refresh(true);
  res.json({ scanned: candidates.length, kept, removed });
});

// --- Checkpoints ---------------------------------------------------------

router.post("/checkpoints/create", async (req, res) => {
  const { sessionId, description } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  try {
    const id = await createCheckpoint(sessionId, description || "manual");
    if (!id) return res.status(400).json({ error: "checkpoint skipped — sandbox not yet initialised for this session" });
    res.json({ id });
  } catch (e: any) {
    log.error(`checkpoint create: ${e?.message}`);
    res.status(500).json({ error: e?.message || "checkpoint failed" });
  }
});
router.get("/checkpoints/:sessionId", (req, res) => {
  res.json({ checkpoints: listCheckpoints(req.params.sessionId) });
});
router.post("/checkpoints/rollback", async (req, res) => {
  const { sessionId, checkpointId } = req.body || {};
  const ok = await rollbackToCheckpoint(sessionId, checkpointId);
  res.json({ success: ok });
});
router.post("/checkpoints/prune", async (req, res) => {
  const { sessionId, keep } = req.body || {};
  const removed = await pruneCheckpoints(sessionId, keep || 10);
  res.json({ removed });
});

// --- DNA / Knowledge Vault -----------------------------------------------

router.get("/dna/active", (_req, res) => res.json({ patterns: listActivePatterns(), stats: dnaStats() }));
router.get("/dna/archived", (_req, res) => res.json({ patterns: listArchivedPatterns() }));
router.post("/dna/record-outcome", (req, res) => {
  const { id, success } = req.body || {};
  recordReuseOutcome(id, !!success);
  res.json({ ok: true });
});
router.post("/dna/cold-archive", async (_req, res) => res.json(await coldArchive()));
router.get("/dna/verify/:id", (req, res) => {
  const p: any = db().prepare(`SELECT * FROM dna_patterns WHERE id=?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json({ ok: verifyChecksum(p), checksum: p.checksum });
});

// --- RAG -----------------------------------------------------------------

router.post("/rag/index", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  res.json(await indexSession(sessionId));
});
router.post("/rag/query", async (req, res) => {
  const { sessionId, q, topK } = req.body || {};
  if (!sessionId || !q) return res.status(400).json({ error: "sessionId+q required" });
  const hits = await retrieve(sessionId, q, topK || 6);
  res.json({ hits, rendered: renderContext(hits) });
});
router.get("/rag/stats/:sessionId", (req, res) => res.json(symbolStats(req.params.sessionId)));

// --- Quad-Gates ----------------------------------------------------------

router.post("/quadgates/run", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  res.json(await runQuadGates(sessionId));
});

// --- Security ------------------------------------------------------------

router.post("/security/npm-audit", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  res.json(await runNpmAudit(sessionId));
});
router.get("/security/dna-checksum", async (_req, res) => res.json(await verifyDnaChecksum()));

// --- Cost ----------------------------------------------------------------

router.get("/cost/session/:sessionId", (req, res) => res.json(sessionCost(req.params.sessionId)));
router.get("/cost/summary", (req, res) => {
  const hours = parseInt(String(req.query.hours || "24"), 10) || 24;
  res.json(globalCostSummary(hours));
});

// --- Deployment Readiness (Phase 9.5) ------------------------------------

router.get("/deploy/readiness", async (_req, res) => {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  // 1. SQLite state DB
  let dbOk = false;
  try { db().prepare("SELECT 1").get(); dbOk = true; } catch (e: any) { }
  checks.push({ name: "sqlite", ok: dbOk, detail: dbOk ? "State DB healthy" : "SQLite unavailable" });

  // 2. DNA integrity
  const dnaCk = await verifyDnaChecksum();
  checks.push({ name: "dna_integrity", ok: !!dnaCk.ok, detail: dnaCk.ok ? "DNA checksum verified" : `Mismatch: expected ${(dnaCk.expected || "").slice(0, 8)}…` });

  // 3. At least one healthy AI provider key
  const snap = keyPool.snapshot();
  const healthyProviders = Object.entries(snap).filter(([, keys]) => (keys as any[]).some((k: any) => k.healthy));
  const hasProvider = healthyProviders.length > 0;
  checks.push({ name: "ai_provider", ok: hasProvider, detail: hasProvider ? `Healthy providers: ${healthyProviders.map(([p]) => p).join(", ")}` : "No healthy AI provider keys configured" });

  // 4. MongoDB / ephemeral mode (non-blocking)
  const mongoOk = isDbConnected();
  checks.push({ name: "mongo", ok: mongoOk, detail: mongoOk ? "MongoDB connected" : "Running in ephemeral mode (no MONGODB_URI)" });

  // 5. No in-flight stasis tasks
  let stasisCount = 0;
  try {
    const row = db().prepare(`SELECT COUNT(*) as n FROM tasks WHERE status='stasis'`).get() as any;
    stasisCount = row?.n || 0;
  } catch {}
  checks.push({ name: "no_stasis_tasks", ok: stasisCount === 0, detail: stasisCount === 0 ? "No stalled tasks" : `${stasisCount} task(s) in stasis — investigate before deploy` });

  // 6. E2B or local sandbox configured
  const sandboxFlavor = process.env.E2B_API_KEY ? "e2b" : "local";
  checks.push({ name: "sandbox", ok: true, detail: `Execution sandbox: ${sandboxFlavor}` });

  const critical = checks.filter(c => ["sqlite", "ai_provider"].includes(c.name));
  const ready = critical.every(c => c.ok);
  const score = Math.round((checks.filter(c => c.ok).length / checks.length) * 100);

  res.json({ ready, score, checks, sandbox: sandboxFlavor, ts: new Date().toISOString() });
});

// Phase 10.4 — POST webhook: external CI hits this with the shared secret and
// receives the same readiness JSON as the GET endpoint. The shared GET handler
// is reused via res.locals so behavior stays in lockstep.
router.post("/deploy/readiness", async (req, res) => {
  const expected = (process.env.NEXUS_WEBHOOK_SECRET || "").trim();
  if (!expected) return res.status(503).json({ error: "NEXUS_WEBHOOK_SECRET not configured" });
  const provided = String(req.headers["x-nexus-webhook-secret"] || req.body?.secret || "").trim();
  if (provided !== expected) return res.status(401).json({ error: "invalid webhook secret" });
  // Re-emit by calling the GET handler logic directly via a sub-request.
  // To avoid duplication we forward to the implementation by re-using fetch-style logic:
  req.url = "/deploy/readiness"; req.method = "GET";
  return (router as any).handle(req, res, () => {});
});

// --- Health (Phase 9.3) --------------------------------------------------

router.get("/health", async (_req, res) => {
  const providers = keyPool.snapshot();
  const providerHealth: Record<string, { keys: number; healthy: number }> = {};
  for (const [k, v] of Object.entries(providers)) {
    providerHealth[k] = { keys: (v as any[]).length, healthy: (v as any[]).filter(x => x.healthy).length };
  }
  let dbOk = false;
  try { db().prepare("SELECT 1").get(); dbOk = true; } catch {}
  const dnaCk = await verifyDnaChecksum();
  res.json({
    status: dbOk && Object.values(providerHealth).some(p => p.healthy > 0) ? "ok" : "degraded",
    uptimeSec: Math.round(process.uptime()),
    mongo: isDbConnected() ? "connected" : "disconnected",
    sqlite: dbOk ? "ok" : "down",
    dnaIntegrity: dnaCk.ok ? "ok" : "MISMATCH",
    providers: providerHealth,
    sandbox: !!process.env.E2B_API_KEY ? "e2b" : "local",
    deepseek: deepseekStatus(),
    githubModels: githubModelsStatus(),
  });
});

router.get("/deepseek/status", (_req, res) => res.json(deepseekStatus()));
router.get("/github-models/status", (_req, res) => res.json(githubModelsStatus()));

// Live ping — confirms the GitHub Models endpoint actually returns a token.
// Surfaces an actionable hint when the most common failure mode (missing
// `models` PAT scope) is detected so the user knows exactly what to fix.
router.get("/github-models/ping", async (_req, res) => {
  const { callGitHubModels } = await import("../services/githubModelsService.js");
  const r = await callGitHubModels("Reply with exactly: SOVEREIGN", "You are a single-word echoer.", { maxTokens: 5, temperature: 0 });
  if (!r) {
    const status = githubModelsStatus();
    return res.status(503).json({
      ok: false,
      reason: "all GitHub Models keys rejected by endpoint",
      hint: "Each GitHub PAT used for Models needs the `models:read` permission. Generate a NEW fine-grained token at https://github.com/settings/tokens?type=beta with the `Models` permission set to Read-only, then put it back into GITHUB_TOKEN / GITHUB_GPT / ALT_GITHUB_GPT and POST /api/keypool/reset to revive the keys without restarting.",
      status,
    });
  }
  res.json({ ok: true, model: r.model, text: r.text.trim().slice(0, 80) });
});

// Re-enable hard-disabled keys after the user fixes their PAT/secret value.
router.post("/keypool/reset", (req, res) => {
  const provider = req.body?.provider;
  keyPool.refresh(true);
  const out = keyPool.resetDisabled(provider);
  res.json({ ok: true, ...out, provider: provider || "all" });
});

// ── Self-Healing: on-demand retry ─────────────────────────────────────────
// POST /api/kernel/heal/retry
// Body: { sessionId, filePath, errorHint? }
// Reads the file from the sandbox, calls requestAIFileFix, writes the result,
// and returns { success, filePath, detail }.
router.post("/heal/retry", async (req, res) => {
  const { sessionId, filePath, errorHint } = req.body || {};
  if (!sessionId || !filePath) {
    return res.status(400).json({ error: "sessionId and filePath are required" });
  }

  // Path-traversal guard: resolve inside sandbox only
  const sandboxRoot = path.join(SANDBOX_BASE, sessionId);
  const safeRel = path.normalize(filePath).replace(/^([./\\])+/, "");
  const absPath = path.join(sandboxRoot, safeRel);
  if (!absPath.startsWith(sandboxRoot)) {
    return res.status(400).json({ error: "filePath escapes sandbox" });
  }

  let current: string;
  try {
    current = await fs.readFile(absPath, "utf-8");
  } catch (e: any) {
    return res.status(404).json({ error: `Cannot read file: ${e.message}` });
  }

  const errorText = errorHint || "Vite / TypeScript build error — fix all syntax and import issues.";

  try {
    const fixed = await requestAIFileFix(safeRel, current, errorText, sessionId);
    if (!fixed) {
      return res.status(503).json({ success: false, detail: "AI returned no fix (key exhausted or rate-limited)" });
    }
    await fs.writeFile(absPath, fixed, "utf-8");
    log.info(`heal/retry: fixed ${safeRel} (${fixed.length}c) for session ${sessionId.slice(-8)}`);
    return res.json({ success: true, filePath: safeRel, detail: `AI self-healer rewrote ${safeRel} (${fixed.length} chars) — Vite HMR should reload.` });
  } catch (e: any) {
    log.error(`heal/retry error: ${e?.message}`);
    return res.status(500).json({ success: false, detail: e.message });
  }
});

export default router;
