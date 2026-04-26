/**
 * Sovereign Orchestrator — runs the Blackboard Graph (Planner→Writer→Reviewer→Done/Stasis).
 *
 * This service is callable both from the chat handler and from the new
 * /api/kernel/blackboard/run endpoint. It coordinates:
 *   - Planner: produce atomic JSON sub-task list (Phase 1.2 + Phase 7.2)
 *   - Writer: implement each sub-task one at a time (Phase 1.3)
 *   - Reviewer: LLM critique via auditService (Phase 1.4)
 *   - Self-healing loop: 3 retries, then stasis (Phase 1.5/1.6)
 *
 * Exports a high-level runBlackboard() that returns a final report.
 */
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { keyPool } from "./keyPoolService.js";
import { performLogicAudit } from "./auditService.js";
import { createTask, setPlan, setStatus, recordAudit, bumpRetry, get as getTask, BlackboardTask, PlanStep } from "./blackboardService.js";
import { recordCost } from "./costService.js";
import { minePattern } from "./dnaService.js";
import { eventStream } from "./eventStreamService.js";
import { nexusLog } from "./logService.js";
import { e2bManager } from "./e2bService.js";
import { callDeepseek, deepseekMode } from "./deepseekService.js";
import { callGitHubModels, githubModelsActive } from "./githubModelsService.js";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

// Persist Writer file output into the local session sandbox so the Preview
// pane can render it. Path-traversal-safe (relative paths only).
async function persistWriterFiles(sessionId: string, files: Array<{ path: string; content: string }>) {
  const root = path.join(SANDBOX_BASE, sessionId);
  await fs.mkdir(root, { recursive: true });
  for (const f of files) {
    if (!f?.path || typeof f.content !== "string") continue;
    const safe = path.normalize(f.path).replace(/^([./\\])+/, "");
    const target = path.join(root, safe);
    if (!target.startsWith(root)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, f.content, "utf8");
  }
}

// Phase 12.3 — Sandbox-Ready Gate.
// Records when scaffolding is in-flight for a session. Any code path that
// wants to run shell commands inside a sandbox must `await waitForSandbox(sid)`
// before exec'ing, otherwise npm tar extraction can ENOENT against directories
// the scaffolder is still creating.
const sandboxReady = new Map<string, Promise<void>>();
export function markSandboxBusy(sessionId: string, p: Promise<any>) {
  const wrapped = p.then(() => undefined).catch(() => undefined);
  sandboxReady.set(sessionId, wrapped);
  wrapped.finally(() => {
    if (sandboxReady.get(sessionId) === wrapped) sandboxReady.delete(sessionId);
  });
}
export async function waitForSandbox(sessionId: string): Promise<void> {
  const p = sandboxReady.get(sessionId);
  if (p) await p;
}

// Phase 6.2 — Gemini context-cache: keep last system prompt + ttl per worker so
// successive Writer calls in the same task reuse the cached prefix instead of
// re-uploading it on every step. Best-effort; falls back to plain prompt.
const geminiCache = new Map<string, { id: string; until: number }>();
const GEMINI_CACHE_TTL_MS = 5 * 60_000;

// Phase 6.1 — per-task tier routing. Short / mechanical edits go to the cheap
// model (llama-3.1-8b-instant), heavier reasoning sticks with the 70b.
function pickGroqTier(prompt: string): string {
  const len = prompt.length;
  const heavy = /(refactor|architect|design|optimi[sz]e|database schema|state machine|graph)/i.test(prompt);
  if (heavy || len > 4500) return "llama-3.3-70b-versatile";
  return "llama-3.1-8b-instant";
}

const log = nexusLog("orchestrator");
const GROQ_BASE = "https://api.groq.com/openai/v1";
const MAX_RETRIES = 3;

// Phase 7.3 — micro-agent skill prompts (per-domain)
export const MICRO_AGENT_PROMPTS: Record<string, string> = {
  browser: "You are the BROWSER micro-agent. Write Puppeteer/Playwright probes. Always handle navigation timeouts and wait for selectors.",
  db: "You are the DB micro-agent. Use Mongoose/SQLite schemas with explicit indexes. Never inline credentials.",
  test: "You are the TEST micro-agent. Write Vitest unit tests with arrange/act/assert structure. Mock side effects.",
  css: "You are the CSS micro-agent. Use semantic class names and CSS custom properties. Mobile-first media queries.",
  docker: "You are the DOCKER micro-agent. Multi-stage builds, non-root users, .dockerignore for node_modules.",
};

