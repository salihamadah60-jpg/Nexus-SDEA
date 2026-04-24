import fs from "fs/promises";
import path from "path";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { killPid, findPidsOnPort } from "./portService.js";

const JOURNAL_DIR = path.join(process.cwd(), ".nexus");
const JOURNAL_PATH = path.join(JOURNAL_DIR, "journal.json");

interface JournalEntry {
  status: "idle" | "building" | "starting" | "ready";
  sessionId: string;
  port?: number;
  timestamp: string;
  taskId?: string;
}

export async function writeJournal(entry: JournalEntry) {
  try {
    await fs.mkdir(JOURNAL_DIR, { recursive: true });
    await fs.writeFile(JOURNAL_PATH, JSON.stringify(entry, null, 2));
  } catch (err) {
    console.error("Failed to write to Nexus Journal:", err);
  }
}

export async function readJournal(): Promise<JournalEntry | null> {
  try {
    const content = await fs.readFile(JOURNAL_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Pre-flight Cleanup: Recovers system from incomplete states identified in the journal.
 * Implementation of Self-Healing protocol.
 */
export async function performPreFlightCleanup() {
  const journal = await readJournal();
  if (!journal) return;

  if (journal.status === "building" || journal.status === "starting") {
    console.log(`🧬 Nexus Journal: Incomplete state detected for session ${journal.sessionId}. Recovering...`);
    
    if (journal.port) {
      console.log(`🧬 Self-Healing: Clearing port ${journal.port}...`);
      try {
        const pids = await findPidsOnPort(journal.port);
        for (const pid of pids) {
          if (pid !== process.pid) await killPid(pid);
        }
      } catch (err) {
        console.error("Self-Healing port cleanup failed:", err);
      }
    }

    // Reset journal state to idle after cleanup
    await writeJournal({
      status: "idle",
      sessionId: journal.sessionId,
      timestamp: new Date().toISOString()
    });
    
    console.log("🧬 Pre-flight Cleanup complete. System stabilized.");
  }
}
