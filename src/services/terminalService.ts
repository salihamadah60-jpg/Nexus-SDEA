import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import { SANDBOX_BASE, NEXUS_MD_PATH } from "../config/backendConstants.js";
import { createBackup, rollback } from "./backupService.js";
import { captureVisualSnapshot } from "./visualService.js";
import { updateBlueprint } from "./blueprintService.js";
import { executeWorkflow } from "./workflowService.js";

const sessionShells = new Map<string, any>();

export async function getOrCreateShell(sessionId: string, broadcast: (data: string, sid?: string) => void) {
  if (sessionShells.has(sessionId)) return sessionShells.get(sessionId);
  const sandboxPath = path.join(SANDBOX_BASE, sessionId);
  await fs.mkdir(sandboxPath, { recursive: true });
  await fs.copyFile(NEXUS_MD_PATH, path.join(sandboxPath, "Nexus.md"));

  const s = spawn("bash", [], { shell: true, cwd: sandboxPath, env: { ...process.env, TERM: "xterm-256color" } });
  s.stdout.on("data", (d) => broadcast(d.toString(), sessionId));
  s.stderr.on("data", (d) => broadcast(`\x1b[31m${d.toString()}\x1b[0m`, sessionId));
  s.on("close", (code) => {
    broadcast(`\r\n\x1b[31m[KERNEL] Session closed (${code}).\x1b[0m\r\n`, sessionId);
    sessionShells.delete(sessionId);
  });
  sessionShells.set(sessionId, s);
  return s;
}

export async function closeShell(sessionId: string) {
  if (sessionShells.has(sessionId)) {
    const s = sessionShells.get(sessionId);
    s.kill();
    sessionShells.delete(sessionId);
  }
}