function pickMicroAgent(goal: string): string | null {
  const g = goal.toLowerCase();
  if (/test|spec|unit/.test(g)) return MICRO_AGENT_PROMPTS.test;
  if (/scrape|browser|puppeteer|playwright/.test(g)) return MICRO_AGENT_PROMPTS.browser;
  if (/database|mongo|sqlite|postgres|schema/.test(g)) return MICRO_AGENT_PROMPTS.db;
  if (/docker|container/.test(g)) return MICRO_AGENT_PROMPTS.docker;
  if (/style|css|tailwind|theme/.test(g)) return MICRO_AGENT_PROMPTS.css;
  return null;
}

// ---------- Planner Node (Phase 1.2 + 7.2) --------------------------------

export interface PlannerOutput {
  steps: Array<{ id: string; description: string; acceptance: string; depends_on: string[] }>;
  raw: string;
  model: string;
}

const PLANNER_SYSTEM = `You are the PLANNER node in the Sovereign Blackboard Graph.
Decompose the user goal into ATOMIC sub-tasks (each can be implemented in one focused edit).
Output STRICT JSON only:
{
  "steps": [
    {"id": "S1", "description": "...", "acceptance": "concrete pass/fail criterion", "depends_on": []},
    {"id": "S2", "description": "...", "acceptance": "...", "depends_on": ["S1"]}
  ]
}
Rules:
- 2-7 steps, never more
- Each step is independently testable
- depends_on uses earlier step ids only
- acceptance MUST be observable (file exists, function returns X, route 200)`;

async function callGroqJson(prompt: string, system: string, taskId?: string, sessionId?: string, modelOverride?: string): Promise<{ text: string; model: string } | null> {
  const model = modelOverride || pickGroqTier(prompt + "\n" + system);
  const tried = new Set<string>();
  for (let attempt = 0; attempt < 4; attempt++) {
    const k = keyPool.next("groq"); if (!k || tried.has(k.id)) return null;
    tried.add(k.id);
    try {
      const client = new OpenAI({ apiKey: k.value, baseURL: GROQ_BASE });
      const r = await client.chat.completions.create({
        model, max_tokens: 1500, temperature: 0.2,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      });
      const text = r.choices[0]?.message?.content || "";
      const inTok = r.usage?.prompt_tokens || prompt.length / 4;
      const outTok = r.usage?.completion_tokens || text.length / 4;
      keyPool.recordSuccess(k, inTok, outTok);
      recordCost({ sessionId, taskId, provider: "groq", model, tokensIn: inTok, tokensOut: outTok });
      return { text, model };
    } catch (e: any) {
      keyPool.recordFailure(k, String(e?.status || "unknown"), e);
      log.warn(`groq call failed (key ${k.id}): ${e?.message?.slice(0, 100)}`);
    }
  }
  return null;
}

async function callGeminiText(prompt: string, system: string, taskId?: string, sessionId?: string, modelName = "gemini-2.0-flash"): Promise<{ text: string; model: string } | null> {
  const tried = new Set<string>();
  for (let attempt = 0; attempt < 4; attempt++) {
    const k = keyPool.next("gemini"); if (!k || tried.has(k.id)) return null;
    tried.add(k.id);
    try {
      const client = new GoogleGenAI({ apiKey: k.value });
      const cacheKey = `${k.id}|${modelName}|${crypto.createHash("sha1").update(system).digest("hex").slice(0, 12)}`;
      const cached = geminiCache.get(cacheKey);
      const useCache = cached && cached.until > Date.now() ? cached.id : undefined;
      const cfg: any = { systemInstruction: system, maxOutputTokens: 2000, temperature: 0.2 };
      if (useCache) cfg.cachedContent = useCache;
      const r: any = await (client as any).models.generateContent({
        model: modelName,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: cfg,
      });
      // Best-effort: if SDK returned a cache id, remember it.
      const newCacheId = r?.cachedContent || r?.cache?.name;
      if (newCacheId && typeof newCacheId === "string") {
        geminiCache.set(cacheKey, { id: newCacheId, until: Date.now() + GEMINI_CACHE_TTL_MS });
      }
      const text = r?.text || r?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const inTok = r?.usageMetadata?.promptTokenCount || prompt.length / 4;
      const outTok = r?.usageMetadata?.candidatesTokenCount || text.length / 4;
      keyPool.recordSuccess(k, inTok, outTok);
      recordCost({ sessionId, taskId, provider: "gemini", model: modelName, tokensIn: inTok, tokensOut: outTok });
      return { text, model: modelName };
    } catch (e: any) {
      keyPool.recordFailure(k, String(e?.status || "unknown"), e);
      log.warn(`gemini call failed (key ${k.id}): ${e?.message?.slice(0, 100)}`);
    }
  }
  return null;
}

