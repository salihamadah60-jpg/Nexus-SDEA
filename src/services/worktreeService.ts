/**
 * Experimental Branching via `git worktree` (Plan 5.7).
 *
 * Lets the orchestrator try a risky edit on a throw-away branch without
 * polluting the active sandbox. If a worktree fails its quad-gates, the caller
 * can drop it; if it passes, callers can fast-forward merge into the live tree.
 *
 * All operations are best-effort and degrade gracefully when git is missing
 * (e.g. a fresh sandbox without a repo). Pure helpers — no side effects beyond
 * the requested filesystem mutation.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { sanitizedEnv } from "./securityService.js";
import { nexusLog } from "./logService.js";

const exec = promisify(execFile);
const log = nexusLog("worktree");

async function ensureGit(cwd: string): Promise<boolean> {
  if (existsSync(path.join(cwd, ".git"))) return true;
  try {
    await exec("git", ["init", "-q"], { cwd, env: sanitizedEnv() });
    await exec("git", ["add", "-A"], { cwd, env: sanitizedEnv() });
    await exec("git", ["-c", "user.email=nexus@local", "-c", "user.name=Nexus", "commit", "-q", "--allow-empty", "-m", "nexus:bootstrap"], { cwd, env: sanitizedEnv() });
    return true;
  } catch (e: any) {
    log.warn(`git init failed for ${cwd}: ${e?.message?.slice(0, 80)}`);
    return false;
  }
}

export interface WorktreeRef {
  branch: string;
  path: string;
  base: string;
}

export async function createWorktree(sessionId: string, label: string): Promise<WorktreeRef | null> {
  const base = path.join(SANDBOX_BASE, sessionId);
  if (!existsSync(base)) return null;
  if (!(await ensureGit(base))) return null;

  const branch = `nexus/${label}-${Date.now().toString(36)}`;
  const wtPath = path.join(process.cwd(), ".nexus", "worktrees", sessionId, branch.replace(/\//g, "_"));
  await fs.mkdir(path.dirname(wtPath), { recursive: true });

  try {
    await exec("git", ["worktree", "add", "-b", branch, wtPath], { cwd: base, env: sanitizedEnv() });
    log.info(`worktree ${branch} → ${wtPath}`);
    return { branch, path: wtPath, base };
  } catch (e: any) {
    log.warn(`git worktree add failed: ${e?.message?.slice(0, 120)}`);
    return null;
  }
}

export async function dropWorktree(ref: WorktreeRef): Promise<boolean> {
  try {
    await exec("git", ["worktree", "remove", "--force", ref.path], { cwd: ref.base, env: sanitizedEnv() });
    await exec("git", ["branch", "-D", ref.branch], { cwd: ref.base, env: sanitizedEnv() }).catch(() => {});
    return true;
  } catch (e: any) {
    log.warn(`worktree drop failed: ${e?.message?.slice(0, 80)}`);
    await fs.rm(ref.path, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

export async function mergeWorktree(ref: WorktreeRef): Promise<boolean> {
  try {
    await exec("git", ["-c", "user.email=nexus@local", "-c", "user.name=Nexus", "commit", "-q", "-a", "-m", `nexus:wt ${ref.branch}`], { cwd: ref.path, env: sanitizedEnv() }).catch(() => {});
    await exec("git", ["merge", "--ff-only", ref.branch], { cwd: ref.base, env: sanitizedEnv() });
    await dropWorktree(ref);
    return true;
  } catch (e: any) {
    log.warn(`worktree merge failed: ${e?.message?.slice(0, 80)}`);
    return false;
  }
}

export async function listWorktrees(sessionId: string): Promise<string[]> {
  const base = path.join(SANDBOX_BASE, sessionId);
  if (!existsSync(path.join(base, ".git"))) return [];
  try {
    const { stdout } = await exec("git", ["worktree", "list", "--porcelain"], { cwd: base, env: sanitizedEnv() });
    return stdout.split("\n").filter(l => l.startsWith("worktree ")).map(l => l.slice(9));
  } catch { return []; }
}
