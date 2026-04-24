/**
 * Audit Node — Reviewer using LLM critique (Phase 1.4).
 *
 * Primary: Groq Llama-3.3-70B-versatile (fast + free tier-friendly).
 * Fallback: Gemini Flash. Final fallback: structural regex audit.
 *
 * Returns AuditReport consumed by the orchestrator self-healing loop.
 */
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { keyPool } from "./keyPoolService.js";
import { nexusLog } from "./logService.js";

const log = nexusLog("audit");

export interface AuditReport {
  passed: boolean;
  issues: string[];
  severity: "low" | "medium" | "high";
  reviewerModel: string;
}

interface ProposedFile { path: string; content: string }

const GROQ_BASE = "https://api.groq.com/openai/v1";
const REVIEW_MODEL_GROQ = "llama-3.3-70b-versatile";
const REVIEW_MODEL_GEMINI = "gemini-2.0-flash";

function buildAuditPrompt(files: ProposedFile[], context: string): string {
  const fileBlock = files.slice(0, 6).map(f => {
    const c = f.content.length > 4000 ? f.content.slice(0, 4000) + "\n/* …truncated for review… */" : f.content;
    return `── FILE: ${f.path} ──\n${c}`;
  }).join("\n\n");
  return `You are the REVIEWER node in a multi-agent code-generation loop.
Critically inspect the proposed file changes. Flag REAL issues only:
- syntax errors / unbalanced brackets
- missing imports for symbols that are used
- truncation markers (// ... rest, // TODO, /* code here */)
- runtime crashes (null deref, undefined call)
- security holes (innerHTML with user input, hard-coded secrets)
- broken contract w/ context (e.g. wrong export name)

Return STRICT JSON only, no prose:
{"passed": true|false, "severity":"low"|"medium"|"high", "issues":["..."]}

CONTEXT:
${context.slice(0, 2000)}

PROPOSED CHANGES (${files.length} files):
${fileBlock}`;
}

async function tryGroqReview(prompt: string): Promise<AuditReport | null> {
  const k = keyPool.next("groq");
  if (!k) return null;
  try {
    const client = new OpenAI({ apiKey: k.value, baseURL: GROQ_BASE });
    const resp = await client.chat.completions.create({
      model: REVIEW_MODEL_GROQ,
      messages: [{ role: "system", content: "Strict JSON output only." }, { role: "user", content: prompt }],
      max_tokens: 800,
      temperature: 0.1,
    });
    keyPool.recordSuccess(k, prompt.length, 800);
    const text = resp.choices[0]?.message?.content || "";
    const parsed = parseAuditJson(text);
    if (parsed) return { ...parsed, reviewerModel: `groq/${REVIEW_MODEL_GROQ}` };
    return null;
  } catch (e: any) {
    keyPool.recordFailure(k, String(e?.status || "unknown"), e);
    log.warn(`groq review failed: ${e?.message}`);
    return null;
  }
}

async function tryGeminiReview(prompt: string): Promise<AuditReport | null> {
  const k = keyPool.next("gemini");
  if (!k) return null;
  try {
    const client = new GoogleGenAI({ apiKey: k.value });
    const resp: any = await (client as any).models.generateContent({
      model: REVIEW_MODEL_GEMINI,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 800, temperature: 0.1 },
    });
    keyPool.recordSuccess(k, prompt.length, 800);
    const text = resp?.text || resp?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = parseAuditJson(text);
    if (parsed) return { ...parsed, reviewerModel: `gemini/${REVIEW_MODEL_GEMINI}` };
    return null;
  } catch (e: any) {
    keyPool.recordFailure(k, String(e?.status || "unknown"), e);
    log.warn(`gemini review failed: ${e?.message}`);
    return null;
  }
}

function parseAuditJson(text: string): { passed: boolean; severity: "low"|"medium"|"high"; issues: string[] } | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    return {
      passed: !!obj.passed,
      severity: (["low", "medium", "high"].includes(obj.severity) ? obj.severity : "medium") as any,
      issues: Array.isArray(obj.issues) ? obj.issues.map((s: any) => String(s)).slice(0, 20) : [],
    };
  } catch { return null; }
}

function fallbackStructuralAudit(files: ProposedFile[]): AuditReport {
  const issues: string[] = [];
  for (const f of files) {
    const c = f.content;
    if (/\/\/\s*\.\.\.\s*rest of code|\/\/\s*TODO|\/\*\s*code here\s*\*\//i.test(c)) issues.push(`Truncation in ${f.path}`);
    const opens = (c.match(/{/g) || []).length;
    const closes = (c.match(/}/g) || []).length;
    if (opens !== closes) issues.push(`Bracket imbalance in ${f.path} ({${opens}}/}${closes}})`);
    if (/<motion[\s.]/i.test(c) && !/from\s+["'](framer-motion|motion\/react)["']/.test(c)) {
      issues.push(`<motion> used in ${f.path} without framer-motion import`);
    }
    if (/innerHTML\s*=\s*[^"']*\+/.test(c)) issues.push(`Potential XSS via innerHTML concat in ${f.path}`);
  }
  return { passed: issues.length === 0, issues, severity: issues.length ? "high" : "low", reviewerModel: "fallback/structural" };
}

async function tryGitHubReview(prompt: string): Promise<AuditReport | null> {
  const { callGitHubModels, githubModelsActive } = await import("./githubModelsService.js");
  if (!githubModelsActive()) return null;
  const r = await callGitHubModels(prompt, "Strict JSON output only.", { jsonOnly: true, model: "gpt-4o-mini", maxTokens: 800, temperature: 0.1 });
  if (!r) return null;
  const parsed = parseAuditJson(r.text);
  if (!parsed) return null;
  return { ...parsed, reviewerModel: r.model };
}

export async function performLogicAudit(proposedChanges: ProposedFile[], context: string = ""): Promise<AuditReport> {
  if (proposedChanges.length === 0) return { passed: true, issues: [], severity: "low", reviewerModel: "noop" };
  const prompt = buildAuditPrompt(proposedChanges, context);
  // Reviewer cascade: Groq Llama (fast) → Gemini Flash → GPT-4o-mini.
  // Each helper auto-rotates its provider's keys before surrendering.
  const groq = await tryGroqReview(prompt);
  if (groq) return groq;
  const gem = await tryGeminiReview(prompt);
  if (gem) return gem;
  const gh = await tryGitHubReview(prompt);
  if (gh) return gh;
  log.warn(`no LLM reviewer available, falling back to structural audit`);
  return fallbackStructuralAudit(proposedChanges);
}
