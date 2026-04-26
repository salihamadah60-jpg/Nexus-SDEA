/**
 * NEXUS SOVEREIGN STRESS TEST v1.0
 * Drives every major endpoint and capability.
 * Run with: npx tsx stress_test.ts
 *
 * Reports: PASS / FAIL / WARN per check with timing.
 */

import http from "http";
import https from "https";
import { URL } from "url";

const BASE = `http://localhost:${process.env.PORT || 5000}`;
const SEP  = "─".repeat(72);

let passed  = 0;
let failed  = 0;
let warned  = 0;

function color(s: string, code: number) { return `\x1b[${code}m${s}\x1b[0m`; }
const green  = (s: string) => color(s, 32);
const red    = (s: string) => color(s, 31);
const yellow = (s: string) => color(s, 33);
const cyan   = (s: string) => color(s, 36);
const bold   = (s: string) => color(s, 1);

function pass(label: string, detail = "") {
  passed++;
  console.log(`${green("✔ PASS")} ${label}${detail ? " — " + detail : ""}`);
}
function fail(label: string, detail = "") {
  failed++;
  console.log(`${red("✘ FAIL")} ${label}${detail ? " — " + detail : ""}`);
}
function warn(label: string, detail = "") {
  warned++;
  console.log(`${yellow("⚠ WARN")} ${label}${detail ? " — " + detail : ""}`);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpRequest(
  method: string,
  url: string,
  body?: any,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const start = Date.now();

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data, ms: Date.now() - start }));
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function GET(path: string) { return httpRequest("GET", `${BASE}${path}`); }
async function POST(path: string, body: any) { return httpRequest("POST", `${BASE}${path}`, body); }

function tryJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

// ─── SSE drain helper (for /api/chat which uses streaming) ────────────────────

function drainSSE(
  path: string,
  body: any,
  timeoutMs = 60_000
): Promise<{ events: any[]; raw: string; ms: number }> {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const start = Date.now();
    const events: any[] = [];
    let lineBuffer = "";   // proper line buffer — avoids partial-chunk JSON parse failures
    let raw = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ events, raw, ms: Date.now() - start });
    };

    const req = http.request(
      {
        hostname: "localhost",
        port: parseInt(process.env.PORT || "5000"),
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        if (res.statusCode !== 200) { finish(); return; }

        timer = setTimeout(finish, timeoutMs);

        res.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          raw += text;
          lineBuffer += text;

          // Process only complete lines (split on \n, keep the last partial line in buffer).
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";  // last element may be incomplete

          for (const line of lines) {
            const l = line.trim();
            if (!l.startsWith("data: ")) continue;
            const payload = l.slice(6).trim();
            if (payload === "[DONE]") { finish(); return; }
            const obj = tryJson(payload);
            if (obj) events.push(obj);
          }
        });
        res.on("end", finish);
        res.on("error", finish);
      }
    );
    req.on("error", finish);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Individual test groups ───────────────────────────────────────────────────

async function testHealth() {
  console.log(`\n${bold(cyan("── HEALTH CHECKS ──"))}`);
  const r = await GET("/api/health");
  if (r.status === 200) {
    const body = tryJson(r.body);
    if (body) {
      pass("GET /api/health", `status=${body.status} uptime=${body.uptimeSec}s`);
      if (!["ok", "degraded"].includes(body.status)) fail("health.status is unknown value", body.status);
      if (body.sqlite !== "ok") warn("SQLite not OK", body.sqlite);
      else pass("health.sqlite", body.sqlite);
      if (!body.providers || typeof body.providers !== "object")
        fail("health.providers missing");
      else pass("health.providers present", JSON.stringify(Object.keys(body.providers)));
    } else fail("GET /api/health — invalid JSON", r.body.slice(0, 120));
  } else fail("GET /api/health", `status=${r.status}`);
}

async function testDeployReadiness() {
  console.log(`\n${bold(cyan("── DEPLOY READINESS ──"))}`);
  const r = await GET("/api/deploy/readiness");
  if (r.status === 200) {
    const body = tryJson(r.body);
    if (body) {
      pass("GET /api/deploy/readiness", `score=${body.score}% ready=${body.ready}`);
      for (const c of (body.checks || [])) {
        const label = `  readiness.${c.name}`;
        if (c.ok) pass(label, c.detail);
        else warn(label, c.detail);
      }
    } else fail("GET /api/deploy/readiness — invalid JSON");
  } else fail("GET /api/deploy/readiness", `status=${r.status}`);
}

