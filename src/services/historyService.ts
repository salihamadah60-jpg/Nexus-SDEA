import fs from "fs/promises";
import path from "path";

const HISTORY_DIR = path.join(process.cwd(), ".nexus");
const HISTORY_PATH = path.join(HISTORY_DIR, "history.json");

interface HistoryEntry {
  taskId: string;
  sessionId: string;
  timestamp: string;
  action: "request" | "file_write" | "terminal_exec" | "visual_audit" | "audit_failure" | "intent_mapping";
  details: any;
}

export async function logHistory(entry: HistoryEntry) {
  try {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
    
    let history: HistoryEntry[] = [];
    try {
      const content = await fs.readFile(HISTORY_PATH, "utf-8");
      history = JSON.parse(content);
    } catch {}

    history.push(entry);

    // Limit history to last 500 entries to prevent file bloating
    if (history.length > 500) history = history.slice(-500);

    await fs.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error("Failed to log Nexus history:", err);
  }
}

export function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
