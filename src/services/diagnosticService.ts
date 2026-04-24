import { exec } from "child_process";
import path from "path";
import { promisify } from "util";
import { SANDBOX_BASE } from "../config/backendConstants.js";

const execPromise = promisify(exec);

export interface DiagnosticResult {
  success: boolean;
  type: "lint" | "visual" | "system";
  output: string;
  fixable?: boolean;
}

/**
 * Diagnostic Sub-routine
 * Detects and prepares fixes for system or code errors.
 */
export async function runDiagnostics(sessionId: string): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  const sandboxPath = path.join(SANDBOX_BASE, sessionId);

  // 1. Lint Check (if package.json exists)
  try {
    const { stdout, stderr } = await execPromise("npx tsc --noEmit", { cwd: sandboxPath });
    results.push({
      type: "lint",
      success: true,
      output: stdout || "No issues detected."
    });
  } catch (err: any) {
    results.push({
      type: "lint",
      success: false,
      output: err.stdout || err.message,
      fixable: true
    });
  }

  return results;
}