export async function runPlanner(goal: string, context = "", taskId?: string, sessionId?: string): Promise<PlannerOutput | null> {
  const micro = pickMicroAgent(goal);
  const sys = micro ? `${PLANNER_SYSTEM}\n\nDOMAIN HINT:\n${micro}` : PLANNER_SYSTEM;
  const prompt = `GOAL:\n${goal}\n\nCONTEXT:\n${context.slice(0, 3000)}`;
  // Phase 11.1 — DeepSeek-reasoner (when configured) gets first crack at the
  // plan; falls back to Gemini Flash, then Groq.
  // Phase 11.2 — Planner cascade: DeepSeek-reasoner → GPT-4o (GitHub Models)
  // → Gemini Flash → Groq. Every helper auto-rotates its provider's key pool
  // on rate-limit / quota errors before surrendering to the next provider.
  const r =
    (deepseekMode() !== "disabled"
      ? await callDeepseek(prompt, sys, { taskId, sessionId, reasoner: true, jsonOnly: true })
      : null) ||
    (githubModelsActive()
      ? await callGitHubModels(prompt, sys, { taskId, sessionId, jsonOnly: true, model: "gpt-4o", maxTokens: 2000 })
      : null) ||
    await callGeminiText(prompt, sys, taskId, sessionId, "gemini-2.0-flash") ||
    await callGroqJson(prompt, sys, taskId, sessionId);
  if (!r) return null;
  const m = r.text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed.steps)) return null;
    return { steps: parsed.steps, raw: r.text, model: r.model };
  } catch { return null; }
}

// ---------- Writer Node (Phase 1.3) ---------------------------------------

const WRITER_SYSTEM = `You are the WRITER node in the Sovereign Blackboard Graph.
Implement EXACTLY ONE sub-task. Output a JSON object with file changes only:
{
  "files": [{"path":"relative/path.ts","content":"<full file content>"}],
  "rationale": "one-sentence why this satisfies the acceptance criterion"
}
Rules:
- COMPLETE file contents only (no truncation, no "// rest of code")
- Don't touch files outside the requested step
- If shell command needed, include "commands": ["npm install foo"] (max 2)`;

export interface WriterOutput {
  files: Array<{ path: string; content: string }>;
  commands: string[];
  rationale: string;
  raw: string;
  model: string;
}

function parseWriterPayload(text: string): { files: any[]; commands: any[]; rationale: string } | null {
  if (!text) return null;
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const candidates: string[] = [body];
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(body.slice(first, last + 1));
  for (const cand of candidates) {
    try {
      const obj = JSON.parse(cand);
      if (obj && (Array.isArray(obj.files) || Array.isArray(obj.commands))) {
        return {
          files: Array.isArray(obj.files) ? obj.files : [],
          commands: Array.isArray(obj.commands) ? obj.commands : [],
          rationale: String(obj.rationale || ""),
        };
      }
    } catch {}
  }
  return null;
}