async function testDNA() {
  console.log(`\n${bold(cyan("── DNA / KNOWLEDGE VAULT ──"))}`);
  const r1 = await GET("/api/dna/active");
  if (r1.status === 200) {
    const body = tryJson(r1.body);
    if (body) {
      pass("GET /api/dna/active", `patterns=${body.patterns?.length ?? 0}`);
    } else fail("GET /api/dna/active — invalid JSON");
  } else fail("GET /api/dna/active", `status=${r1.status}`);

  const r2 = await GET("/api/dna/archived");
  if (r2.status === 200) pass("GET /api/dna/archived");
  else fail("GET /api/dna/archived", `status=${r2.status}`);

  const r3 = await GET("/api/security/dna-checksum");
  if (r3.status === 200) {
    const body = tryJson(r3.body);
    if (body?.ok) pass("GET /api/security/dna-checksum", "integrity verified");
    else warn("GET /api/security/dna-checksum", "mismatch or no baseline: " + r3.body.slice(0, 80));
  } else fail("GET /api/security/dna-checksum", `status=${r3.status}`);
}

async function testKeyPool() {
  console.log(`\n${bold(cyan("── KEY POOL ──"))}`);
  const r = await POST("/api/keypool/reset", {});
  if (r.status === 200) {
    const body = tryJson(r.body);
    if (body?.ok) pass("POST /api/keypool/reset", `provider=${body.provider}`);
    else fail("POST /api/keypool/reset — ok=false", r.body.slice(0, 80));
  } else fail("POST /api/keypool/reset", `status=${r.status}`);
}

async function testBlackboard() {
  console.log(`\n${bold(cyan("── BLACKBOARD ──"))}`);

  const sessionId = `stress-${Date.now()}`;

  const r1 = await GET(`/api/blackboard/tasks?sessionId=${sessionId}`);
  if (r1.status === 200) {
    const body = tryJson(r1.body);
    if (Array.isArray(body?.tasks)) pass("GET /api/blackboard/tasks", `count=${body.tasks.length}`);
    else fail("GET /api/blackboard/tasks — invalid shape", r1.body.slice(0, 80));
  } else fail("GET /api/blackboard/tasks", `status=${r1.status}`);

  // Bad approve request (missing fields) — should return 400
  const r2 = await POST("/api/blackboard/approve", {});
  if (r2.status === 400) pass("POST /api/blackboard/approve (missing fields) → 400");
  else fail("POST /api/blackboard/approve (missing fields)", `expected 400 got ${r2.status}`);
}

async function testCheckpoints() {
  console.log(`\n${bold(cyan("── CHECKPOINTS ──"))}`);
  const sessionId = `stress-${Date.now()}`;

  const r1 = await GET(`/api/checkpoints/${sessionId}`);
  if (r1.status === 200) pass("GET /api/checkpoints/:sessionId", "empty array OK");
  else fail("GET /api/checkpoints/:sessionId", `status=${r1.status}`);

  // Sandbox-less session: should now return 400, not 500.
  const r2 = await POST("/api/checkpoints/create", { sessionId, description: "stress-test" });
  if (r2.status === 400) {
    pass("POST /api/checkpoints/create (no sandbox) → 400", "correctly rejects uninitialised session");
  } else if (r2.status === 200) {
    const body = tryJson(r2.body);
    if (body?.id) pass("POST /api/checkpoints/create", `id=${body.id}`);
    else warn("POST /api/checkpoints/create", "returned 200 but no id: " + r2.body.slice(0, 80));
  } else fail("POST /api/checkpoints/create", `unexpected status=${r2.status}: ${r2.body.slice(0, 100)}`);

  // Missing sessionId → 400
  const r3 = await POST("/api/checkpoints/create", {});
  if (r3.status === 400) pass("POST /api/checkpoints/create (missing sessionId) → 400");
  else fail("POST /api/checkpoints/create (missing sessionId)", `expected 400 got ${r3.status}`);
}

async function testRAG() {
  console.log(`\n${bold(cyan("── RAG / SYMBOL INDEX ──"))}`);
  const sessionId = `stress-${Date.now()}`;

  const r1 = await POST("/api/rag/index", { sessionId });
  if (r1.status === 200) pass("POST /api/rag/index");
  else fail("POST /api/rag/index", `status=${r1.status}`);

  const r2 = await POST("/api/rag/query", { sessionId, q: "react component", topK: 3 });
  if (r2.status === 200) {
    const body = tryJson(r2.body);
    if (Array.isArray(body?.hits)) pass("POST /api/rag/query", `hits=${body.hits.length}`);
    else fail("POST /api/rag/query — invalid shape");
  } else fail("POST /api/rag/query", `status=${r2.status}`);

  const r3 = await GET(`/api/rag/stats/${sessionId}`);
  if (r3.status === 200) pass("GET /api/rag/stats/:sessionId");
  else fail("GET /api/rag/stats/:sessionId", `status=${r3.status}`);
}

