/**
 * Nexus Key Pool — Multi-key rotation with quota tracking & cooldowns.
 *
 * Scans process.env for variants of each provider key (e.g. GEMINI_API_KEY,
 * GEMINI_API_KEY_1, GEMINI_API_KEY_2, GEMINI_KEY_A, GAK_1, GAK_2, ...) and
 * exposes a round-robin / health-aware selector.
 *
 * Per-key state tracked:
 *   - calls            total successful calls
 *   - failures         consecutive failures
 *   - lastUsedAt       ms timestamp
 *   - cooldownUntil    ms timestamp; key is skipped while now < cooldownUntil
 *   - lastErrorCode    e.g. "429", "401", "quota"
 *   - tokensIn / tokensOut  cumulative (best-effort; providers vary)
 *
 * On a 429 / quota / 503 the key is parked with a backoff (1m → 5m → 30m → 6h).
 * On a 401 / 403 the key is hard-disabled for the process lifetime.
 *
 * Read by: aiService.ts (provider selection)
 * Exposed by: routes/api.ts → GET /api/kernel/quota
 */

export type ProviderName = "gemini" | "groq" | "github" | "huggingface";

export interface KeyState {
  id: string;            // env var name
  provider: ProviderName;
  value: string;         // raw secret (never logged in full)
  calls: number;
  failures: number;
  tokensIn: number;
  tokensOut: number;
  lastUsedAt: number;
  cooldownUntil: number;
  lastErrorCode?: string;
  disabled: boolean;     // 401/403 → permanent skip
}

const HARD_DISABLE_CODES = new Set(["401", "403", "invalid_api_key"]);
const COOLDOWN_LADDER_MS = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];

class KeyPool {
  private pools: Record<ProviderName, KeyState[]> = {
    gemini: [],
    groq: [],
    github: [],
    huggingface: [],
  };
  private cursor: Record<ProviderName, number> = {
    gemini: 0, groq: 0, github: 0, huggingface: 0,
  };
  private lastScanAt = 0;

  /** Re-scan env. Cheap; throttled to once per 5s. */
  refresh(force = false) {
    const now = Date.now();
    if (!force && now - this.lastScanAt < 5000) return;
    this.lastScanAt = now;

    const scanned: Record<ProviderName, KeyState[]> = {
      gemini: this.collect("gemini", [
        /^GEMINI_API_KEY(?:_\d+|_[A-Z])?$/,
        /^GOOGLE_AI_KEY(?:_\d+|_[A-Z])?$/,
        /^GAK[_-]?\d+$/i,
        /^NEXUS_AI_KEY(?:_\d+)?$/,
        /^ALT_GEMINI_KEY(?:_\d+)?$/,
      ]),
      groq: this.collect("groq", [
        /^GROQ_API_KEY(?:_\d+|_[A-Z])?$/,
      ]),
      github: this.collect("github", [
        /^GITHUB_TOKEN(?:_\d+|_[A-Z])?$/,
        /^GITHUB_GPT(?:_\d+|_[A-Z])?$/,
        /^ALT_GITHUB_GPT(?:_\d+)?$/,
        /^GITHUB_MODELS_TOKEN(?:_\d+)?$/,
      ]),
      huggingface: this.collect("huggingface", [
        /^HUGGINGFACE_TOKEN(?:_\d+|_[A-Z])?$/,
        /^HF_TOKEN(?:_\d+|_[A-Z])?$/,
      ]),
    };

    // Merge: preserve runtime stats for keys whose value is unchanged.
    for (const provider of Object.keys(scanned) as ProviderName[]) {
      const fresh = scanned[provider];
      const existing = this.pools[provider];
      const merged: KeyState[] = [];
      const seen = new Set<string>();
      for (const f of fresh) {
        const prior = existing.find(e => e.id === f.id && e.value === f.value);
        merged.push(prior || f);
        seen.add(f.id);
      }
      // Drop pools that no longer exist; keep their stats out of the active pool.
      this.pools[provider] = merged;
      if (this.cursor[provider] >= merged.length) this.cursor[provider] = 0;
    }
  }

  private collect(provider: ProviderName, patterns: RegExp[]): KeyState[] {
    const keys: KeyState[] = [];
    const seenValues = new Set<string>();
    for (const [name, raw] of Object.entries(process.env)) {
      if (!raw) continue;
      const value = raw.trim();
      if (!value || value.startsWith("PLACEHOLDER")) continue;
      if (!patterns.some(p => p.test(name))) continue;
      if (seenValues.has(value)) continue;     // dedupe identical secrets across aliases
      seenValues.add(value);
      keys.push({
        id: name,
        provider,
        value,
        calls: 0,
        failures: 0,
        tokensIn: 0,
        tokensOut: 0,
        lastUsedAt: 0,
        cooldownUntil: 0,
        disabled: false,
      });
    }
    return keys;
  }