export async function runWriter(step: PlanStep, goal: string, context: string, audit?: { issues: string[] }, taskId?: string, sessionId?: string): Promise<WriterOutput | null> {
  const fix = audit?.issues?.length
    ? `\n\nPREVIOUS REVIEWER FEEDBACK (you MUST address every issue):\n- ${audit.issues.join("\n- ")}`
    : "";
  const prompt = `OVERALL GOAL: ${goal}

CURRENT STEP (${step.id}): ${step.description}
ACCEPTANCE: ${step.acceptance}

CONTEXT:
${context.slice(0, 4000)}${fix}

Return JSON only. Escape all quotes and newlines inside file "content" strings.`;
  // Phase 11.1 — when DeepSeek is configured (official key or OpenRouter free
  // tier), prefer it for the Writer node since it dominates code-gen benchmarks.
  const dsActive = deepseekMode() !== "disabled";
  const ghActive = githubModelsActive();
  // Phase 11.2 — Writer cascade. GPT-4o slots in right after DeepSeek (both
  // are top-tier coders) and BEFORE the smaller Groq/Gemini fallbacks.
  const attempts: Array<() => Promise<{ text: string; model: string } | null>> = [
    ...(dsActive ? [() => callDeepseek(prompt, WRITER_SYSTEM, { taskId, sessionId, jsonOnly: true })] : []),
    ...(ghActive ? [() => callGitHubModels(prompt, WRITER_SYSTEM, { taskId, sessionId, jsonOnly: true, model: "gpt-4o", maxTokens: 3000 })] : []),
    () => callGroqJson(prompt, WRITER_SYSTEM, taskId, sessionId),
    () => callGeminiText(prompt, WRITER_SYSTEM, taskId, sessionId, "gemini-2.0-flash"),
    ...(ghActive ? [() => callGitHubModels(prompt + "\n\nIMPORTANT: previous attempt produced invalid JSON. Output ONLY valid JSON.", WRITER_SYSTEM, { taskId, sessionId, jsonOnly: true, model: "gpt-4o-mini", maxTokens: 3000 })] : []),
    () => callGroqJson(prompt + "\n\nIMPORTANT: previous attempt produced invalid JSON. Output ONLY valid JSON, no prose, no markdown fences.", WRITER_SYSTEM, taskId, sessionId),
  ];
  let lastRaw = "", lastModel = "";
  for (const attempt of attempts) {
    const r = await attempt();
    if (!r) continue;
    lastRaw = r.text; lastModel = r.model;
    const parsed = parseWriterPayload(r.text);
    if (parsed) {
      return {
        files: parsed.files,
        commands: parsed.commands.slice(0, 2),
        rationale: parsed.rationale,
        raw: r.text,
        model: r.model,
      };
    }
    log.warn(`writer JSON parse failed (model=${r.model}, ${r.text.length}c) — retrying`);
  }
  if (lastRaw) log.warn(`writer exhausted all attempts; last model=${lastModel}, len=${lastRaw.length}`);
  return null;
}

// ---------- Full loop -----------------------------------------------------

export interface BlackboardReport {
  taskId: string;
  status: "done" | "stasis" | "failed";
  task: BlackboardTask;
  artifacts: Array<{ step: string; files: string[]; commands: string[] }>;
  blockers: string[];
}

/** Phase 7.4 — wait until an external caller flips the task out of awaiting_approval. */
async function awaitHitl(taskId: string, timeoutMs = 5 * 60_000): Promise<"approved" | "rejected" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const t = getTask(taskId);
    if (!t) return "rejected";
    if (t.status === "writing") return "approved";
    if (t.status === "failed" || t.status === "stasis") return "rejected";
  }
  return "timeout";
}

