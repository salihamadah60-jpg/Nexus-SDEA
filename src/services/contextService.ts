import fs from 'fs/promises';
import path from 'path';
import { SANDBOX_BASE } from '../config/backendConstants.js';
import { getFilesRecursive } from './blueprintService.js';

/**
 * Sovereign RAG Engine: Builds a surgical context for the LLM based on task relevance.
 */
export async function buildSemanticRAGContext(sessionId: string, query: string): Promise<string> {
  const sandboxPath = path.join(SANDBOX_BASE, sessionId);
  const blueprintPath = path.join(sandboxPath, '.nexus_blueprint.json');
  
  try {
    const bp = JSON.parse(await fs.readFile(blueprintPath, 'utf-8'));
    const files = bp.files || {};
    const normalizedQuery = query.toLowerCase();

    // 1. Scoring files based on intent, symbols, and keywords
    const matches = Object.entries(files).map(([filePath, meta]: [string, any]) => {
      let score = 0;
      
      // Intent/Purpose match
      if (meta.purpose && normalizedQuery.includes(meta.purpose.toLowerCase())) score += 5;
      
      // Symbol match (High precision)
      if (meta.symbols) {
        meta.symbols.forEach((s: any) => {
          if (normalizedQuery.includes(s.name.toLowerCase())) score += 10;
        });
      }

      // Keyword match in name
      if (normalizedQuery.includes(path.basename(filePath).toLowerCase())) score += 3;

      return { filePath, score };
    }).filter(m => m.score > 0).sort((a, b) => b.score - a.score);

    if (matches.length === 0) {
      // Fallback: Return entry points
      const entryPoints = ['src/App.tsx', 'src/main.tsx', 'package.json', 'vite.config.ts'];
      return await readFiles(sandboxPath, entryPoints);
    }

    // 2. Read top matches (limited to prevent token overflow)
    const targetFiles = matches.slice(0, 8).map(m => m.filePath);
    return await readFiles(sandboxPath, targetFiles);
    
  } catch {
    // Fallback if no blueprint exists
    return "";
  }
}

async function readFiles(root: string, filePaths: string[]): Promise<string> {
  const parts: string[] = [];
  for (const fp of filePaths) {
    try {
      const content = await fs.readFile(path.join(root, fp), 'utf-8');
      parts.push(`\n--- FILE: ${fp} ---\n${content.slice(0, 10000)}`); // Cap at 10k chars per file
    } catch {}
  }
  return parts.join('\n');
}
