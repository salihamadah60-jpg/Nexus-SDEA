/**
 * Nexus Persistent State — SQLite-backed source of truth.
 *
 * Schemas:
 *   sessions        live + archived chat sessions
 *   tasks           Blackboard tasks (planner→writer→reviewer state)
 *   audits          one row per Reviewer verdict
 *   checkpoints     atomic file-tree snapshots
 *   cost_ledger     per-LLM-call cost & token accounting
 *   dna_patterns    mined Intent→Diff patterns w/ confidence + recency
 *   symbols         file → symbol table (functions, classes, exports)
 *   embeddings      chunk-level vectors (Float32 stored as BLOB)
 *   request_audit   per-request rate-limit + audit log
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { nexusLog } from "./logService.js";

const log = nexusLog("stateDb");
const DB_DIR = path.join(process.cwd(), ".nexus");
const DB_PATH = path.join(DB_DIR, "state.db");

let _db: Database.Database | null = null;

function ensure(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      last_active INTEGER NOT NULL,
      meta TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      parent_id TEXT,
      goal TEXT,
      plan TEXT,           -- JSON array of steps
      current_step INTEGER DEFAULT 0,
      status TEXT,         -- pending|planning|writing|reviewing|done|stasis|failed
      retries INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER,
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    CREATE TABLE IF NOT EXISTS audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      step INTEGER,
      passed INTEGER,
      severity TEXT,
      issues TEXT,         -- JSON array
      reviewer_model TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audits_task ON audits(task_id);

    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      description TEXT,
      file_count INTEGER,
      total_bytes INTEGER,
      created_at INTEGER,
      manifest_path TEXT,
      tree_root TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);

    CREATE TABLE IF NOT EXISTS cost_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      task_id TEXT,
      provider TEXT,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      est_cost_usd REAL,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cost_session ON cost_ledger(session_id);
    CREATE INDEX IF NOT EXISTS idx_cost_created ON cost_ledger(created_at);

    CREATE TABLE IF NOT EXISTS dna_patterns (
      id TEXT PRIMARY KEY,
      intent TEXT,
      summary TEXT,
      diff TEXT,
      uses INTEGER DEFAULT 0,
      successes INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0.5,
      tokens_saved INTEGER DEFAULT 0,
      checksum TEXT,
      created_at INTEGER,
      last_used INTEGER,
      archived INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dna_intent ON dna_patterns(intent);
    CREATE INDEX IF NOT EXISTS idx_dna_active ON dna_patterns(archived, confidence DESC);

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      file TEXT,
      name TEXT,
      kind TEXT,
      line INTEGER,
      exported INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(session_id, file);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      file TEXT,
      chunk_idx INTEGER,
      text TEXT,
      vector BLOB,
      dim INTEGER,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_emb_session ON embeddings(session_id);
    CREATE INDEX IF NOT EXISTS idx_emb_file ON embeddings(session_id, file);

    CREATE TABLE IF NOT EXISTS request_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      ip TEXT,
      session_id TEXT,
      route TEXT,
      status INTEGER,
      duration_ms INTEGER,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_req_ts ON request_audit(ts);
  `);

  log.info(`SQLite ready at ${DB_PATH}`);
  _db = db;
  return db;
}

export function db(): Database.Database { return ensure(); }

/** Convert Float32Array -> Buffer for BLOB storage. */
export function vecToBlob(v: Float32Array | number[]): Buffer {
  const arr = v instanceof Float32Array ? v : new Float32Array(v);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
export function blobToVec(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

/** Cosine similarity between two vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/** Graceful close; flushes WAL. */
export function closeDb() {
  if (_db) {
    try { _db.pragma("wal_checkpoint(TRUNCATE)"); _db.close(); } catch {}
    _db = null;
  }
}