  /** Get the next healthy key for a provider; null if all exhausted. */
  next(provider: ProviderName): KeyState | null {
    this.refresh();
    const pool = this.pools[provider];
    if (pool.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < pool.length; i++) {
      const idx = (this.cursor[provider] + i) % pool.length;
      const k = pool[idx];
      if (k.disabled) continue;
      if (k.cooldownUntil > now) continue;
      this.cursor[provider] = (idx + 1) % pool.length;
      return k;
    }
    return null;
  }

  /** Inspect without rotating. */
  peekAll(provider: ProviderName): KeyState[] {
    this.refresh();
    return this.pools[provider];
  }

  recordSuccess(key: KeyState, tokensIn = 0, tokensOut = 0) {
    key.calls += 1;
    key.failures = 0;
    key.lastUsedAt = Date.now();
    key.tokensIn += tokensIn;
    key.tokensOut += tokensOut;
    key.lastErrorCode = undefined;
  }

  recordFailure(key: KeyState, errorCode: string, _err?: any) {
    key.failures += 1;
    key.lastUsedAt = Date.now();
    key.lastErrorCode = errorCode;
    if (HARD_DISABLE_CODES.has(errorCode)) {
      key.disabled = true;
      console.warn(`[KEYPOOL] ${key.provider}/${key.id} permanently disabled (${errorCode}).`);
      return;
    }
    if (errorCode === "429" || errorCode === "quota" || errorCode === "503" || errorCode === "rate_limit") {
      const stage = Math.min(key.failures - 1, COOLDOWN_LADDER_MS.length - 1);
      key.cooldownUntil = Date.now() + COOLDOWN_LADDER_MS[stage];
      console.warn(`[KEYPOOL] ${key.provider}/${key.id} cooled down ${COOLDOWN_LADDER_MS[stage] / 1000}s (${errorCode}).`);
    }
  }

  /** Public snapshot (redacts secrets) for /api/kernel/quota. */
  snapshot() {
    this.refresh();
    const out: Record<string, any> = {};
    for (const provider of Object.keys(this.pools) as ProviderName[]) {
      out[provider] = this.pools[provider].map(k => ({
        id: k.id,
        masked: this.mask(k.value),
        calls: k.calls,
        failures: k.failures,
        tokensIn: k.tokensIn,
        tokensOut: k.tokensOut,
        lastUsedAt: k.lastUsedAt,
        cooldownUntil: k.cooldownUntil,
        cooldownRemaining: Math.max(0, k.cooldownUntil - Date.now()),
        lastErrorCode: k.lastErrorCode,
        disabled: k.disabled,
        healthy: !k.disabled && k.cooldownUntil <= Date.now(),
      }));
    }
    return out;
  }

  /** Re-enable hard-disabled keys + clear cooldowns (use after fixing PAT scopes). */
  resetDisabled(provider?: ProviderName): { revived: number } {
    let revived = 0;
    const targets = provider ? [provider] : (Object.keys(this.pools) as ProviderName[]);
    for (const p of targets) {
      for (const k of this.pools[p]) {
        if (k.disabled || k.cooldownUntil > Date.now() || k.failures > 0) {
          k.disabled = false;
          k.cooldownUntil = 0;
          k.failures = 0;
          k.lastErrorCode = undefined;
          revived++;
        }
      }
    }
    return { revived };
  }

  private mask(v: string): string {
    if (v.length <= 8) return "*".repeat(v.length);
    return v.slice(0, 4) + "…" + v.slice(-4);
  }
}

/** Classify a thrown error into a normalized error code. */
export function classifyError(err: any): string {
  const msg = String(err?.message || err || "").toLowerCase();
  const status = err?.status || err?.statusCode || err?.response?.status;
  if (status === 429 || /rate.?limit|too many requests/.test(msg)) return "429";
  if (status === 401 || /unauthorized|invalid api key|invalid.?token/.test(msg)) return "401";
  if (status === 403 || /forbidden|permission/.test(msg)) return "403";
  if (status === 413 || /payload too large|context.*too long/.test(msg)) return "413";
  if (status === 404) return "404";
  if (status === 503 || /service unavailable|overloaded/.test(msg)) return "503";
  if (/quota|exhausted|exceeded/.test(msg)) return "quota";
  return "unknown";
}

export const keyPool = new KeyPool();
keyPool.refresh(true);