export async function runBlackboard(input: { goal: string; sessionId?: string; context?: string; hitl?: boolean }): Promise<BlackboardReport> {
  const t = createTask({ goal: input.goal, sessionId: input.sessionId });
  const ctx = input.context || "";
  setStatus(t.id, "planning");
  eventStream.emit("agent.thought", { taskId: t.id, phase: "planning", goal: input.goal }, { taskId: t.id, sessionId: input.sessionId });

  const planOut = await runPlanner(input.goal, ctx, t.id, input.sessionId);
  if (!planOut) {
    setStatus(t.id, "failed", { reason: "Planner returned no valid output" });
    return { taskId: t.id, status: "failed", task: getTask(t.id)!, artifacts: [], blockers: ["planner_failed"] };
  }
  const plan: PlanStep[] = planOut.steps.map(s => ({
    id: s.id || `S${crypto.randomBytes(2).toString("hex")}`,
    description: s.description,
    acceptance: s.acceptance,
    depends_on: s.depends_on || [],
    status: "todo",
  }));
  setPlan(t.id, plan);

  // Phase 7.4 — Human-in-the-loop checkpoint between epic boundaries. The plan
  // is written; pause for caller approval before any Writer side-effects fire.
  if (input.hitl) {
    setStatus(t.id, "awaiting_approval", { plan });
    eventStream.emit("agent.thought", { taskId: t.id, phase: "awaiting_approval", planSize: plan.length }, { taskId: t.id, sessionId: input.sessionId });
    const verdict = await awaitHitl(t.id);
    if (verdict !== "approved") {
      setStatus(t.id, "failed", { reason: `hitl_${verdict}` });
      return { taskId: t.id, status: "failed", task: getTask(t.id)!, artifacts: [], blockers: [`hitl_${verdict}`] };
    }
  }

  const artifacts: BlackboardReport["artifacts"] = [];
  const blockers: string[] = [];

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    step.status = "in_progress";
    setStatus(t.id, "writing");
    eventStream.emit("agent.thought", { taskId: t.id, step: step.id, phase: "writing" }, { taskId: t.id, sessionId: input.sessionId });

    let lastAudit: { issues: string[]; passed: boolean } | undefined;
    let writerOut: WriterOutput | null = null;
    let stepDone = false;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      writerOut = await runWriter(step, input.goal, ctx, lastAudit, t.id, input.sessionId);
      if (!writerOut) { blockers.push(`writer_failed_${step.id}_attempt_${attempt}`); break; }

      // Persist Writer output to the local session sandbox so the Preview pane
      // can render the result regardless of E2B availability.
      if (input.sessionId && writerOut.files.length > 0) {
        try { await persistWriterFiles(input.sessionId, writerOut.files); }
        catch (e: any) { log.warn(`local persist failed: ${e?.message?.slice(0, 100)}`); }
      }

      // Phase 3.1/3.2/3.3 — when E2B is wired up, mirror writes into the VM and
      // execute the step's commands there. Captured stack traces are pushed
      // back into the reviewer's diagnostic pool for the next attempt.
      let runtimeIssues: string[] = [];
      if (input.sessionId && e2bManager.isActive()) {
        try {
          for (const f of writerOut.files) await e2bManager.writeFile(input.sessionId, f.path, f.content);
          // Phase 12.3 — gate commands behind any pending sandbox scaffold.
          await waitForSandbox(input.sessionId);
          for (const cmd of writerOut.commands) {
            const r = await e2bManager.runCommand(input.sessionId, cmd);
            if (r && (r.exitCode !== 0 || r.stackTrace)) {
              runtimeIssues.push(`E2B ${cmd} exit ${r.exitCode}${r.stackTrace ? `:\n${r.stackTrace.slice(0, 600)}` : ""}`);
              eventStream.emit("obs.error", { taskId: t.id, step: step.id, source: "e2b", cmd, stackTrace: r.stackTrace, exitCode: r.exitCode }, { taskId: t.id, sessionId: input.sessionId });
            }
          }
        } catch (e: any) { log.debug(`e2b runtime probe failed: ${e?.message}`); }
      }

      setStatus(t.id, "reviewing");
      const acceptance = `${input.goal}\nStep ${step.id}: ${step.description}\nAcceptance: ${step.acceptance}${runtimeIssues.length ? `\n\nRUNTIME OBSERVATIONS (E2B):\n- ${runtimeIssues.join("\n- ")}` : ""}`;
      const report = await performLogicAudit(writerOut.files, acceptance);
      if (runtimeIssues.length && report.passed) {
        // runtime spoke; even a passing static audit must address it
        report.passed = false;
        report.issues = [...(report.issues || []), ...runtimeIssues];
      }
      recordAudit(t.id, {
        step: i, passed: report.passed, severity: report.severity, issues: report.issues, reviewerModel: report.reviewerModel, createdAt: Date.now(),
      });
      if (report.passed) {
        step.status = "done";
        step.artifact = { files: writerOut.files.map(f => f.path), commands: writerOut.commands, rationale: writerOut.rationale };
        artifacts.push({ step: step.id, files: writerOut.files.map(f => f.path), commands: writerOut.commands });
        stepDone = true;
        break;
      }
      lastAudit = { issues: report.issues, passed: false };
      bumpRetry(t.id);
      log.warn(`step ${step.id} audit failed (attempt ${attempt + 1}): ${report.issues.slice(0, 2).join("; ")}`);
    }

    if (!stepDone) {
      step.status = "failed";
      blockers.push(`step_${step.id}_stasis`);
      setStatus(t.id, "stasis", { failedStep: step.id, lastIssues: lastAudit?.issues });
      eventStream.emit("obs.error", { taskId: t.id, step: step.id, reason: "stasis after 3 retries" }, { taskId: t.id, sessionId: input.sessionId });
      return { taskId: t.id, status: "stasis", task: getTask(t.id)!, artifacts, blockers };
    }
  }

  setStatus(t.id, "done", { artifacts });
  eventStream.emit("agent.thought", { taskId: t.id, phase: "done", artifactCount: artifacts.length }, { taskId: t.id, sessionId: input.sessionId });

  // Phase 2.5 — DNA mining: store the (intent, summary, diff) of this successful run
  try {
    const diff = artifacts.flatMap(a => [`# step ${a.step}`, ...a.files]).join("\n");
    const summary = plan.map((s, i) => `${i + 1}. ${s.description} → ${s.status}`).join("\n");
    minePattern({
      intent: input.goal,
      summary,
      diff,
      tokensSaved: Math.max(0, 500 + plan.length * 200), // rough estimate
    });
  } catch (e: any) { log.debug(`mine pattern failed: ${e?.message}`); }

  return { taskId: t.id, status: "done", task: getTask(t.id)!, artifacts, blockers: [] };
}

