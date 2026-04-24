import fs from "fs/promises";
import path from "path";
import { SANDBOX_BASE } from "../config/backendConstants.js";

const DNA_PATH = path.join(process.cwd(), "dna.json");

/**
 * Validates if the target path is protected by the Nexus Sovereign DNA.
 * Implements "The Forbidden Zone" protocol.
 */
export async function isPathProtected(targetPath: string): Promise<boolean> {
  try {
    const dna = JSON.parse(await fs.readFile(DNA_PATH, "utf-8"));
    const protectedPaths: string[] = dna.system_protocols?.knowledge_vault?.protected_paths || [];
    
    const resolvedTarget = path.resolve(targetPath);
    const root = process.cwd();

    return protectedPaths.some(p => {
      const resolvedProtected = path.resolve(root, p);
      return resolvedTarget === resolvedProtected || resolvedTarget.startsWith(resolvedProtected + path.sep);
    });
  } catch {
    // If logic fails, we fail-safe (protect)
    return true;
  }
}

/**
 * Standard guard for all file operations.
 * Enforces sandbox isolation AND the Forbidden Zone.
 */
export async function validatePath(sessionId: string, relativePath: string, isWrite = false): Promise<string> {
  const sandboxPath = path.join(SANDBOX_BASE, sessionId);
  const resolvedTarget = path.resolve(sandboxPath, relativePath);
  
  // 1. Sandbox Isolation Check (Zero-Bleed Matrix)
  if (!resolvedTarget.startsWith(path.resolve(sandboxPath))) {
    throw new Error(`SECURITY FAULT: Zero-Bleed Matrix violation for path ${relativePath}`);
  }

  // 2. Forbidden Zone Check (Kernel Protection)
  if (isWrite) {
    const isProtected = await isPathProtected(resolvedTarget);
    if (isProtected) {
      throw new Error(`SECURITY FAULT: Attempted modification of Forbidden Zone path ${relativePath}`);
    }
  }

  return resolvedTarget;
}
