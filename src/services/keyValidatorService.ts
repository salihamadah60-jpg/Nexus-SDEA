/**
 * Live key validation — pings each provider's lightest read endpoint to confirm
 * a key is genuine before persisting it. Used by `/api/kernel/env-key{,s}` to
 * implement "keep if valid, drop if not".
 *
 * Network calls are capped at 6 s. Network errors (DNS, timeout, 5xx) are
 * treated as INDETERMINATE — we keep the key in that case rather than punishing
 * the user for a transient outage. Only a clear 4xx auth failure removes it.
 */
export type ValidationVerdict = "valid" | "invalid" | "unknown";

export interface ValidationResult {
  verdict: ValidationVerdict;
  provider: string | null;
  detail: string;
  status?: number;
}

export type ProviderId = "gemini" | "groq" | "github" | "huggingface" | "openrouter" | "unknown";

// Substring fingerprints — far more forgiving than strict regex so that
// GEMINI_API_KEY_TEST, my_gemini_key_2, GAK1, alt-gemini-staging all route to
// the gemini validator. Order matters: more specific first.
const NAME_HINTS: Array<[ProviderId, RegExp]> = [
  ["openrouter",  /openrouter/i],
  ["huggingface", /(?:^|[_\W])(hf|huggingface)(?:[_\W]|$)/i],
  ["github",      /github/i],
  ["groq",        /groq/i],
  ["gemini",      /(gemini|google[_-]?ai|gak[_-]?\d|nexus[_-]?ai[_-]?key|google[_-]?api[_-]?key|google[_-]?gen)/i],
];

export function detectProvider(name: string): ProviderId {
  for (const [id, re] of NAME_HINTS) if (re.test(name)) return id;
  return "unknown";
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 6000): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

function classify(status: number, providerLabel: string): ValidationResult {
  if (status >= 200 && status < 300) return { verdict: "valid",   provider: providerLabel, detail: `HTTP ${status}`,   status };
  if (status === 401 || status === 403) return { verdict: "invalid", provider: providerLabel, detail: `auth rejected (HTTP ${status})`, status };
  if (status === 400) return { verdict: "invalid", provider: providerLabel, detail: `bad request — likely malformed key`, status };
  if (status === 429) return { verdict: "valid",   provider: providerLabel, detail: `rate-limited but accepted (HTTP 429)`, status };
  return { verdict: "unknown", provider: providerLabel, detail: `HTTP ${status} (treated as unknown)`, status };
}

async function pingGemini(value: string): Promise<ValidationResult> {
  try {
    const r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(value)}`,
      { method: "GET" }
    );
    return classify(r.status, "gemini");
  } catch (e: any) { return { verdict: "unknown", provider: "gemini", detail: `network: ${e?.message?.slice(0, 60)}` }; }
}

async function pingGroq(value: string): Promise<ValidationResult> {
  try {
    const r = await fetchWithTimeout(`https://api.groq.com/openai/v1/models`, {
      method: "GET", headers: { Authorization: `Bearer ${value}` },
    });
    return classify(r.status, "groq");
  } catch (e: any) { return { verdict: "unknown", provider: "groq", detail: `network: ${e?.message?.slice(0, 60)}` }; }
}

async function pingGithub(value: string): Promise<ValidationResult> {
  try {
    const r = await fetchWithTimeout(`https://api.github.com/user`, {
      method: "GET",
      headers: { Authorization: `Bearer ${value}`, Accept: "application/vnd.github+json", "User-Agent": "nexus-validator" },
    });
    return classify(r.status, "github");
  } catch (e: any) { return { verdict: "unknown", provider: "github", detail: `network: ${e?.message?.slice(0, 60)}` }; }
}

async function pingHuggingFace(value: string): Promise<ValidationResult> {
  try {
    const r = await fetchWithTimeout(`https://huggingface.co/api/whoami-v2`, {
      method: "GET", headers: { Authorization: `Bearer ${value}` },
    });
    return classify(r.status, "huggingface");
  } catch (e: any) { return { verdict: "unknown", provider: "huggingface", detail: `network: ${e?.message?.slice(0, 60)}` }; }
}

async function pingOpenRouter(value: string): Promise<ValidationResult> {
  try {
    const r = await fetchWithTimeout(`https://openrouter.ai/api/v1/auth/key`, {
      method: "GET", headers: { Authorization: `Bearer ${value}` },
    });
    return classify(r.status, "openrouter");
  } catch (e: any) { return { verdict: "unknown", provider: "openrouter", detail: `network: ${e?.message?.slice(0, 60)}` }; }
}

/** Validate against the matching provider; unknown name → verdict "unknown". */
export async function validateKey(name: string, value: string): Promise<ValidationResult> {
  const provider = detectProvider(name);
  switch (provider) {
    case "gemini":      return pingGemini(value);
    case "groq":        return pingGroq(value);
    case "github":      return pingGithub(value);
    case "huggingface": return pingHuggingFace(value);
    case "openrouter":  return pingOpenRouter(value);
    default:            return { verdict: "unknown", provider: null, detail: "no validator for this name pattern (kept as-is)" };
  }
}