async function testDeepseekAndGithub() {
  console.log(`\n${bold(cyan("── PROVIDER STATUS ──"))}`);
  const r1 = await GET("/api/deepseek/status");
  if (r1.status === 200) {
    const body = tryJson(r1.body);
    if (body) pass("GET /api/deepseek/status", `mode=${body.mode}`);
    else fail("GET /api/deepseek/status — invalid JSON");
  } else fail("GET /api/deepseek/status", `status=${r1.status}`);

  const r2 = await GET("/api/github-models/status");
  if (r2.status === 200) {
    const body = tryJson(r2.body);
    if (body) pass("GET /api/github-models/status", `active=${body.active}`);
    else fail("GET /api/github-models/status — invalid JSON");
  } else fail("GET /api/github-models/status", `status=${r2.status}`);
}

async function testQuadGates() {
  console.log(`\n${bold(cyan("── QUAD GATES ──"))}`);
  const sessionId = `stress-${Date.now()}`;
  const r = await POST("/api/quadgates/run", { sessionId });
  if (r.status === 200) {
    const body = tryJson(r.body);
    if (body) pass("POST /api/quadgates/run", `gates=${JSON.stringify(Object.keys(body))}`);
    else fail("POST /api/quadgates/run — invalid JSON");
  } else fail("POST /api/quadgates/run", `status=${r.status}`);
}

async function testCost() {
  console.log(`\n${bold(cyan("── COST LEDGER ──"))}`);
  const sessionId = `stress-${Date.now()}`;
  const r1 = await GET(`/api/cost/session/${sessionId}`);
  if (r1.status === 200) pass("GET /api/cost/session/:sessionId");
  else fail("GET /api/cost/session/:sessionId", `status=${r1.status}`);

  const r2 = await GET("/api/cost/summary?hours=1");
  if (r2.status === 200) {
    const body = tryJson(r2.body);
    if (body) pass("GET /api/cost/summary", `keys=${JSON.stringify(Object.keys(body))}`);
    else fail("GET /api/cost/summary — invalid JSON");
  } else fail("GET /api/cost/summary", `status=${r2.status}`);
}

async function testEnvKeyEndpoint() {
  console.log(`\n${bold(cyan("── ENV-KEY SECURITY ──"))}`);

  // Bad name
  const r1 = await POST("/api/kernel/env-key", { name: "123BAD", value: "x" });
  if (r1.status === 400) pass("POST /api/kernel/env-key (invalid name) → 400");
  else fail("POST /api/kernel/env-key (invalid name)", `expected 400 got ${r1.status}`);

  // Empty value
  const r2 = await POST("/api/kernel/env-key", { name: "STRESS_TEST_KEY", value: "" });
  if (r2.status === 400) pass("POST /api/kernel/env-key (empty value) → 400");
  else fail("POST /api/kernel/env-key (empty value)", `expected 400 got ${r2.status}`);

  // Missing fields
  const r3 = await POST("/api/kernel/env-key", {});
  if (r3.status === 400) pass("POST /api/kernel/env-key (missing fields) → 400");
  else fail("POST /api/kernel/env-key (missing fields)", `expected 400 got ${r3.status}`);
}

async function testRateLimiting() {
  console.log(`\n${bold(cyan("── RATE LIMITING ──"))}`);
  // Chat endpoint has 30/min per IP. Send 31 requests and expect at least one 429.
  const batchSize = 35;
  console.log(`  Sending ${batchSize} concurrent /api/chat requests (no keys — fast degraded path)...`);
  const jobs = Array.from({ length: batchSize }, () =>
    drainSSE("/api/chat", { message: "ping", sessionId: null }, 8000).catch(() => ({ events: [], raw: "", ms: 0 }))
  );
  const results = await Promise.all(jobs);
  const raw429 = await Promise.all(
    Array.from({ length: batchSize }, () =>
      httpRequest("POST", `${BASE}/api/chat`, { message: "ping" })
    )
  );
  const n429 = raw429.filter(r => r.status === 429).length;
  if (n429 > 0) pass("Rate limiter fires", `${n429} of ${batchSize} requests returned 429`);
  else warn("Rate limiter not triggered", `All ${batchSize} requests passed — may need fresh IP window`);
}

