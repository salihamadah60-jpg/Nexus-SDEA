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
import https from "https";
import { nexusLog } from "./logService.js";

const log = nexusLog("e2b");

/** Quick TCP/HTTPS reachability check — times out in 4 s. */
function canReach(host: string, port = 443): Promise<boolean> {
  return new Promise(resolve => {
    const req = https.get({ hostname: host, port, path: "/", timeout: 4000 }, res => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

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

  // Connectivity cache — avoid probing on every request.
  // null = not tested yet, true/false = cached result (re-checked every 5 min).
  private _reachable: boolean | null = null;
  private _reachableAt = 0;
  private readonly REACHABLE_TTL = 5 * 60 * 1000; // 5 minutes

  static getInstance() {
    if (!E2BManager.instance) E2BManager.instance = new E2BManager();
    return E2BManager.instance;
  }

  /** True if E2B_API_KEY is set AND the E2B API host is reachable on this network. */
  isActive(): boolean { return !!process.env.E2B_API_KEY; }

  /** Synchronous reachability check (uses cached result). */
  isReachable(): boolean {
    return this._reachable === true;
  }

  /** Async connectivity probe — called once at startup and periodically. */
  async probeConnectivity(): Promise<boolean> {
    const now = Date.now();
    if (this._reachable !== null && (now - this._reachableAt) < this.REACHABLE_TTL) {
      return this._reachable;
    }
    if (!process.env.E2B_API_KEY) {
      this._reachable = false;
      this._reachableAt = now;
      return false;
    }
    try {
      const ok = await canReach("api.e2b.dev");
      this._reachable = ok;
      this._reachableAt = now;
      if (!ok) {
        log.warn("E2B API host (api.e2b.dev) is unreachable — falling back to local sandbox mode. This may be a VPN/firewall restriction.");
      } else {
        log.info("E2B API host reachable — remote sandbox mode active.");
      }
      return ok;
    } catch {
      this._reachable = false;
      this._reachableAt = now;
      return false;
    }
  }

  async createSandbox(sessionId: string): Promise<Sandbox | null> {
    if (this.sandboxes.has(sessionId)) return this.sandboxes.get(sessionId)!;
    const apiKey = process.env.E2B_API_KEY;
    if (!apiKey) return null;
    // Check network reachability first — if E2B is blocked (VPN/firewall) fall back to local.
    const reachable = await this.probeConnectivity();
    if (!reachable) {
      log.warn(`E2B unreachable for session ${sessionId} — using local sandbox.`);
      return null;
    }
    try {
      log.info(`spawning remote sandbox for ${sessionId}…`);
      const sbx = await Sandbox.create({ apiKey, template: "base" });
      this.sandboxes.set(sessionId, sbx);
      log.info(`sandbox ${(sbx as any).id || "?"} ready for ${sessionId}`);
      return sbx;
    } catch (err: any) {
      log.warn(`E2B sandbox boot failed: ${err?.message?.slice(0, 120)}`);
      // Mark as unreachable so subsequent calls skip the probe delay.
      this._reachable = false;
      this._reachableAt = Date.now();
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
