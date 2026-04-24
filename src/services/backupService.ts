import fs from "fs/promises";
import path from "path";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { getFilesRecursive } from "./blueprintService.js";

export async function createBackup(sessionId: string, filePaths: string[]) {
  const projectPath = path.join(SANDBOX_BASE, sessionId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(projectPath, ".nexus", "backup", timestamp);
  
  await fs.mkdir(backupDir, { recursive: true });
  
  for (const filePath of filePaths) {
    const fullPath = path.join(projectPath, filePath);
    const destPath = path.join(backupDir, filePath);
    try {
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(fullPath, destPath);
    } catch {}
  }
  return timestamp;
}

export async function rollback(sessionId: string, backupId: string) {
  const projectPath = path.join(SANDBOX_BASE, sessionId);
  const backupDir = path.join(projectPath, ".nexus", "backup", backupId);
  
  const files = await getFilesRecursive(backupDir, backupDir);
  for (const file of files) {
    if (file.type === "file") {
      const srcPath = path.join(backupDir, file.id);
      const destPath = path.join(projectPath, file.id);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);
    }
  }
}