async function testChatLive() {
  console.log(`\n${bold(cyan("── CHAT ENDPOINT (live AI build) ──"))}`);

  const sessionId = `stress-session-${Date.now()}`;

  // Turn 1: real build — let the AI build something end-to-end.
  console.log("  T1: Building a counter app with React + Tailwind (real AI)...");
  const t1 = await drainSSE("/api/chat", {
    message: "Build a simple counter app with React and Tailwind",
    sessionId,
  }, 60_000);

  const summaryEvent = t1.events.find(e => e.nexus_summary);
  const fileEvents   = t1.events.filter(e => e.nexus_file_write);
  const chainEvent   = t1.events.find(e => e.nexus_chain);
  const thoughtEvent = t1.events.find(e => e.nexus_thought);
  const doneEvent    = t1.events.find(e => e.nexus_summary?.includes("no providers") || e.nexus_summary?.includes("exhausted"));

  // Chain: planner node fired
  if (chainEvent)    pass("Chat T1: nexus_chain parsed", `steps=${chainEvent.nexus_chain?.length}`);
  else               warn("Chat T1: no nexus_chain event");

  // Files written OR a proper summary = success
  if (fileEvents.length > 0) {
    pass("Chat T1: files written", `${fileEvents.length} file(s)`);
  } else if (doneEvent) {
    pass("Chat T1: degraded-mode summary received (no keys on this provider)");
  } else {
    warn("Chat T1: 0 files written — may be rate-limited or model refused task");
  }

  // Summary event
  if (summaryEvent) pass("Chat T1: nexus_summary received", summaryEvent.nexus_summary?.slice(0, 100));
  else if (fileEvents.length > 0) warn("Chat T1: files written but nexus_summary not parsed (SSE timeout edge case)");
  else fail("Chat T1: no nexus_summary and 0 files");

  if (thoughtEvent)  pass("Chat T1: nexus_thought present (THOUGHT marker parsed)");

  console.log(`  T1 done: ${t1.ms}ms | events=${t1.events.length} | files=${fileEvents.length}`);

  // Turn 2 (follow-up in same session) — core 12.2 regression check.
  // After turn 1 the session has history. The parser must NOT drop FILE markers on T2.
  console.log("  T2: Follow-up prompt in same session (12.2 regression check)...");
  const t2 = await drainSSE("/api/chat", {
    message: "Add a reset button to the counter",
    sessionId,
  }, 60_000);

  const summaryEvent2 = t2.events.find(e => e.nexus_summary);
  const fileEvents2   = t2.events.filter(e => e.nexus_file_write);

  if (summaryEvent2) {
    pass("Chat T2 (follow-up): nexus_summary received", summaryEvent2.nexus_summary?.slice(0, 100));
  } else if (fileEvents2.length > 0) {
    pass("Chat T2 (follow-up): files written (12.2 parser working)", `${fileEvents2.length} file(s)`);
  } else {
    fail("Chat T2 (follow-up): no nexus_summary and 0 files — possible 12.2 regression");
  }

  console.log(`  T2 done: ${t2.ms}ms | events=${t2.events.length} | files=${fileEvents2.length}`);

  // Turn 3 — intentionally a smalltalk to verify intent gating.
  const t3 = await drainSSE("/api/chat", {
    message: "What is React?",
    sessionId,
  }, 30_000);
  const summaryEvent3 = t3.events.find(e => e.nexus_summary);
  if (summaryEvent3) pass("Chat T3 (smalltalk): nexus_summary received", summaryEvent3.nexus_summary?.slice(0, 80));
  else               warn("Chat T3 (smalltalk): no nexus_summary");
  console.log(`  T3 done: ${t3.ms}ms | events=${t3.events.length}`);
}

/** Raw HTTP request with exact path (bypasses URL class normalisation). */
function rawHttpGet(rawPath: string): Promise<{ status: number; body: string; ms: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.request(
      { hostname: "localhost", port: parseInt(process.env.PORT || "5000"), path: rawPath, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data, ms: Date.now() - start }));
      }
    );
    req.on("error", () => resolve({ status: 0, body: "", ms: Date.now() - start }));
    req.end();
  });
}

