/**
 * E2B Sandbox Service — Phase 3.1 / 3.2 / 3.3.
 *
 * When E2B_API_KEY is set, code (and reviewer-bound stack traces) flow through
 * a remote micro-VM. When absent, callers fall back to local spawn.
 *
 * Public surface kept small + boring on purpose:
 *   - createSandbox(sessionId)              boot + cache per session
 *   - writeFile(sessionId, relPath, body)   push file into the VM
 *   - runCommand(sessionId, cmd, opts?)     run shell, return {stdout, stderr, code}
 *   - lastError(sessionId)                  most recent stderr/stack for reviewer hand-off
 *   - closeSandbox(sessionId)
 */
import { Sandbox } from "e2b";
import { nexusLog } from "./logService.js";

const log = nexusLog("e2b");

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stackTrace?: string;
}

const STACK_RE = /(?:Error|Exception|Traceback)[\s\S]{0,2000}?(?:\n\s+at\s|\n\s+File\s)/i;

function extractStack(text: string): string | undefined {
  if (!text) return undefined;
  const m = text.match(STACK_RE);
  return m ? m[0].trim() : undefined;
}

class E2BManager {
  private static instance: E2BManager;
  private sandboxes: Map<string, Sandbox> = new Map();
  private errors: Map<string, CommandResult> = new Map();

  static getInstance() {
    if (!E2BManager.instance) E2BManager.instance = new E2BManager();
    return E2BManager.instance;
  }

  isActive(): boolean { return !!process.env.E2B_API_KEY; }

  async createSandbox(sessionId: string): Promise<Sandbox | null> {
    if (this.sandboxes.has(sessionId)) return this.sandboxes.get(sessionId)!;
    const apiKey = process.env.E2B_API_KEY;
    if (!apiKey) return null;
    try {
      log.info(`spawning remote sandbox for ${sessionId}…`);
      const sbx = await Sandbox.create({ apiKey, template: "base" });
      this.sandboxes.set(sessionId, sbx);
      log.info(`sandbox ${(sbx as any).id || "?"} ready for ${sessionId}`);
      return sbx;
    } catch (err: any) {
      log.warn(`E2B sandbox boot failed: ${err?.message?.slice(0, 120)}`);
      return null;
    }
  }

  getSandbox(sessionId: string): Sandbox | undefined {
    return this.sandboxes.get(sessionId);
  }

  /** Sandbox metadata (id, status flag) for /api/e2b/status. */
  async describe(sessionId?: string) {
    if (!sessionId) {
      return { active: this.isActive(), sandboxes: this.sandboxes.size };
    }
    const sbx = this.sandboxes.get(sessionId) as any;
    return { active: this.isActive(), sandboxId: sbx?.id || sbx?.sandboxId || null, exists: !!sbx };
  }

  async writeFile(sessionId: string, relPath: string, body: string): Promise<boolean> {
    const sbx = await this.createSandbox(sessionId);
    if (!sbx) return false;
    try {
      const fs = (sbx as any).files || (sbx as any).filesystem;
      if (!fs?.write) {
        log.warn(`E2B write API missing on sandbox; skipping ${relPath}`);
        return false;
      }
      await fs.write(relPath, body);
      return true;
    } catch (err: any) {
      log.warn(`E2B writeFile(${relPath}) failed: ${err?.message?.slice(0, 80)}`);
      return false;
    }
  }

  /** Run a shell command inside the VM. Captures stack traces for reviewer hand-off. */
  async runCommand(sessionId: string, cmd: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult | null> {
    const sbx = await this.createSandbox(sessionId);
    if (!sbx) return null;
    try {
      const cmds = (sbx as any).commands || (sbx as any).process;
      if (!cmds?.run) {
        log.warn(`E2B commands API missing on sandbox`);
        return null;
      }
      const r = await cmds.run(cmd, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 60_000 });
      const result: CommandResult = {
        stdout: String(r?.stdout || ""),
        stderr: String(r?.stderr || ""),
        exitCode: typeof r?.exitCode === "number" ? r.exitCode : (r?.error ? 1 : 0),
      };
      const stack = extractStack(result.stderr) || extractStack(result.stdout);
      if (stack) result.stackTrace = stack;
      if (result.exitCode !== 0 || stack) this.errors.set(sessionId, result);
      return result;
    } catch (err: any) {
      const result: CommandResult = { stdout: "", stderr: err?.message || String(err), exitCode: 1, stackTrace: extractStack(String(err?.message || "")) };
      this.errors.set(sessionId, result);
      log.warn(`E2B runCommand failed: ${err?.message?.slice(0, 80)}`);
      return result;
    }
  }

  /** Return (and clear) the last command error for this session. */
  lastError(sessionId: string): CommandResult | null {
    const e = this.errors.get(sessionId);
    if (!e) return null;
    this.errors.delete(sessionId);
    return e;
  }

  async closeSandbox(sessionId: string) {
    const sbx = this.sandboxes.get(sessionId) as any;
    if (!sbx) return;
    try { await (sbx.close?.() ?? sbx.kill?.()); } catch {}
    this.sandboxes.delete(sessionId);
    log.info(`sandbox closed for ${sessionId}`);
  }
}

export const e2bManager = E2BManager.getInstance();
export const E2BManagerClass = E2BManager;