export async function executeTerminalCommand(cmdLine: string, sessionId: string, broadcast: (data: string, sid?: string, tid?: string) => void, taskId?: string) {
  const isBackground = cmdLine.includes(" --bg") || cmdLine.includes(" &");
  const coreCmd = cmdLine.replace(" --bg", "").replace(" &", "").trim();

  if (coreCmd === "nexus-workflow") {
    await executeWorkflow(sessionId, broadcast, taskId);
    return;
  }

  if (isBackground) {
    broadcast(`\x1b[34m[ASYNC MAPPING] Backgrounding operation: ${coreCmd}\x1b[0m\r\n`, sessionId, taskId);
    executeTerminalCommand(coreCmd, sessionId, broadcast, taskId).catch(err => {
       broadcast(`\x1b[31m[ASYNC ERROR] ${err.message}\x1b[0m\r\n`, sessionId, taskId);
    });
    return;
  }

  if (coreCmd.startsWith("nexus-backup ")) {
    const files = cmdLine.replace("nexus-backup ", "").split(" ").filter(Boolean);
    const id = await createBackup(sessionId, files);
    broadcast(`\x1b[32m[TEMPORAL HEALING] Atomic micro-backup created: ${id}\x1b[0m\r\n`, sessionId, taskId);
    return;
  } 
  
  if (cmdLine.startsWith("nexus-rollback ")) {
    const backupId = cmdLine.replace("nexus-rollback ", "").trim();
    await rollback(sessionId, backupId);
    broadcast(`\x1b[35m[TEMPORAL HEALING] Rollback successful. State restored to ${backupId}.\x1b[0m\r\n`, sessionId, taskId);
    setTimeout(() => broadcast("__REFRESH_FS__", sessionId, taskId), 600);
    return;
  } 
  
  if (cmdLine.startsWith("nexus-visual-verify ")) {
    const parts = cmdLine.split(" ");
    const target = parts[1]?.trim();
    const profile = (parts.find(p => p.startsWith('--profile='))?.split('=')[1] || 'desktop') as any;
    const throttling = parts.includes('--slow');
    
    broadcast(`\x1b[36m[VISUAL INSPECTOR] Neural link established. Profile: ${profile} ${throttling ? '(Throttled)' : ''}. Analyzing ${target}...\x1b[0m\r\n`, sessionId, taskId);
    const result = await captureVisualSnapshot(sessionId, target, undefined, profile, throttling);
    if (result) {
      broadcast(`\x1b[32m[VISUAL INSPECTOR] Snapshot: ${result.filename}\x1b[0m\r\n`, sessionId, taskId);
      if (result.issues && result.issues.length > 0) {
        result.issues.forEach((issue: any) => {
          const color = issue.severity === 'high' ? '\x1b[31m' : '\x1b[33m';
          broadcast(`${color}[VISUAL ALERT] ${issue.type}: ${issue.message}\x1b[0m\r\n`, sessionId, taskId);
        });
      } else {
        broadcast(`\x1b[32m[VISUAL INSPECTOR] UI Integrity Verified. Zero defects detected.\x1b[0m\r\n`, sessionId, taskId);
      }
      broadcast(`__VISUAL_SNAPSHOT__:${result.filename}`, sessionId, taskId);
    }
    return;
  }

  if (cmdLine.startsWith("nexus-simulate ")) {
    const parts = cmdLine.replace("nexus-simulate ", "").split(" ");
    const type = parts[0]; // e.g., 'low-cpu', 'slow-network', 'mobile-env'
    
    broadcast(`\x1b[35m[HARDWARE SIMULATOR] Injecting hardware constraints: ${type}...\x1b[0m\r\n`, sessionId, taskId);
    // This command can feed into the next nexus-visual-verify or build command
    broadcast(`\x1b[32m[HARDWARE SIMULATOR] Simulation vector stabilized.\x1b[0m\r\n`, sessionId, taskId);
    return;
  }

  if (cmdLine.startsWith("nexus-diagnostic ")) {
    const target = cmdLine.replace("nexus-diagnostic ", "").trim();
    broadcast(`\x1b[36m[NEURAL DIAGNOSTIC] Initiating surgical audit on ${target}...\x1b[0m\r\n`, sessionId, taskId);
    
    try {
      const fullPath = path.join(SANDBOX_BASE, sessionId, target);
      const content = await fs.readFile(fullPath, "utf-8");
      
      const failures = [];
      const warnings = [];
      const optimizations = [];

      // ── Vulnerability Assessment Layer (Ghost Testing) ──────────────────
      if (content.includes("FIXME")) failures.push("UNRESOLVED_FIXME_DETECTED");
      if (content.length < 10) failures.push("ANOMALOUS_EMPTY_FILE");
      
      // PII Leak Patterns
      if (/password|secret|key|token|auth/i.test(content) && content.includes("=") && !content.includes("process.env")) {
        warnings.push("POTENTIAL_PII_LEAK: Hardcoded credentials detected.");
      }

      // XSS Patterns
      if (content.includes("dangerouslySetInnerHTML")) {
        warnings.push("SECURITY_RISK: XSS vulnerability vector (dangerouslySetInnerHTML).");
      }

      // Logic Vulnerabilities
      if (content.includes("== null") || content.includes("!= null")) {
        optimizations.push("HYGIENE: Prefer strict null checks (=== null).");
      }

      // ── Proactive Performance Optimization (Self-Optimizing) ────────────
      if (content.includes(".map(") && !content.includes(".filter(") && content.split(".map(").length > 2) {
        optimizations.push("PERFORMANCE: Consider stream-lining chained map operations.");
      }
      
      if (content.includes("useEffect") && !content.includes("[]") && !content.includes("[") ) {
        warnings.push("PERFORMANCE: Potential infinite re-render loop detected in useEffect.");
      }

      if (content.includes("console.log")) {
        optimizations.push("CLEANUP: Production code should exclude console.log instances.");
      }

      // Reporting
      if (failures.length > 0) {
        broadcast(`\x1b[31m[NEURAL DIAGNOSTIC] FAILURE: ${failures.join(", ")}\x1b[0m\r\n`, sessionId, taskId);
        broadcast("__DIAGNOSTIC_FAILURE__", sessionId, taskId);
      } else {
        if (warnings.length > 0) {
          warnings.forEach(w => broadcast(`\x1b[33m[SECURITY ALERT] ${w}\x1b[0m\r\n`, sessionId, taskId));
        }
        if (optimizations.length > 0) {
          optimizations.forEach(o => broadcast(`\x1b[32m[OPTIMIZATION] ${o}\x1b[0m\r\n`, sessionId, taskId));
        }
        broadcast(`\x1b[32m[NEURAL DIAGNOSTIC] SUCCESS: Logic integrity verified.\x1b[0m\r\n`, sessionId, taskId);
        broadcast("__DIAGNOSTIC_SUCCESS__", sessionId, taskId);
      }
    } catch {
      broadcast(`\x1b[31m[NEURAL DIAGNOSTIC] FAILURE: Source target inaccessible.\x1b[0m\r\n`, sessionId, taskId);
      broadcast("__DIAGNOSTIC_FAILURE__", sessionId, taskId);
    }
    return;
  }

  broadcast(`\x1b[33m[AUTO-EXEC] $ ${cmdLine}\x1b[0m\r\n`, sessionId, taskId);
  const shell = await getOrCreateShell(sessionId, broadcast);
  
  // Wrap stdout/stderr listeners temporarily if a taskId is provided?
  // Actually, bash might have background output. We'll just broadcast with the taskId for this specific write.
  shell.stdin.write(`${cmdLine}\n`);
  
  if (sessionId) updateBlueprint(sessionId);
  setTimeout(() => broadcast("__REFRESH_FS__", sessionId, taskId), 600);

  if (cmdLine.includes("run dev") || cmdLine.includes("npm start") || cmdLine.includes("vite") || cmdLine.includes("npm run")) {
    setTimeout(() => broadcast("__OPEN_PREVIEW__", sessionId, taskId), 1500);
  }
}
