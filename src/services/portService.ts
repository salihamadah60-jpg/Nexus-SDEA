/**
 * Nexus Port Service — Cross-Platform Intelligent Port Management
 *
 * Replaces blind portfinder usage with:
 *   1. Reserved-port enforcement (Nexus's own port is never given to a project)
 *   2. Free-port testing via raw TCP bind
 *   3. OS-aware process discovery (lsof on Linux/macOS, netstat on Windows)
 *   4. Deterministic kill-and-reuse, with clean fallback to next free port
 *
 * Fix 1 (Port Conflict): Removed `shell: true` and `kill -9 $(lsof ...)` command
 * substitution (which creates extra shell processes and is fragile). All kills now
 * go through the typed findPidsOnPort + killPid path.
 *
 * Read by: autopilotService.ts, server.ts
 */
import net from "net";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";

const execAsync = promisify(exec);

// Ports that Nexus itself uses — projects must NEVER bind these.
const RESERVED_PORTS = new Set<number>([5000]);

export function registerNexusPort(port: number) {
  RESERVED_PORTS.add(port);
}

export function getReservedPorts(): number[] {
  return Array.from(RESERVED_PORTS).sort((a, b) => a - b);
}

export function isReserved(port: number): boolean {
  return RESERVED_PORTS.has(port);
}

/** Test if a TCP port is free by attempting a real bind on 0.0.0.0. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const tester = net.createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "0.0.0.0");
  });
}

/** Find PIDs listening on a port. Cross-platform. Returns [] if none/unsupported. */
export async function findPidsOnPort(port: number): Promise<number[]> {
  const platform = os.platform();
  const pids = new Set<number>();

  try {
    if (platform === "win32") {
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
      stdout.split(/\r?\n/).forEach(line => {
        const m = line.trim().match(/\s(\d+)\s*$/);
        if (m) pids.add(parseInt(m[1], 10));
      });
    } else {
      // Linux / macOS — try multiple tools, each with individual error isolation
      const commands = [
        `lsof -t -i:${port} 2>/dev/null`,
        `ss -lptn sport = :${port} 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2`,
      ];
      for (const cmd of commands) {
        try {
          const { stdout } = await execAsync(cmd, { timeout: 3000 });
          stdout.split(/[\s\n\r]+/).filter(Boolean).forEach(s => {
            const n = parseInt(s, 10);
            if (!isNaN(n) && n > 1) pids.add(n);
          });
        } catch {}
      }
    }
  } catch (err: any) {
    console.error(`[PORT] findPidsOnPort(${port}) failed:`, err.message);
  }

  return Array.from(pids).filter(p => p > 0);
}

/** Kill a PID using process.kill (no shell spawning). */
export async function killPid(pid: number): Promise<boolean> {
  if (pid === process.pid) return false; // never kill ourselves
  try {
    if (os.platform() === "win32") {
      await execAsync(`taskkill /F /PID ${pid}`);
    } else {
      // SIGTERM first, then SIGKILL — no shell spawning
      try { process.kill(pid, "SIGTERM"); } catch {}
      await new Promise(r => setTimeout(r, 500));
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    return true;
  } catch { return false; }
}

/**
 * Acquire a usable port for a sandbox project.
 *
 * Strategy:
 *  1. If preferredPort is reserved, jump straight to fallback scan.
 *  2. If preferredPort is free, return it immediately.
 *  3. If preferredPort is busy and killOccupant=true, find+kill occupants (up to 4 retries).
 *     Each retry waits a bit longer. Uses typed APIs only — no shell command substitution.
 *  4. Fallback: scan upward from preferredPort+1, skipping reserved ports.
 */
export async function acquirePort(opts: {
  preferred: number;
  killOccupant?: boolean;
  maxScan?: number;
}): Promise<{ port: number; action: "preferred" | "killed-and-reused" | "fallback" }> {
  const preferred = opts.preferred;
  const killOccupant = opts.killOccupant ?? true;
  const maxScan = opts.maxScan ?? 150;

  // Step 1: Reserved port — never give it to a project
  if (isReserved(preferred)) {
    console.warn(`[PORT] Port ${preferred} is reserved by Nexus — scanning for fallback.`);
  } else if (await isPortFree(preferred)) {
    return { port: preferred, action: "preferred" };
  } else if (killOccupant) {
    // Step 3: Attempt to reclaim preferred port
    for (let retry = 0; retry < 4; retry++) {
      const pids = (await findPidsOnPort(preferred)).filter(p => p !== process.pid);

      if (pids.length > 0) {
        console.log(`[PORT] Clearing port ${preferred}: killing PIDs ${pids.join(", ")} (attempt ${retry + 1}/4)`);
        for (const pid of pids) await killPid(pid);
      } else {
        // No PIDs found but port still busy — wait a moment for the OS to release it
        console.log(`[PORT] Port ${preferred} busy but no PIDs found — waiting for OS release (attempt ${retry + 1}/4)`);
      }

      await new Promise(r => setTimeout(r, 800 + retry * 600));

      if (await isPortFree(preferred)) {
        return { port: preferred, action: "killed-and-reused" };
      }
    }
    console.warn(`[PORT] Could not reclaim port ${preferred} after 4 attempts — falling back to next free port.`);
  }

  // Step 4: Fallback scan — deterministic, skips reserved ports
  for (let i = 1; i <= maxScan; i++) {
    const candidate = preferred + i;
    if (isReserved(candidate)) continue;
    if (await isPortFree(candidate)) {
      console.log(`[PORT] Fallback: assigned port ${candidate} (preferred ${preferred} unavailable).`);
      return { port: candidate, action: "fallback" };
    }
  }

  // Last resort: return preferred and let the caller handle EADDRINUSE
  console.error(`[PORT] No free port found in ${preferred}..${preferred + maxScan} range. Returning preferred (may cause EADDRINUSE).`);
  return { port: preferred, action: "preferred" };
}
