/**
 * Checkpoint Service v2 — atomic full file-tree snapshots (Phase 5.1).
 *
 * Strategy: hard-link every readable sandbox file into
 * .nexus/checkpoints/<id>/tree/, plus a JSON manifest with file hashes.
 * Restore = remove sandbox files (except node_modules/.nexus) and copy back.
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { db } from "./stateDb.js";
import { nexusLog } from "./logService.js";

const log = nexusLog("checkpoint");
const SKIP_DIRS = new Set(["node_modules", ".nexus", ".git", "dist"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB per-file cap

async function* walk(dir: string, root: string): AsyncGenerator<string> {
  let ents: any[] = [];
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(path.join(dir, e.name), root);
    } else if (e.isFile()) {
      yield path.relative(root, path.join(dir, e.name));
    }
  }
}

async function fileSha(p: string): Promise<string> {
  const buf = await fs.readFile(p);
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

export async function createCheckpoint(sessionId: string, description = ""): Promise<string | null> {
  const sandbox = path.join(SANDBOX_BASE, sessionId);
  if (!await fs.stat(sandbox).catch(() => null)) {
    log.warn(`createCheckpoint: sandbox missing for ${sessionId}`);
    return null;
  }
  const id = `cp_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
  const root = path.join(process.cwd(), ".nexus", "checkpoints", id, "tree");
  await fs.mkdir(root, { recursive: true });

  const files: Array<{ path: string; sha: string; size: number }> = [];
  let totalBytes = 0;

  for await (const rel of walk(sandbox, sandbox)) {
    const src = path.join(sandbox, rel);
    let size = 0;
    try { size = (await fs.stat(src)).size; } catch { continue; }
    if (size > MAX_FILE_BYTES) continue;
    const dst = path.join(root, rel);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    try { await fs.link(src, dst); } catch { try { await fs.copyFile(src, dst); } catch { continue; } }
    files.push({ path: rel, sha: await fileSha(src), size });
    totalBytes += size;
  }

  const manifestPath = path.join(process.cwd(), ".nexus", "checkpoints", id, "manifest.json");
  const manifest = { id, sessionId, description, createdAt: new Date().toISOString(), files };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  db().prepare(
    `INSERT INTO checkpoints (id, session_id, description, file_count, total_bytes, created_at, manifest_path, tree_root) VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, sessionId, description, files.length, totalBytes, Date.now(), manifestPath, root);

  log.info(`checkpoint ${id} session=${sessionId}: ${files.length} files, ${(totalBytes / 1024).toFixed(1)} KB`);
  return id;
}

export async function rollbackToCheckpoint(sessionId: string, checkpointId: string): Promise<boolean> {
  const row = db().prepare(`SELECT tree_root FROM checkpoints WHERE id=? AND session_id=?`).get(checkpointId, sessionId) as any;
  if (!row) { log.warn(`rollback: checkpoint not found ${checkpointId}`); return false; }
  const treeRoot: string = row.tree_root;
  const sandbox = path.join(SANDBOX_BASE, sessionId);

  // Wipe sandbox (preserve node_modules + .nexus to keep dev server alive)
  try {
    const ents = await fs.readdir(sandbox, { withFileTypes: true });
    for (const e of ents) {
      if (SKIP_DIRS.has(e.name)) continue;
      await fs.rm(path.join(sandbox, e.name), { recursive: true, force: true });
    }
  } catch {}

  // Copy tree back
  await fs.cp(treeRoot, sandbox, { recursive: true, force: true });
  log.info(`rolled back ${sessionId} → ${checkpointId}`);
  return true;
}

export function listCheckpoints(sessionId: string, limit = 20) {
  return db().prepare(
    `SELECT id, description, file_count, total_bytes, created_at FROM checkpoints WHERE session_id=? ORDER BY created_at DESC LIMIT ?`
  ).all(sessionId, limit);
}

export async function pruneCheckpoints(sessionId: string, keep = 10): Promise<number> {
  const rows = db().prepare(`SELECT id FROM checkpoints WHERE session_id=? ORDER BY created_at DESC`).all(sessionId) as any[];
  const toDrop = rows.slice(keep);
  for (const r of toDrop) {
    const dir = path.join(process.cwd(), ".nexus", "checkpoints", r.id);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    db().prepare(`DELETE FROM checkpoints WHERE id=?`).run(r.id);
  }
  return toDrop.length;
}
