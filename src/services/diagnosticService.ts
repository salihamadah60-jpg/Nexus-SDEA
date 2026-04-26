import { exec } from "child_process";
import path from "path";
import { promisify } from "util";
import fs from "fs/promises";
import { existsSync } from "fs";
import { SANDBOX_BASE } from "../config/backendConstants.js";

const execPromise = promisify(exec);

export interface DiagnosticResult {
  success: boolean;
  type: "lint" | "css" | "visual" | "system";
  output: string;
  fixable?: boolean;
  autoFixed?: boolean;
}

/**
 * Strip invalid // comments from CSS and return the cleaned content.
 * Returns null if no changes were needed.
 */
function sanitizeCss(css: string): string | null {
  const lines = css.split('\n');
  const cleaned: string[] = [];
  let changed = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//')) {
      changed = true;
      continue;
    }
    if (trimmed.includes('//') && trimmed.includes('@import')) {
      cleaned.push(trimmed.slice(trimmed.indexOf('@import')));
      changed = true;
      continue;
    }
    cleaned.push(line);
  }
  return changed ? cleaned.join('\n') : null;
}

/**
 * Recursive CSS file scanner: find all .css files in the sandbox (excluding node_modules).
 */
async function findCssFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await findCssFiles(full));
      } else if (entry.name.endsWith('.css')) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

/**
 * Diagnostic Sub-routine
 * Detects and auto-fixes known build-breaking issues:
 *  1. Invalid // comments in CSS files (breaks Tailwind v4 Vite plugin)
 *  2. TypeScript lint errors
 */
export async function runDiagnostics(sessionId: string): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  const sandboxPath = path.join(SANDBOX_BASE, sessionId);

  // 1. CSS Hygiene Check — scan all CSS files for invalid // comments
  try {
    const cssFiles = await findCssFiles(sandboxPath);
    const issues: string[] = [];
    const fixed: string[] = [];

    for (const cssPath of cssFiles) {
      const content = await fs.readFile(cssPath, 'utf-8');
      const sanitized = sanitizeCss(content);
      if (sanitized !== null) {
        await fs.writeFile(cssPath, sanitized, 'utf-8');
        fixed.push(path.relative(sandboxPath, cssPath));
        issues.push(`${path.relative(sandboxPath, cssPath)}: removed invalid // comments`);
      }
    }

    if (issues.length > 0) {
      results.push({
        type: "css",
        success: false,
        output: `CSS hygiene issues found and auto-fixed:\n${issues.join('\n')}`,
        fixable: true,
        autoFixed: true
      });
    } else {
      results.push({ type: "css", success: true, output: "No CSS issues detected." });
    }
  } catch (err: any) {
    results.push({ type: "css", success: false, output: `CSS scan error: ${err.message}` });
  }

  // 2. TypeScript Lint Check (if tsconfig.json exists)
  if (existsSync(path.join(sandboxPath, 'tsconfig.json'))) {
    try {
      const { stdout } = await execPromise("npx tsc --noEmit 2>&1", { cwd: sandboxPath, timeout: 30000 });
      results.push({ type: "lint", success: true, output: stdout || "No TypeScript issues detected." });
    } catch (err: any) {
      results.push({
        type: "lint",
        success: false,
        output: err.stdout || err.message,
        fixable: true
      });
    }
  }

  return results;
}
