/**
 * Cost Ledger — every LLM call logged to SQLite (Phase 6.4).
 * Token budget enforcement (Phase 6.3).
 */
import { db } from "./stateDb.js";
import { nexusLog } from "./logService.js";

const log = nexusLog("cost");

// Approximate USD per 1K tokens (input/output combined, conservative estimate).
const COST_TABLE: Record<string, { in: number; out: number }> = {
  "gemini-1.5-pro-latest": { in: 0.00125, out: 0.005 },
  "gemini-1.5-flash-latest": { in: 0.000075, out: 0.0003 },
  "gemini-2.0-flash-exp": { in: 0, out: 0 },
  "gemini-2.5-flash": { in: 0.000075, out: 0.0003 },
  "llama-3.3-70b-versatile": { in: 0.00059, out: 0.00079 },
  "llama-3.1-8b-instant": { in: 0.00005, out: 0.00008 },
  "gpt-4o": { in: 0.0025, out: 0.01 },
  "gpt-4o-mini": { in: 0.00015, out: 0.0006 },
  "DeepSeek-V3": { in: 0, out: 0 },
};

function priceFor(model: string, tokensIn: number, tokensOut: number): number {
  const key = Object.keys(COST_TABLE).find(k => model.includes(k));
  if (!key) return 0;
  const p = COST_TABLE[key];
  return (tokensIn / 1000) * p.in + (tokensOut / 1000) * p.out;
}

export interface CostEntry {
  sessionId?: string;
  taskId?: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export function recordCost(e: CostEntry): number {
  const usd = priceFor(e.model, e.tokensIn, e.tokensOut);
  db().prepare(
    `INSERT INTO cost_ledger (session_id, task_id, provider, model, tokens_in, tokens_out, est_cost_usd, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(e.sessionId || null, e.taskId || null, e.provider, e.model, e.tokensIn, e.tokensOut, usd, Date.now());
  return usd;
}

export function sessionCost(sessionId: string) {
  const r = db().prepare(
    `SELECT COUNT(*) as calls, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out, SUM(est_cost_usd) as usd
     FROM cost_ledger WHERE session_id=?`
  ).get(sessionId) as any;
  return { calls: r.calls || 0, tokensIn: r.tokens_in || 0, tokensOut: r.tokens_out || 0, usd: r.usd || 0 };
}

export function globalCostSummary(hours = 24) {
  const since = Date.now() - hours * 3600_000;
  const r = db().prepare(
    `SELECT provider, model, COUNT(*) as calls, SUM(tokens_in) as tin, SUM(tokens_out) as tout, SUM(est_cost_usd) as usd
     FROM cost_ledger WHERE created_at >= ? GROUP BY provider, model ORDER BY usd DESC`
  ).all(since) as any[];
  const total = db().prepare(`SELECT SUM(est_cost_usd) as usd, COUNT(*) as calls FROM cost_ledger WHERE created_at >= ?`).get(since) as any;
  return { hours, total: { usd: total.usd || 0, calls: total.calls || 0 }, byModel: r };
}

// ---- Token budget (Phase 6.3) -------------------------------------------

export class TokenBudget {
  constructor(public limit: number, public used = 0) {}
  consume(n: number): boolean {
    if (this.used + n > this.limit) {
      log.warn(`budget exceeded: ${this.used + n} > ${this.limit}`);
      return false;
    }
    this.used += n;
    return true;
  }
  remaining(): number { return Math.max(0, this.limit - this.used); }
}