// ─── Shared AI Fix Helpers (used by aiService + autopilotService) ──────────

const FILE_FIX_SYSTEM = `You are a code-repair engine. The user will give you:
1. A file path and its current content
2. An error message or audit issues

Return ONLY the complete fixed file content — no markdown fences, no prose, no explanations.
The output is written directly to disk, so return ONLY the file content.`;

/**
 * Ask a fast AI to fix a single file given an error message.
 * Used by autopilotService when Vite emits a runtime/compile error.
 * Returns the fixed file content string, or null if AI is unavailable.
 */
export async function requestAIFileFix(
  filePath: string,
  fileContent: string,
  errorText: string,
  sessionId?: string,
  taskId?: string
): Promise<string | null> {
  const prompt = `FILE: ${filePath}

ERROR:
${errorText.slice(0, 1200)}

CURRENT CONTENT:
${fileContent.slice(0, 6000)}

Return ONLY the complete corrected file content. No markdown. No explanation.`;

  const r =
    await callGroqJson(prompt, FILE_FIX_SYSTEM, taskId, sessionId) ||
    await callGeminiText(prompt, FILE_FIX_SYSTEM, taskId, sessionId);

  if (!r?.text) return null;

  // Strip any accidental markdown fences the model may have added
  const stripped = r.text
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  return stripped || null;
}

/**
 * Ask a fast AI to regenerate files that failed an audit.
 * Returns the corrected files array, or null if AI is unavailable / parse fails.
 */
export async function requestAuditFix(
  files: Array<{ path: string; content: string }>,
  auditIssues: string[],
  goal: string,
  sessionId?: string,
  taskId?: string
): Promise<Array<{ path: string; content: string }> | null> {
  const AUDIT_FIX_SYSTEM = `You are a code-repair engine in the Nexus Sovereign IDE.
You will receive file(s) that failed an automated logic audit, plus the list of issues.
Return STRICT JSON: {"files":[{"path":"...","content":"<full fixed content>"}]}
Rules:
- Address EVERY issue listed
- COMPLETE file contents only — no truncation, no "// rest of code"
- No prose, no markdown fences outside the JSON`;

  const fileBlock = files.slice(0, 6).map(f =>
    `── ${f.path} ──\n${f.content.slice(0, 3000)}`
  ).join('\n\n');

  const prompt = `GOAL: ${goal.slice(0, 300)}

AUDIT ISSUES (fix ALL of them):
${auditIssues.map((i, n) => `${n + 1}. ${i}`).join('\n')}

PROPOSED FILES:
${fileBlock}

Return JSON only: {"files":[{"path":"...","content":"..."}]}`;

  const r =
    await callGroqJson(prompt, AUDIT_FIX_SYSTEM, taskId, sessionId) ||
    await callGeminiText(prompt, AUDIT_FIX_SYSTEM, taskId, sessionId);

  if (!r?.text) return null;

  const parsed = parseWriterPayload(r.text);
  if (!parsed || parsed.files.length === 0) return null;
  return parsed.files as Array<{ path: string; content: string }>;
}
