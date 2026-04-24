import fs from "fs/promises";
import path from "path";
import { SANDBOX_BASE, BLUEPRINT_FILE } from "../config/backendConstants.js";

import { indexFileSymbols } from "./symbolService.js";

export async function getFilesRecursive(dir: string, rootDir: string): Promise<any[]> {
  const items: any[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      const node = {
        id: relativePath,
        name: entry.name,
        type: entry.isDirectory() ? "folder" : "file",
        parentId: path.relative(rootDir, dir) || "root"
      };
      items.push(node);
      if (entry.isDirectory()) {
        items.push(...await getFilesRecursive(fullPath, rootDir));
      }
    }
  } catch {}
  return items;
}

export async function updateBlueprint(update: any, sessionId?: string) {
  const root = sessionId ? path.join(SANDBOX_BASE, sessionId) : process.cwd();
  const blueprintPath = path.join(root, BLUEPRINT_FILE);
  let bp: any = { files: {}, patterns: {}, exports: {}, imports: {} };
  try {
    bp = JSON.parse(await fs.readFile(blueprintPath, "utf-8"));
  } catch {}
  
  if (update.files) bp.files = { ...bp.files, ...update.files };
  if (update.patterns) bp.patterns = { ...bp.patterns, ...update.patterns };
  if (update.exports) bp.exports = { ...bp.exports, ...update.exports };
  if (update.imports) bp.imports = { ...bp.imports, ...update.imports };
  
  await fs.mkdir(path.dirname(blueprintPath), { recursive: true });
  await fs.writeFile(blueprintPath, JSON.stringify(bp, null, 2));
}

export async function syncProjectBlueprint(sessionId: string, filePath: string) {
  try {
    const fullPath = path.join(SANDBOX_BASE, sessionId, filePath);
    const content = await fs.readFile(fullPath, "utf-8");
    
    // Deeper correlation logic: exports, imports, and intent detection
    const exportNames = (content.match(/export (?:const|function|interface|type|class|enum|default) (\w+)/g) || [])
      .map(e => e.replace(/export (?:const|function|interface|type|class|enum|default) /, "").trim());
    
    const importPaths = (content.match(/import .* from ['"](.*)['"]/g) || [])
      .map(i => i.match(/['"](.*)['"]/)?.[1])
      .filter((p): p is string => !!p);
    
    const intent = (content.match(/\/\*\* (.*?) \*\//s)?.[1] || "").trim().slice(0, 100);

    const symbols = await indexFileSymbols(filePath, content);

    await updateBlueprint({
      files: { 
        [filePath]: { 
          purpose: intent || "Nexus Logic Component", 
          lastModified: new Date().toISOString(), 
          size: content.length,
          type: path.extname(filePath).slice(1),
          symbols: symbols
        } 
      },
      exports: { [filePath]: exportNames },
      imports: { [filePath]: importPaths }
    }, sessionId);
  } catch (err) {
    console.error(`Blueprint sync failed for ${filePath}:`, err);
  }
}

export async function buildSovereignContext(sessionId: string): Promise<string> {
  const projectPath = path.join(SANDBOX_BASE, sessionId);
  const bpPath = path.join(projectPath, BLUEPRINT_FILE);
  try {
    const bp = await fs.readFile(bpPath, "utf-8");
    return `\nCROSS-FILE CONSCIOUSNESS (SESSION ${sessionId}):\n${bp}`;
  } catch { return ""; }
}
