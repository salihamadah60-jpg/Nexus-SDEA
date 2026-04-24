/**
 * Symbol Service — fast structural index per session.
 *
 * Strategy: tree-sitter when available (TS/TSX/JS via tree-sitter-wasms),
 * regex fallback otherwise. All results persisted to SQLite (`symbols` table)
 * so retrieval/RAG can do O(1) lookups instead of scanning files.
 */
import fs from "fs/promises";
import path from "path";
import { db } from "./stateDb.js";
import { nexusLog } from "./logService.js";

const log = nexusLog("symbolService");

type AnyParser = any;
let _parser: AnyParser = null;
let _langs: Record<string, any> = {};
let _initTried = false;

const WASM_DIR = path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out");
const WASM_MAP: Record<string, string> = {
  ts: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  js: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
};

async function tryInitTreeSitter() {
  if (_initTried) return;
  _initTried = true;
  try {
    const mod: any = await import("web-tree-sitter");
    const Parser = mod.default ?? mod;
    if (typeof Parser.init === "function") await Parser.init();
    _parser = new Parser();
    for (const [ext, file] of Object.entries(WASM_MAP)) {
      try {
        const buf = await fs.readFile(path.join(WASM_DIR, file));
        _langs[ext] = await Parser.Language.load(buf);
      } catch (e: any) {
        log.debug(`grammar ${ext} not loaded: ${e?.message}`);
      }
    }
    log.info(`tree-sitter ready (${Object.keys(_langs).join(",") || "no grammars"})`);
  } catch (e: any) {
    log.warn(`tree-sitter unavailable, using regex fallback: ${e?.message}`);
    _parser = null;
  }
}

export interface Symbol {
  name: string;
  line: number;
  kind: "function" | "class" | "const" | "interface" | "type" | "export" | "import" | "unknown";
  exported: boolean;
}

function regexIndex(content: string): Symbol[] {
  const out: Symbol[] = [];
  const lines = content.split("\n");
  const patterns: Array<{ re: RegExp; kind: Symbol["kind"]; idx: number }> = [
    { re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: "function", idx: 1 },
    { re: /^(?:export\s+)?class\s+(\w+)/, kind: "class", idx: 1 },
    { re: /^(?:export\s+)?interface\s+(\w+)/, kind: "interface", idx: 1 },
    { re: /^(?:export\s+)?type\s+(\w+)\s*=/, kind: "type", idx: 1 },
    { re: /^(?:export\s+)?const\s+(\w+)\s*[:=]/, kind: "const", idx: 1 },
  ];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    for (const p of patterns) {
      const m = trimmed.match(p.re);
      if (m) {
        out.push({
          name: m[p.idx],
          line: i + 1,
          kind: p.kind,
          exported: trimmed.startsWith("export"),
        });
      }
    }
  });
  return out;
}

async function treeSitterIndex(content: string, ext: string): Promise<Symbol[]> {
  const lang = _langs[ext];
  if (!_parser || !lang) return regexIndex(content);
  try {
    _parser.setLanguage(lang);
    const tree = _parser.parse(content);
    const out: Symbol[] = [];
    const walk = (node: any) => {
      if (!node) return;
      const t = node.type;
      let kind: Symbol["kind"] | null = null;
      if (t === "function_declaration") kind = "function";
      else if (t === "class_declaration") kind = "class";
      else if (t === "interface_declaration") kind = "interface";
      else if (t === "type_alias_declaration") kind = "type";
      else if (t === "lexical_declaration") kind = "const";
      if (kind) {
        const nameNode = node.childForFieldName?.("name") ?? node.namedChildren?.find((c: any) => c.type === "identifier");
        if (nameNode) {
          out.push({
            name: nameNode.text,
            line: (node.startPosition?.row ?? 0) + 1,
            kind,
            exported: false,
          });
        }
      }
      for (let i = 0; i < (node.namedChildCount || 0); i++) walk(node.namedChild(i));
    };
    walk(tree.rootNode);
    return out;
  } catch (e: any) {
    log.debug(`tree-sitter parse failed, fallback: ${e?.message}`);
    return regexIndex(content);
  }
}

export async function indexFileSymbols(filePath: string, content: string): Promise<Symbol[]> {
  await tryInitTreeSitter();
  const ext = path.extname(filePath).slice(1);
  const supported = ["ts", "tsx", "js", "jsx"].includes(ext);
  if (!supported) return [];
  return _parser && _langs[ext] ? treeSitterIndex(content, ext) : regexIndex(content);
}

/** Persist symbols to SQLite (replaces prior rows for that file). */
export function persistSymbols(sessionId: string, file: string, symbols: Symbol[]) {
  const d = db();
  const tx = d.transaction(() => {
    d.prepare(`DELETE FROM symbols WHERE session_id=? AND file=?`).run(sessionId, file);
    const ins = d.prepare(`INSERT INTO symbols (session_id, file, name, kind, line, exported) VALUES (?,?,?,?,?,?)`);
    for (const s of symbols) ins.run(sessionId, file, s.name, s.kind, s.line, s.exported ? 1 : 0);
  });
  tx();
}

export function findSymbol(sessionId: string, name: string): Array<{ file: string; line: number; kind: string }> {
  return db().prepare(
    `SELECT file, line, kind FROM symbols WHERE session_id=? AND name=? LIMIT 20`
  ).all(sessionId, name) as any;
}

export function listFileSymbols(sessionId: string, file: string): Symbol[] {
  return db().prepare(
    `SELECT name, line, kind, exported FROM symbols WHERE session_id=? AND file=?`
  ).all(sessionId, file).map((r: any) => ({ ...r, exported: !!r.exported })) as Symbol[];
}

export function symbolStats(sessionId: string) {
  const row = db().prepare(
    `SELECT COUNT(*) as total, COUNT(DISTINCT file) as files FROM symbols WHERE session_id=?`
  ).get(sessionId) as any;
  return { totalSymbols: row.total, indexedFiles: row.files };
}
