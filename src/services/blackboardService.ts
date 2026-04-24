/**
 * Blackboard State — shared scratchpad for the Planner→Writer→Reviewer loop.
 *
 * Persistent: backed by `tasks` + `audits` SQLite tables.
 * In-memory cache for live sessions.
 */
import { db } from "./stateDb.js";
import crypto from "crypto";
import { eventStream } from "./eventStreamService.js";
import { nexusLog } from "./logService.js";

const log = nexusLog("blackboard");

export type TaskStatus = "pending" | "planning" | "writing" | "reviewing" | "awaiting_approval" | "done" | "stasis" | "failed";

export interface PlanStep {
  id: string;
  description: string;
  acceptance: string;
  depends_on: string[];
  status: "todo" | "in_progress" | "done" | "failed";
  artifact?: any;
}

export interface BlackboardTask {
  id: string;
  sessionId?: string;
  parentId?: string;
  goal: string;
  plan: PlanStep[];
  currentStep: number;
  status: TaskStatus;
  retries: number;
  createdAt: number;
  updatedAt: number;
  result?: any;
  audits: AuditEntry[];
}

export interface AuditEntry {
  step: number;
  passed: boolean;
  severity: string;
  issues: string[];
  reviewerModel: string;
  createdAt: number;
}

const cache = new Map<string, BlackboardTask>();

export function newTaskId(): string {
  return `task_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

export function createTask(input: { goal: string; sessionId?: string; parentId?: string }): BlackboardTask {
  const t: BlackboardTask = {
    id: newTaskId(),
    sessionId: input.sessionId,
    parentId: input.parentId,
    goal: input.goal,
    plan: [],
    currentStep: 0,
    status: "pending",
    retries: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    audits: [],
  };
  cache.set(t.id, t);
  persist(t);
  eventStream.emit("agent.plan", { taskId: t.id, status: "created", goal: t.goal }, { sessionId: t.sessionId, taskId: t.id });
  return t;
}

export function setPlan(taskId: string, plan: PlanStep[]) {
  const t = get(taskId); if (!t) return;
  t.plan = plan; t.status = "writing"; t.currentStep = 0; t.updatedAt = Date.now();
  persist(t);
  eventStream.emit("agent.plan", { taskId, steps: plan.length }, { sessionId: t.sessionId, taskId });
}

export function setStatus(taskId: string, status: TaskStatus, result?: any) {
  const t = get(taskId); if (!t) return;
  t.status = status; t.updatedAt = Date.now();
  if (result !== undefined) t.result = result;
  persist(t);
  eventStream.emit("agent.thought", { taskId, status }, { sessionId: t.sessionId, taskId });
}

export function recordAudit(taskId: string, audit: AuditEntry) {
  const t = get(taskId); if (!t) return;
  t.audits.push(audit);
  db().prepare(
    `INSERT INTO audits (task_id, step, passed, severity, issues, reviewer_model, created_at) VALUES (?,?,?,?,?,?,?)`
  ).run(taskId, audit.step, audit.passed ? 1 : 0, audit.severity, JSON.stringify(audit.issues), audit.reviewerModel, audit.createdAt);
  t.updatedAt = Date.now();
  persist(t);
}

export function bumpRetry(taskId: string): number {
  const t = get(taskId); if (!t) return 0;
  t.retries += 1; t.updatedAt = Date.now();
  persist(t);
  return t.retries;
}

export function get(taskId: string): BlackboardTask | undefined {
  if (cache.has(taskId)) return cache.get(taskId);
  const row = db().prepare(`SELECT * FROM tasks WHERE id=?`).get(taskId) as any;
  if (!row) return undefined;
  const t: BlackboardTask = {
    id: row.id,
    sessionId: row.session_id,
    parentId: row.parent_id,
    goal: row.goal,
    plan: row.plan ? JSON.parse(row.plan) : [],
    currentStep: row.current_step,
    status: row.status,
    retries: row.retries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    result: row.result ? safeParse(row.result) : undefined,
    audits: db().prepare(`SELECT step, passed, severity, issues, reviewer_model, created_at FROM audits WHERE task_id=?`).all(taskId).map((a: any) => ({
      step: a.step, passed: !!a.passed, severity: a.severity, issues: safeParse(a.issues) || [], reviewerModel: a.reviewer_model, createdAt: a.created_at,
    })),
  };
  cache.set(taskId, t);
  return t;
}

function safeParse(s: string) { try { return JSON.parse(s); } catch { return s; } }

function persist(t: BlackboardTask) {
  db().prepare(
    `INSERT OR REPLACE INTO tasks (id, session_id, parent_id, goal, plan, current_step, status, retries, created_at, updated_at, result)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    t.id, t.sessionId, t.parentId, t.goal,
    JSON.stringify(t.plan), t.currentStep, t.status, t.retries,
    t.createdAt, t.updatedAt, t.result ? JSON.stringify(t.result) : null
  );
}

export function listIncompleteTasks(): BlackboardTask[] {
  const rows = db().prepare(`SELECT id FROM tasks WHERE status NOT IN ('done', 'failed', 'stasis') ORDER BY updated_at DESC LIMIT 50`).all() as any[];
  return rows.map(r => get(r.id)).filter(Boolean) as BlackboardTask[];
}

/** Phase 7.4 — HITL: caller writes an approval verdict into the task result. */
export function approveTask(taskId: string, approved: boolean, note?: string) {
  const t = get(taskId); if (!t) return false;
  if (t.status !== "awaiting_approval") return false;
  t.result = { ...(t.result || {}), hitl: { approved, note: note || "", at: Date.now() } };
  t.status = approved ? "writing" : "failed";
  t.updatedAt = Date.now();
  persist(t);
  eventStream.emit("agent.thought", { taskId, hitl: approved ? "approved" : "rejected", note }, { sessionId: t.sessionId, taskId });
  return true;
}

export function listSessionTasks(sessionId: string, limit = 20): BlackboardTask[] {
  const rows = db().prepare(`SELECT id FROM tasks WHERE session_id=? ORDER BY updated_at DESC LIMIT ?`).all(sessionId, limit) as any[];
  return rows.map(r => get(r.id)).filter(Boolean) as BlackboardTask[];
}

/** Crash-resume: mark in-flight tasks as stasis on boot (Phase 5.3). */
export function resumeAfterCrash() {
  const orphans = db().prepare(`SELECT id FROM tasks WHERE status IN ('planning','writing','reviewing') AND updated_at < ?`).all(Date.now() - 30000) as any[];
  for (const o of orphans) {
    db().prepare(`UPDATE tasks SET status='stasis', updated_at=? WHERE id=?`).run(Date.now(), o.id);
  }
  if (orphans.length > 0) log.warn(`resumed ${orphans.length} orphaned task(s) into stasis`);
}
