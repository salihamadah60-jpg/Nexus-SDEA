import fs from 'fs/promises';
import path from 'path';
import { SANDBOX_BASE } from '../config/backendConstants.js';

interface Idea {
  id: string;
  topic: string;
  content: string;
  timestamp: number;
  tags: string[];
  suggested?: boolean;
}

interface IdeationVault {
  concepts: Idea[];
  patterns: Record<string, number>;
}

export async function aggregateIdea(sessionId: string, topic: string, content: string) {
  const vaultPath = path.join(SANDBOX_BASE, sessionId, '.nexus', 'ideation_vault.json');
  let vault: IdeationVault = { concepts: [], patterns: {} };

  try {
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    const existing = await fs.readFile(vaultPath, 'utf-8');
    vault = JSON.parse(existing);
  } catch {}

  const newIdea: Idea = {
    id: `idea-${Date.now()}`,
    topic,
    content,
    timestamp: Date.now(),
    tags: topic.toLowerCase().split(' ').slice(0, 3),
  };

  vault.concepts.push(newIdea);
  
  // Track patterns for proactive suggestions
  newIdea.tags.forEach(tag => {
    vault.patterns[tag] = (vault.patterns[tag] || 0) + 1;
  });

  await fs.writeFile(vaultPath, JSON.stringify(vault, null, 2));
  return newIdea;
}

export async function getProactiveSuggestions(sessionId: string): Promise<string[]> {
  const vaultPath = path.join(SANDBOX_BASE, sessionId, '.nexus', 'ideation_vault.json');
  try {
    const vault: IdeationVault = JSON.parse(await fs.readFile(vaultPath, 'utf-8'));
    // Return top 3 recurring tags as suggestions
    return Object.entries(vault.patterns)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag]) => `Develop more on: ${tag}`);
  } catch {
    return [];
  }
}
