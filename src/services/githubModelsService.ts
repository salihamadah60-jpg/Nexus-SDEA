/**
 * GitHub Models — GPT-4o (and friends) via the free GitHub token tier.
 *
 * Endpoint: https://models.inference.ai.azure.com  (OpenAI-compatible)
 * Auth:     `Authorization: Bearer ${GITHUB_TOKEN}`  (any classic PAT works)
 * Free quota: ~50 req/day per model on the free tier; rate-limit resets daily.
 *
 * Multi-key rotation is delegated to keyPoolService — every healthy GitHub
 * token in the pool is tried in order before the call surrenders. On 429 /
 * quota the key gets cooled (60s → 5m → 30m → 6h ladder); on 401 / 403 it's
 * permanently disabled for the process.
 *
 * Returns the same `{ text, model }` envelope every other LLM helper uses so
 * it slots cleanly into orchestratorService attempt chains.
 */
import OpenAI from "openai";
import { keyPool } from "./keyPoolService.js";
import { recordCost } from "./costService.js";
import { nexusLog } from "./logService.js";

const log = nexusLog("github-models");

const GITHUB_MODELS_BASE = "https://models.inference.ai.azure.com";

export type GhModel =
  | "gpt-4o"          // flagship reasoning + code
  | "gpt-4o-mini"     // cheap fast
  | "Phi-3.5-MoE-instruct"
  | "Meta-Llama-3.1-70B-Instruct"
  | "Mistral-large";

export function githubModelsActive(): boolean {
  keyPool.refresh();
  return keyPool.peekAll("github").some(k => !k.disabled);
}

export function githubModelsStatus() {
  keyPool.refresh();
  const keys = keyPool.peekAll("github");
  return {
    active: keys.some(k => !k.disabled),
    keys: keys.length,
    healthy: keys.filter(k => !k.disabled && k.cooldownUntil < Date.now()).length,
    defaultModel: "gpt-4o",
    endpoint: GITHUB_MODELS_BASE,
  };
}

interface CallOpts {
  taskId?: string;
  sessionId?: string;
  jsonOnly?: boolean;
  maxTokens?: number;
  temperature?: number;
  model?: GhModel;
}

/**
 * Call GitHub Models. Iterates through every healthy GitHub key; returns null
 * only when EVERY key has been tried and failed (so the orchestrator falls
 * through to the next provider, never blocking on one bad key).
 */
export async function callGitHubModels(prompt: string, system: string, opts: CallOpts = {}): Promise<{ text: string; model: string } | null> {
  const model = opts.model || "gpt-4o";
  const tried = new Set<string>();
  // Try up to N times (N = number of keys + 1 for jitter)
  const keys = keyPool.peekAll("github").filter(k => !k.disabled);
  if (keys.length === 0) return null;

  for (let attempt = 0; attempt < keys.length + 1; attempt++) {
    const k = keyPool.next("github");
    if (!k || tried.has(k.id)) break;
    tried.add(k.id);

    try {
      const client = new OpenAI({ apiKey: k.value, baseURL: GITHUB_MODELS_BASE });
      const params: any = {
        model,
        max_tokens: opts.maxTokens ?? 1500,
        temperature: opts.temperature ?? 0.2,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      };
      if (opts.jsonOnly) params.response_format = { type: "json_object" };

      const r = await client.chat.completions.create(params);
      const text = r.choices[0]?.message?.content || "";
      const inTok = r.usage?.prompt_tokens || Math.ceil(prompt.length / 4);
      const outTok = r.usage?.completion_tokens || Math.ceil(text.length / 4);

      keyPool.recordSuccess(k, inTok, outTok);
      recordCost({
        sessionId: opts.sessionId, taskId: opts.taskId,
        provider: "github", model, tokensIn: inTok, tokensOut: outTok,
      });
      return { text, model: `github/${model}` };
    } catch (e: any) {
      const code = String(e?.status || e?.code || "unknown");
      keyPool.recordFailure(k, code, e);
      log.warn(`github-models call failed (key ${k.id}, ${code}): ${e?.message?.slice(0, 120)}`);
      // 429/quota → next key. 401/403 → also next key (this one was just hard-disabled).
    }
  }
  log.warn(`github-models exhausted ${tried.size} key(s); falling through`);
  return null;
}
