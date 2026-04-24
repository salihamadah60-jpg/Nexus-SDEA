/**
 * Nexus Port Service — Cross-Platform Intelligent Port Management
 *
 * Replaces blind portfinder usage with:
 *   1. Reserved-port enforcement (Nexus's own port is never given to a project)
 *   2. Free-port testing via raw TCP bind
 *   3. OS-aware process discovery (lsof on Linux/macOS, netstat on Windows)
 *   4. Optional kill-and-reuse, with fallback to next free port
 *
 * Read by: autopilotService.ts, server.ts
 */
import net from "net";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";

const execAsync = promisify(exec);

// Ports that Nexus itself uses — projects must NEVER bind these.
// Updated dynamically when Nexus boots (see registerNexusPort below).
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
      // Linux / macOS — aggregate from multiple tools
      const commands = [
        `lsof -t -i:${port}`, // Broader than -sTCP:LISTEN
        `fuser ${port}/tcp 2>/dev/null`,
        `ss -lptn 'sport = :${port}' | grep -oP 'pid=\\K\\d+'`,
        `netstat -lptn | grep :${port} | awk '{print $7}' | cut -d/ -f1`
      ];

      for (const cmd of commands) {
        try {
          const { stdout } = await execAsync(cmd);
          stdout.split(/[\s\n\r]+/).filter(Boolean).forEach(s => {
            const n = parseInt(s, 10);
            if (!isNaN(n)) pids.add(n);
          });
        } catch {}
      }
    }
  } catch (err: any) {
    console.error(`[PORT] findPidsOnPort(${port}) failed:`, err.message);
  }

  return Array.from(pids).filter(p => p > 0);
}

/** Kill a PID. Cross-platform. */
export async function killPid(pid: number): Promise<boolean> {
  try {
    if (os.platform() === "win32") {
      await execAsync(`taskkill /F /PID ${pid}`);
    } else {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await new Promise(r => setTimeout(r, 400));
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    return true;
  } catch { return false; }
}

/**
 * Acquire a usable port for a sandbox project.
 *
 * Strategy:
 *  1. If preferredPort is reserved, jump straight to fallback.
 *  2. If preferredPort is free, return it.
 *  3. If preferredPort is busy and `killOccupant` is true, identify+kill the holder
 *     and retry. If still busy, fall back.
 *  4. Fallback: scan upward, skipping reserved ports, until a free one is found.
 */
export async function acquirePort(opts: {
  preferred: number;
  killOccupant?: boolean;
  maxScan?: number;
  stubbornForce?: boolean; // New: If true, will NOT fall back to next port unless preferred is reserved
}): Promise<{ port: number; action: "preferred" | "killed-and-reused" | "fallback" }> {
  const preferred = opts.preferred;
  const killOccupant = opts.killOccupant ?? true;
  const maxScan = opts.maxScan ?? 100;
  const stubbornForce = opts.stubbornForce ?? true;

  if (!isReserved(preferred) && await isPortFree(preferred)) {
    return { port: preferred, action: "preferred" };
  }

  if (!isReserved(preferred) && killOccupant) {
    for (let retry = 0; retry < 5; retry++) {
      let pids = await findPidsOnPort(preferred);
      
      if (pids.length === 0) {
        if (await isPortFree(preferred)) {
          return { port: preferred, action: "preferred" };
        }
        // Port is busy but no PIDs found. Try a panic kill via fuser if on Linux.
        if (os.platform() !== "win32" && retry > 1) {
          try { await execAsync(`fuser -k -n tcp ${preferred} 2>/dev/null`); } catch {}
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      
      const safePids = pids.filter(p => p !== process.pid);
      if (safePids.length > 0) {
        console.log(`[PORT] Stubbornly clearing port ${preferred}. Killing PIDs: ${safePids.join(", ")}`);
        for (const pid of safePids) await killPid(pid);
        await new Promise(r => setTimeout(r, 1200 + (retry * 500)));
      }
      
      if (await isPortFree(preferred)) {
        return { port: preferred, action: "killed-and-reused" };
      }
    }
    
    if (stubbornForce) {
        console.warn(`[PORT] Reclamation failed for port ${preferred}. STUBBORN_FORCE is active - retrying PID purge...`);
        // Final attempt: recursive grep and kill if tools failed
        try {
            await execAsync(`kill -9 $(lsof -t -i:${preferred}) || true`);
            await new Promise(r => setTimeout(r, 2000));
            if (await isPortFree(preferred)) return { port: preferred, action: "killed-and-reused" };
        } catch {}
    } else {
        console.warn(`⚠️ Stubborn reuse failed for port ${preferred} after 5 attempts.`);
    }
  }

  // Fallback scan only as a last resort OR if stubbornForce is false
  if (!stubbornForce) {
    for (let i = 1; i <= maxScan; i++) {
        const candidate = preferred + i;
        if (isReserved(candidate)) continue;
        if (await isPortFree(candidate)) {
          return { port: candidate, action: "fallback" };
        }
      }
  }
  
  // Even with stubbornForce, fall back to scanning for a free port instead of crashing the host process.
  if (stubbornForce && !await isPortFree(preferred)) {
    console.warn(`[PORT] Reclamation gave up on port ${preferred}. Falling back to next free port.`);
    for (let i = 1; i <= maxScan; i++) {
      const candidate = preferred + i;
      if (isReserved(candidate)) continue;
      if (await isPortFree(candidate)) {
        return { port: candidate, action: "fallback" };
      }
    }
  }

  return { port: preferred, action: "preferred" };
}
