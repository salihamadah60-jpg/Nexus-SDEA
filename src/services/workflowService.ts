import fs from "fs/promises";
import path from "path";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { executeTerminalCommand } from "./terminalService.js";

export async function executeWorkflow(sessionId: string, broadcast: (data: string, sid?: string, tid?: string) => void, taskId?: string) {
  const sandboxPath = path.join(SANDBOX_BASE, sessionId);
  const workflowPath = path.join(sandboxPath, ".nexus", "workflow.json");

  try {
    const content = await fs.readFile(workflowPath, "utf-8");
    const workflow = JSON.parse(content);

    if (!workflow.steps || !Array.isArray(workflow.steps)) {
      broadcast(`\x1b[31m[WORKFLOW ENGINE] Invalid workflow.json structure.\x1b[0m\r\n`, sessionId, taskId);
      return;
    }

    broadcast(`\x1b[36m[WORKFLOW ENGINE] Initiating Sovereign Workflow: ${workflow.name || "Unnamed Task"}...\x1b[0m\r\n`, sessionId, taskId);

    for (const step of workflow.steps) {
      broadcast(`\x1b[35m[WORKFLOW STEP] ${step.name || step.command}\x1b[0m\r\n`, sessionId, taskId);
      
      if (step.background) {
        // Non-blocking execution
        executeTerminalCommand(step.command, sessionId, broadcast, taskId).catch(err => {
          broadcast(`\x1b[31m[WORKFLOW ERROR] Background step failed: ${err.message}\x1b[0m\r\n`, sessionId, taskId);
        });
      } else {
        // Blocking execution
        await executeTerminalCommand(step.command, sessionId, broadcast, taskId);
      }
    }

    broadcast(`\x1b[32m[WORKFLOW ENGINE] Sequence injection complete.\x1b[0m\r\n`, sessionId, taskId);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
       // Silently fail if no workflow exists, or maybe broadcast a notice
    } else {
      broadcast(`\x1b[31m[WORKFLOW ENGINE] Error: ${error.message}\x1b[0m\r\n`, sessionId, taskId);
    }
  }
}
