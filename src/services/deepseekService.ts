/**
 * DeepSeek Hybrid Service — Phase 11.1
 *
 * Key-aware integration:
 *   - DEEPSEEK_API_KEY  → official DeepSeek API (api.deepseek.com, model "deepseek-chat" / "deepseek-reasoner")
 *   - else OPENROUTER_API_KEY → OpenRouter free tier (deepseek/deepseek-chat-v3.1:free)
 *   - else null  → caller falls back to existing Groq/Gemini path
 *
 * Returns the same {text, model} envelope every other LLM helper uses, so it
 * drops cleanly into orchestratorService.runWriter / runPlanner attempt chains.
 */
import OpenAI from "openai";
import { recordCost } from "./costService.js";
import { nexusLog } from "./logService.js";

const log = nexusLog("deepseek");

const DEEPSEEK_BASE = "https://api.deepseek.com";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export type DeepseekMode = "official" | "openrouter" | "disabled";

// Last model that was successfully invoked through OpenRouter `auto` routing.
// Surfaced via /api/deepseek/status so the UI badge can show what was picked.
let lastAutoModel: string | null = null;

export function deepseekMode(): DeepseekMode {
  if (process.env.DEEPSEEK_API_KEY) return "official";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  return "disabled";
}

export function deepseekStatus() {
  const mode = deepseekMode();
  // For OpenRouter we always advertise the `auto` router as the requested model;
  // `lastResolvedModel` tells the UI which concrete backbone the router picked
  // on the most recent call (e.g. deepseek/deepseek-chat-v3.1, anthropic/..., etc).
  const requested =
    mode === "official" ? "deepseek-chat"
    : mode === "openrouter" ? "openrouter/auto"
    : null;
  return {
    mode,
    active: mode !== "disabled",
    model: requested,
    requestedModel: requested,
    lastResolvedModel: mode === "openrouter" ? lastAutoModel : requested,
    source:
      mode === "official" ? DEEPSEEK_BASE
      : mode === "openrouter" ? OPENROUTER_BASE
      : null,
  };
}

interface CallOpts {
  taskId?: string;
  sessionId?: string;
  reasoner?: boolean;   // hint: prefer the reasoner model when true
  jsonOnly?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export async function callDeepseek(prompt: string, system: string, opts: CallOpts = {}): Promise<{ text: string; model: string } | null> {
  const mode = deepseekMode();
  if (mode === "disabled") return null;

  const apiKey = mode === "official" ? process.env.DEEPSEEK_API_KEY! : process.env.OPENROUTER_API_KEY!;
  const baseURL = mode === "official" ? DEEPSEEK_BASE : OPENROUTER_BASE;
  // OpenRouter `openrouter/auto` lets OpenRouter pick the best model per call
  // (DeepSeek for code, Claude for reasoning, Llama for cheap, etc).
  const model =
    mode === "official"
      ? (opts.reasoner ? "deepseek-reasoner" : "deepseek-chat")
      : "openrouter/auto";

  try {
    const client = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: mode === "openrouter"
        ? { "HTTP-Referer": "https://nexus.local", "X-Title": "Nexus AI Sovereign IDE" }
        : undefined,
    });
    const params: any = {
      model,
      max_tokens: opts.maxTokens ?? 1500,
      temperature: opts.temperature ?? 0.2,
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    };
    if (opts.jsonOnly && mode === "official") params.response_format = { type: "json_object" };
    const r = await client.chat.completions.create(params);
    const text = r.choices[0]?.message?.content || "";
    const inTok = r.usage?.prompt_tokens || Math.ceil(prompt.length / 4);
    const outTok = r.usage?.completion_tokens || Math.ceil(text.length / 4);
    // OpenRouter returns the actual model it routed to in `r.model` — capture it.
    const resolvedModel = (r as any).model || model;
    if (mode === "openrouter") lastAutoModel = resolvedModel;
    recordCost({
      sessionId: opts.sessionId, taskId: opts.taskId,
      provider: mode === "official" ? "deepseek" : "openrouter",
      model: resolvedModel, tokensIn: inTok, tokensOut: outTok,
    });
    return { text, model: `${mode === "official" ? "deepseek" : "openrouter"}/${resolvedModel}` };
  } catch (e: any) {
    log.warn(`deepseek (${mode}) call failed: ${e?.message?.slice(0, 140)}`);
    return null;
  }
}