async function testSandboxPreview() {
  console.log(`\n${bold(cyan("── SANDBOX PREVIEW ──"))}`);

  // Non-existent session → 404 (not a server crash).
  const r1 = await rawHttpGet("/sandbox-preview/nonexistent-session-xyz");
  if (r1.status === 404) pass("GET /sandbox-preview/:nonexistent → 404");
  else fail("GET /sandbox-preview/:nonexistent", `expected 404 got ${r1.status}`);

  // Raw path-traversal with literal dots — our rawUrl guard must fire before Express normalises.
  const r2 = await rawHttpGet("/sandbox-preview/nonexistent-session-xyz/../../../etc/passwd");
  if ([400, 404].includes(r2.status)) pass("Path-traversal (literal ../) blocked", `status=${r2.status}`);
  else fail("Path-traversal (literal ../) NOT blocked", `status=${r2.status} body=${r2.body.slice(0, 80)}`);

  // Encoded traversal  %2e%2e%2f
  const r3 = await rawHttpGet("/sandbox-preview/session%2F..%2F..%2Fetc%2Fpasswd");
  if ([400, 404].includes(r3.status)) pass("Path-traversal (encoded %2F) blocked", `status=${r3.status}`);
  else fail("Path-traversal (encoded %2F) NOT blocked", `status=${r3.status} body=${r3.body.slice(0, 80)}`);

  // Valid session + non-existent file → 404 (no crash).
  const r4 = await rawHttpGet("/sandbox-preview/nonexistent-session-xyz/index.html");
  if (r4.status === 404) pass("GET /sandbox-preview/session/file → 404 when no sandbox");
  else fail("GET /sandbox-preview/session/file", `expected 404 got ${r4.status}`);
}

async function testE2BStatus() {
  console.log(`\n${bold(cyan("── E2B SANDBOX STATUS ──"))}`);
  const r = await GET("/api/e2b/status");
  if (r.status === 200) {
    const body = tryJson(r.body);
    if (typeof body?.active === "boolean") pass("GET /api/e2b/status", `active=${body.active}`);
    else fail("GET /api/e2b/status — unexpected shape");
  } else fail("GET /api/e2b/status", `status=${r.status}`);
}

async function testSecurityNpmAudit() {
  console.log(`\n${bold(cyan("── SECURITY / NPM AUDIT ──"))}`);
  const sessionId = `stress-${Date.now()}`;
  const r = await POST("/api/security/npm-audit", { sessionId });
  if (r.status === 200) {
    const body = tryJson(r.body);
    if (body) pass("POST /api/security/npm-audit", `keys=${JSON.stringify(Object.keys(body))}`);
    else fail("POST /api/security/npm-audit — invalid JSON");
  } else fail("POST /api/security/npm-audit", `status=${r.status}`);
}

async function testDeployWebhookAuth() {
  console.log(`\n${bold(cyan("── DEPLOY WEBHOOK AUTH ──"))}`);
  // If no secret is set, expect 503.
  const r = await POST("/api/deploy/readiness", { secret: "wrong-secret" });
  if ([401, 503].includes(r.status))
    pass("POST /api/deploy/readiness (bad/no secret)", `status=${r.status}`);
  else
    fail("POST /api/deploy/readiness (bad/no secret)", `expected 401|503 got ${r.status}`);
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function run() {
  console.log(bold("\n" + SEP));
  console.log(bold("  NEXUS SOVEREIGN STRESS TEST v1.0"));
  console.log(bold("  Target: " + BASE));
  console.log(bold(SEP));

  const t0 = Date.now();

  // Wait for server to be reachable.
  let attempts = 0;
  while (attempts++ < 10) {
    try {
      await GET("/api/health");
      break;
    } catch {
      await new Promise(r => setTimeout(r, 800));
    }
  }

  await testHealth();
  await testDeployReadiness();
  await testDNA();
  await testKeyPool();
  await testBlackboard();
  await testCheckpoints();
  await testRAG();
  await testDeepseekAndGithub();
  await testQuadGates();
  await testCost();
  await testEnvKeyEndpoint();
  await testSandboxPreview();
  await testE2BStatus();
  await testSecurityNpmAudit();
  await testDeployWebhookAuth();
  await testChatLive();
  await testRateLimiting();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n${bold(SEP)}`);
  console.log(bold("  RESULTS"));
  console.log(`  ${green(`✔ PASSED  : ${passed}`)}`);
  console.log(`  ${failed > 0 ? red(`✘ FAILED  : ${failed}`) : `✘ FAILED  : ${failed}`}`);
  console.log(`  ${warned  > 0 ? yellow(`⚠ WARNINGS: ${warned}`) : `⚠ WARNINGS: ${warned}`}`);
  console.log(`  Total: ${passed + failed + warned} checks in ${elapsed}s`);
  console.log(bold(SEP + "\n"));

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(red("FATAL:"), e);
  process.exit(1);
});
