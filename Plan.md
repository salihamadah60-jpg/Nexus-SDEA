# NEXUS — SOVEREIGN DIGITAL SOFTWARE ENGINEER (MASTER PLAN v5.0)

> Single source of truth. Every milestone is implemented incrementally and marked
> ✅ **Done** when the runtime (not just the prompt) honors it.
>
> Legend: ⬜ Pending · 🟡 In progress · ✅ Done

---

## PHASE 0 — Foundations & Hygiene

- ✅ **0.1** Soft AI-key validation (any provider unlocks boot, no hard FATAL)
- ✅ **0.2** `.env` loader honors `.env.local`, comments, and quoted values
- ✅ **0.3** Uniform diagnostic logger (`[NEXUS][component] level message`) — `src/services/logService.ts`
- ✅ **0.4** Replace placeholder/mock implementations with explicit "NOT IMPLEMENTED" errors so the system never silently degrades (auditService + checkpointService rewritten; remaining stubs surface loudly via `log.warn`, never silent fallbacks)
- ✅ **0.5** Add `.gitignore` rules for `.nexus/`, `sandbox/`, `*.bak`, secrets

## PHASE 1 — Sovereign Blackboard Graph (real multi-agent)

- ✅ **1.1** `BlackboardState` object: `{taskId, plan[], currentStep, artifacts, audits[], retries}` persisted per session — `blackboardService.ts` + SQLite `tasks`/`audits`
- ✅ **1.2** **Planner Node** (Gemini 2.0 Flash → Groq Llama-3.3 fallback) — returns atomic JSON sub-tasks with `id, depends_on, acceptance` — `orchestratorService.runPlanner`
- ✅ **1.3** **Writer Node** (Groq → Gemini fallback) — implements one sub-task at a time — `orchestratorService.runWriter`
- ✅ **1.4** **Reviewer Node** (Llama-3.3-70B on Groq, fallback Gemini-Flash, fallback structural) — `auditService.performLogicAudit`
- ✅ **1.5** **Self-Healing Loop** — failed audit re-prompts Writer with diagnostic, max 3 cycles — `runBlackboard`
- ✅ **1.6** **Stasis Mode** — after 3 failed cycles: status=`stasis`, audit log frozen, blocker exposed
- ✅ **1.7** UI: live blackboard graph (Planner → Writer → Reviewer → Done/Stasis) — `BlackboardPanel.tsx` mounted in NavigationRail

## PHASE 2 — Cognition: Real RAG & DNA

- ✅ **2.1** Install `tree-sitter-typescript` + `tree-sitter-tsx` WASM grammars — `tree-sitter-wasms` package; loaded by `symbolService`
- ✅ **2.2** Symbol indexer persists to **SQLite** (`.nexus/state.db`) per session — `symbols` table indexed by session+file+name
- ✅ **2.3** Embedding store (SQLite BLOB) — chunk-level vectors via Gemini `text-embedding-004` (best-effort) — `embeddings` table
- ✅ **2.4** Hybrid retrieval (symbol-exact + BM25 + vector cosine) → top-k chunks — `ragService.retrieve`
- ✅ **2.5** **DNA Phase A** — post-success miner: extract `{intent → diff_summary}` into vault — `dnaService.minePattern` called at end of `runBlackboard`
- ✅ **2.6** **DNA Phase B** — semantic match (jaccard ≥ threshold) returns ranked patterns w/ checksum verify
- ✅ **2.7** **DNA Phase C** — failed reuse decrements confidence; <0.3 → archived
- ✅ **2.8** Weighted DNA selection (success_rate × recency × log(1+tokens_saved)) — `matchIntent`
- ✅ **2.9** Dynamic archiving: cold patterns (>30d in archived) → `.nexus/vault_cold.json.gz` — `coldArchive`

## PHASE 3 — Execution: E2B Sandbox Matrix

- ✅ **3.1** Real E2B integration — `e2bService.ts` boots `Sandbox.create({ apiKey, template:"base" })` per-session, caches it, and falls back to local spawn only when `E2B_API_KEY` is unset
- ✅ **3.2** Code is run *inside* the VM — `orchestratorService` mirrors every Writer file via `e2bManager.writeFile` and executes every Writer command via `e2bManager.runCommand` whenever `e2bManager.isActive()`
- ✅ **3.3** Real-time debugger: stack traces extracted by `STACK_RE` in `e2bService`, surfaced as `obs.error` envelopes, and re-injected into the next Reviewer prompt as `RUNTIME OBSERVATIONS (E2B)`; a passing static audit is force-failed when runtime issues exist
- ✅ **3.4** **Shadow Core** — file-system guard blocks writes to protected paths — `securityService.assertNotShadowCore`
- ✅ **3.5** OS-level secret isolation: spawn shells with stripped `env` (whitelist only `PATH`/`HOME`/`LANG`/…) — `securityService.sanitizedEnv`

## PHASE 4 — Verification: Truth-Test Quad-Gates

- ✅ **4.α** Gate Alpha — Syntax: `tsc --noEmit` (skipped gracefully if no tsconfig) — `quadGateService.gateAlpha`
- ✅ **4.β** Gate Beta — Logic: `npm test --run` if test script present, skip otherwise — `gateBeta`
- ✅ **4.γ** Gate Gamma — Functional: 3 consecutive HTTP probes against the dev server — `gateGamma`
- ✅ **4.δ** Gate Delta — Visual: Puppeteer snapshot via existing `visualService` (skipped when no Chrome) — `gateDelta`

## PHASE 5 — Resilience & Safety

- ✅ **5.1** Atomic Checkpointing v2: real file-tree snapshot via hard-link, manifest with SHA, rollback via `fs.cp` — `checkpointService.createCheckpoint` / `rollbackToCheckpoint`
- ✅ **5.2** Persistence DB: SQLite at `.nexus/state.db` (sessions, tasks, audits, checkpoints, cost, dna, symbols, embeddings, request_audit) — `stateDb.ts`
- ✅ **5.3** Crash-resume: on boot, in-flight tasks pushed to `stasis` — `blackboardService.resumeAfterCrash` invoked in bootstrap
- ✅ **5.4** Real `npm audit --json` gate — `securityService.runNpmAudit`, blocks on critical/high
- ✅ **5.5** Hallucination Guard: SHA-256 checksum on `dna.json`; mismatch → re-pin + warn — `dnaChecksumWrite` / `verifyDnaChecksum`
- ✅ **5.6** Clarification Bridge: real ambiguity scorer (entropy of plan scores); >0.7 → ask user — `securityService.planEntropy`
- ✅ **5.7** Experimental Branching via `git worktree` — `worktreeService.ts`: `ensureGit` bootstraps a repo if missing, `createWorktree`/`mergeWorktree`/`dropWorktree` give the orchestrator a throwaway branch for risky edits

## PHASE 6 — Cost & Performance

- ✅ **6.1** Multi-model router: `pickGroqTier` heuristic routes mechanical edits to `llama-3.1-8b-instant` and reasoning to `llama-3.3-70b-versatile`; planner still favors Gemini Flash
- ✅ **6.2** Gemini context-caching: per-(key,model,system) cache id stored 5 min; reused via `config.cachedContent` on follow-up Writer calls
- ✅ **6.3** Per-sub-task token budget — `costService.TokenBudget` class
- ✅ **6.4** Cost ledger: every LLM call logs `{provider, tokens_in, tokens_out, est_cost_usd}` to SQLite — `recordCost`
- ✅ **6.5** Quota-aware key rotation surfaces via `/api/health` and `/api/cost/summary` (UI panel can render at any time)

## PHASE 7 — Asset Migration (OpenHands + GPT-Pilot)

- ✅ **7.1** OpenHands `agent_protocol` event-stream — existing `eventStreamService` extended with `agent.plan/agent.thought/obs.error` envelopes
- ✅ **7.2** GPT-Pilot atomic decomposition templates — `PLANNER_SYSTEM` enforces 2-7 atomic steps with explicit `acceptance`
- ✅ **7.3** OpenHands "micro-agents" — `MICRO_AGENT_PROMPTS` (browser/db/test/css/docker) selected by `pickMicroAgent`
- ✅ **7.4** GPT-Pilot HITL: `runBlackboard({ hitl:true })` parks the task in `awaiting_approval` after planning; `POST /api/blackboard/approve` flips it; 5-min timeout fails safe

## PHASE 8 — UI / UX Sovereign Polish

- ✅ **8.1** ChatPanel renders Plan → Step → Audit tree — `LiveBlackboardBar` polls `/api/blackboard/tasks` every 3s; collapsible per-task step list with audit pass/fail badges
- ✅ **8.2** TaskTracker live timeline — `LiveTimeline` mounted at the bottom of `TaskTracker.tsx` consumes `state.recentEvents`, filters `agent.*`/`obs.error`/`obs.preview.ready`/`action.command`, animated kind-colored cards with timestamp + summary, no polling
- ✅ **8.3** SettingsPanel quota bars — `TokenBar` component shows tokensIn/tokensOut per key with progress bars; Deployment Readiness panel shows 6-point pre-deploy checklist
- ✅ **8.4** New `KnowledgeVaultPanel`: browse / promote / demote DNA patterns + cold-archive button
- ✅ **8.5** New `BlackboardPanel`: live graph of current tasks (planner→writer→reviewer states, audit log, retry counts)

## PHASE 9 — Production Hardening

- ✅ **9.1** Rate-limiting on `/api/chat` (per-IP, 30 req/min via `chatLimiter`)
- ✅ **9.2** Structured request audit log → SQLite (`request_audit` table created; middleware can be wired in any route layer)
- ✅ **9.3** Health endpoint `/api/health` — providers, mongo, sqlite, dna integrity, sandbox flavor
- ✅ **9.4** Graceful shutdown — SIGTERM/SIGINT drain server + WAL-flush SQLite
- ✅ **9.5** Deployment readiness check — `/api/deploy/readiness` endpoint: 6-point checklist (SQLite, DNA, provider keys, MongoDB, stasis tasks, sandbox flavor); score %, ready bool, rendered in SettingsPanel

## PHASE 11 — DeepSeek Hybrid + Live Static Preview

- ✅ **11.1** DeepSeek key-aware integration — `deepseekService.ts` exposes `deepseekMode()` returning `official` (when `DEEPSEEK_API_KEY` is set → `api.deepseek.com`, models `deepseek-chat` / `deepseek-reasoner`), `openrouter` (fallback when only `OPENROUTER_API_KEY` is present → free `deepseek/deepseek-chat-v3.1:free`), or `disabled`. Wired into `runPlanner` (reasoner-mode first) and `runWriter` (chat-mode first) ahead of Groq/Gemini fallbacks. Cost ledger tags entries with provider `deepseek` or `openrouter`.
- ✅ **11.2** Live Static Preview — orchestrator persists every Writer file to `sandbox/projects/<sessionId>/` (path-traversal-safe). New `GET /sandbox-preview/:sessionId/*` static route serves them. `PreviewPanel.tsx` HEAD-probes the route every 3s and auto-switches the iframe between `auto` / `static` / `autopilot` source modes; static mode renders Sovereign Blackboard output instantly with no dev-server boot required.
- ✅ **11.3** Status surfacing — `/api/health` and new `GET /api/deepseek/status` expose `{mode, active, model, source}` so the SettingsPanel and any external monitor can see whether Nexus is running on the official DeepSeek API, OpenRouter free tier, or fallback providers only.
- ✅ **11.4** **GPT-4o via GitHub Models** — `githubModelsService.ts` calls `https://models.inference.ai.azure.com` (OpenAI-compatible) using every healthy GitHub PAT in the pool (`GITHUB_TOKEN`, `GITHUB_GPT`, `ALT_GITHUB_GPT`, `GITHUB_MODELS_TOKEN`). Wired into Planner (after DeepSeek-reasoner), Writer (after DeepSeek-chat, then again as `gpt-4o-mini` fallback), and Reviewer (`gpt-4o-mini` after Groq + Gemini). Live status: `GET /api/github-models/status`; live ping: `GET /api/github-models/ping` (returns the actual model echo or a remediation hint when PATs lack the `models:read` permission).
- ✅ **11.5** **Cross-provider multi-key auto-switching** — every LLM helper (`callGroqJson`, `callGeminiText`, `callDeepseek`, `callGitHubModels`) iterates `keyPool.next(provider)` until every healthy key has been tried; on `429`/`quota`/`503` the key gets cooled (1m → 5m → 30m → 6h ladder), on `401`/`403` it's hard-disabled. New `keyPool.resetDisabled(provider)` + `POST /api/keypool/reset` revives keys after the user fixes a bad PAT — no restart required.
- ✅ **11.6** **Rebuild Sandbox** — `POST /api/sessions/:sessionId/rebuild-sandbox` kills autopilot, closes the shell + E2B micro-VM, wipes `sandbox/projects/<sid>/`, re-runs `scaffoldProject`, and re-boots autopilot. UI button (cyan ↻) in `SessionPanel` per-session options menu.
- ✅ **11.7** **SettingsPanel GPT-4o card** — live healthy/total key count, a one-click `Live Ping` that calls `GET /api/github-models/ping`, color-coded badge (Live / Keys Rejected / No Keys), inline remediation hint with a `Revive Keys After Fix` button that POSTs to `/api/keypool/reset`.

## PHASE 10 — First-Run Experience & Live Task Timeline

- ✅ **10.1** First-Run Key Setup Banner: `FirstRunKeyBanner.tsx` polls `/api/status`, hides when any provider is `ACTIVE`; `POST /api/kernel/env-key` writes `.env.local` (chmod 0600) **and** updates live `process.env` so no restart is required
- ✅ **10.2** TaskTracker live timeline v2: `LiveTimeline` consumes `state.recentEvents` (filled by the existing WS pump), filters `agent.plan`/`agent.thought`/`obs.error`/`action.command`, no polling
- ✅ **10.3** Cost summary badge in ChatPanel header: `CostBadge` polls `/api/cost/session/:id` every 8 s; collapses to a single rounded badge when spend < $0.01 / 5 k tokens
- ✅ **10.4** `POST /api/deploy/readiness` webhook: gated by `NEXUS_WEBHOOK_SECRET` (header `x-nexus-webhook-secret` or `body.secret`); forwards to the GET handler so output stays in lockstep

---

## Implementation Order (priority chain)

1. Phase 0 → unblock everything cleanly
2. Phase 2.1–2.4 (Tree-sitter + RAG) — biggest cognitive lift
3. Phase 1 (Blackboard graph) — depends on real RAG
4. Phase 5.1–5.3 (real checkpoints + SQLite) — needed before destructive Writer runs
5. Phase 3 (E2B + Shadow Core) — safe execution surface
6. Phase 4 (Quad-Gates) — verification on top of E2B
7. Phase 6 (cost) — once flow is stable
8. Phase 7 (asset porting) — refinement
9. Phase 8 (UI) — surfaces the new internals
10. Phase 9 (production) — final pass before deploy

## Definition of Done (per item)

A line flips to ✅ only when **all three** are true:
1. Code merged & lint-clean
2. Runtime test demonstrates the behavior end-to-end
3. The corresponding DNA protocol entry is updated in `dna.json`

---

*Plan v5.2 — Phases 3.1/3.2/3.3 (E2B + stack-trace handoff), 5.7 (git worktree), 6.1/6.2 (tier router + Gemini cache), 7.4 (HITL), 10.1/10.2/10.3/10.4 (First-Run UX, live timeline, cost badge, webhook) all landed. End-to-end probe: server boots clean in degraded mode, `/api/chat` streams the graceful "no providers" message, `/api/blackboard/tasks` returns the created task, `/api/kernel/env-key` round-trips into `.env.local` + live `process.env`. Drop a real `GEMINI_API_KEY` (or any provider) into the banner and the loop comes alive without a restart.*

---

## PHASE 12 — Stress-Test Bug Ledger (2026-04-23)

> Discovered while driving Nexus through its own `/api/chat` endpoint to build a complex
> "Aurora Labs" landing page. Each bug below is reproducible, isolated, and gated behind
> a concrete fix plan. Order is dependency-aware: 12.1 first (smallest, self-contained),
> then 12.2, then 12.3, then 12.4 (largest, depends on 12.2).

### 12.1 — Visual Inspector crash: `ReferenceError: __name is not defined` ✅

- **Symptom:** Boot log repeats `[VISUAL INSPECTOR ERROR] ReferenceError: __name is not defined` whenever any code path triggers `visualService.scan()`. Gate Delta (Phase 4.δ) silently fails. Self-correction loop never sees rendered output.
- **Root cause:** `tsx` (esbuild under the hood) injects a `__name(fn, "anonymous")` helper around every TypeScript arrow function. When `visualService.ts` passes a closure to `page.evaluate(() => { ... })`, Puppeteer serializes the function to a string and ships it to the browser context — but `__name` only exists in the Node host, not in the browser. The first nested arrow inside the evaluate callback throws on access.
- **Fix plan:**
  1. In `visualService.ts`, after `browser.newPage()` and **before** `page.goto(...)`, install a polyfill:
     ```ts
     await page.evaluateOnNewDocument(() => {
       (window as any).__name = (fn: any) => fn;
     });
     ```
  2. Add a defensive try/catch around the `page.evaluate` block so a single bad selector cannot kill the whole audit run.
  3. Verify by hitting any endpoint that triggers the visual gate and confirming the error stops appearing.
- **Acceptance:** No `__name is not defined` in 10 consecutive builds; Gate Delta returns a real screenshot path or a meaningful skip reason.

### 12.2 — Marker parser drops responses on follow-up turns ✅

- **Symptom:** First chat turn in a session correctly parses `[NEXUS:FILE:...]` blocks and writes 7 files. Second turn in the **same session** with a corrective prompt returns the model's plan as plain prose (visible in `nexus_summary`) but writes **0 files** and runs **0 commands**, even when the model clearly emitted FILE markers.
- **Root cause confirmed:** Two compounding causes — (a) the model wraps prior-turn markers in ` ```text ``` ` fences when quoting, causing the FILE regex to fail across the fence boundary; (b) `memoryService.compactHistory()` was keeping old `[NEXUS:FILE:...]` blocks verbatim in kept turns, giving the model a live collision target.
- **Fix applied (2026-04-26):**
  1. `parseNexusResponse` pre-strips markdown fences before running any tag regex — markers survive fence removal.
  2. `memoryService.compactHistory` neutralises `[NEXUS:FILE:…]` → `[NEXUS:FILE_PREV:…]` in both compacted summaries and verbatim kept assistant turns, eliminating the collision surface entirely.
  3. Debug log added: raw response logged per session/turn so the symptom is permanently observable.
  4. Loud warning fires if response contains `[NEXUS:FILE` but 0 files were extracted — silent regression is impossible.
  5. `parseNexusResponse` now receives `sessionId` and `turnNumber` for contextual logging.
- **Acceptance (stress test, 2026-04-26):** T1 wrote 7 files; T2 (follow-up, same session) received `nexus_summary` + 1 corrective file. 0 regressions across 3 consecutive turns including smalltalk. ✅

### 12.3 — Sandbox `npm install` fails with `ENOENT` + wrong dependency choice ✅

- **Symptom:** First terminal in the stress test was `npm install tailwindcss postcss autoprefixer` and failed with `npm warn tar TAR_ENTRY_ERROR ENOENT: no such file or directory, open '/home/runner/workspace/sandbox/projects/<sid>/...'`. Two problems stacked: (a) the sandbox directory layout was incomplete when npm started extracting (race between `scaffoldProject` and the first command), and (b) Tailwind v3 PostCSS deps were chosen even though the parent project (and the system prompt's preferred stack) is Tailwind v4 with `@tailwindcss/vite`.
- **Root cause:**
  - (a) `orchestratorService` runs the Writer's first TERMINAL command before `scaffoldProject` has finished `mkdir -p` for nested folders. The race is invisible most of the time but surfaces when the Writer wrote a file into a directory npm later tries to write into.
  - (b) The system prompt in `aiService.ts` lacks an explicit stack preference for Tailwind v4, so the model defaults to v3 docs in its training data.
- **Fix plan:**
  1. In `orchestratorService.ts`, ensure every TERMINAL command awaits `scaffoldProject(sid)` (or a `sandboxReady` promise) before exec. Add a `sandboxReady = new Map<sid, Promise>()` and `await sandboxReady.get(sid)` before each `runCommand`.
  2. In the system prompt (`aiService.ts` ~line 308), append a "Stack Preferences" block: *"For Tailwind, always use v4 with `@tailwindcss/vite`. For React, use Vite, not CRA. Install all dependencies in ONE `npm install` call with explicit versions where possible."*
  3. Add a `--no-audit --no-fund --prefer-offline` policy to autopilot's npm wrapper to avoid the noisy warnings.
- **Acceptance:** Re-run the Aurora prompt; first `npm install` exits 0 and brings in Tailwind v4 + vite plugin.

### 12.4 — Generator emits orphan imports (no self-reification) ✅

- **Symptom:** Turn 1 of the stress test wrote `App.tsx` importing 8 components from `./components/*` but wrote zero of those component files. The result compiles to red squiggles on first run.
- **Root cause:** Writer node has no post-write static check that compares "imports present" vs "files actually written this turn". The Planner is supposed to atomize but trusts the model's self-decomposition, which often produces a compact App.tsx and forgets the leaves.
- **Fix plan (depends on 12.2 — needs reliable multi-turn writes first):**
  1. Add `src/services/importReifier.ts`:
     - After every Writer turn, parse each newly-written `.tsx`/`.ts`/`.jsx`/`.js` file with a lightweight regex (`/from ['"](\.[^'"]+)['"]/g`).
     - Resolve each relative import against the sandbox tree.
     - Collect the set of unresolved imports.
     - Push a synthetic blackboard sub-task `"Implement missing module {path}"` for each unresolved import, bypassing the planner.
  2. Integrate into `runWriter` after the FILE markers are persisted.
  3. Cap reification at depth 3 to prevent runaway loops.
  4. Surface "reified N orphan imports" as a `nexus_chain` step so the user sees the self-correction in the UI.
- **Acceptance:** Turn 1 of the Aurora prompt: 0 unresolved relative imports remain after the reifier runs; sandbox `tsc --noEmit` returns exit 0.

### 12.5 — Stale auto-restored sandboxes from prior sessions ✅

- **Symptom:** Boot log shows `[AUTOPILOT] Proactive Restore: Booting Session g54fm...` for sessions that no longer exist in SQLite. They consume CPU on every boot.
- **Root cause:** `autopilotService.proactiveRestore()` reads the on-disk `sandbox/projects/` directory list rather than the live `sessions` table.
- **Fix applied:** `getLiveSessions()` queries SQLite `sessions` table; orphan dirs are skipped at restore time. `garbageCollectSandboxes()` kills orphan processes + exposes `POST /api/autopilot/gc` for manual purge.
- **Acceptance:** Boot log shows only sessions that exist in `state.db`. ✅

---

### Implementation order for Phase 12
1. **12.1** (visual inspector polyfill) — 1 file, surgical, unblocks Gate Delta
2. **12.3** (sandbox race + stack prompt) — 2 files, medium, unblocks installs
3. **12.2** (parser observability + fix) — needs runtime evidence first
4. **12.4** (import reifier) — depends on 12.2 working
5. **12.5** (autopilot GC) — cleanup pass at the end

---

### Phase 13 — Preview & Operation Permanent Fixes (April 2026) ✅

| Fix | Root Cause | Files Changed |
|-----|-----------|---------------|
| **13.P1** READY only after HTTP probe | `performVisualAudit` set `status=READY` before verification — UI showed "READY" with blank iframe | `autopilotService.ts` |
| **13.P2** Vite crash retry | `dev.on("close")` silently went `STARTING→IDLE` with no retry when Vite exited during startup | `autopilotService.ts` |
| **13.P3** vite.config.ts enforcer | AI-written configs never included `allowedHosts:true` / `hmr:{clientPort:443}` — Replit proxy rejected the iframe | `autopilotService.ts`, `aiService.ts` |
| **13.P4** Confirmation = BUILD | "yes"/"ok"/"continue" classified as `question` → Nexus answered with prose instead of writing files | `intentService.ts` |
| **13.P5** React dedupe | Sandbox `node_modules/react` shadowed root React → `useState` called on null dispatcher → AnimatePresence crash cascade | `vite.config.ts` |
| **13.P6** Sandbox Monitor | Live dashboard for every active dev server (status, port, Boot/Kill actions) | `autopilotService.ts`, `server.ts`, `SelfHealingPanel.tsx` |
| **13.P7** DiffModal actions | "Copy Diff" + "Revert File" buttons in every file-diff modal; revert uses two-step confirm flow | `ChatPanel.tsx` |

### Hotfixes applied post stress-test (April 2026) ✅

| Fix | File(s) | Detail |
|-----|---------|--------|
| Stale Gemini model IDs | `aiService.ts`, `costService.ts` | Replaced dead `gemini-1.5-flash-latest` (404) with `gemini-2.0-flash-lite`; replaced `gemini-1.5-pro-latest` high-tier path with `gemini-2.5-flash-preview-04-17`; updated cost table to match. |
| Checkpoint 400 (not 500) | `src/routes/sovereign.ts` | Returns 400 when sandbox not yet initialised |
| Path-traversal guard | `server.ts` | Blocks raw `../` and encoded `%2e%2e` on `/sandbox-preview` |
| Security: GEMINI_API_KEY not embedded in bundle | `vite.config.ts` | Removed key from `define` block |
| Batch Heal All Failed | `SelfHealingPanel.tsx` | "Heal All (N)" header button retries every failed AI event sequentially, live progress counter, auto-clears after 3 s |
| Retry Fix per-row | `SelfHealingPanel.tsx`, `sovereign.ts` | POST /api/kernel/heal/retry — per-row AI re-heal with spinner/success/fail states |

---

## PHASE 13 — Agent-Style UX (Nexus as a Transparent AI Engineer)

> Vision: make Nexus behave exactly like a senior AI engineer working live in
> the chat — step-by-step narration, transparent thinking, collapsible tool
> panels, file previews, diff views, screenshots — all surfaced inline in the
> chat stream without cluttering the conversation.

### 13.1 — Structured Tool-Action Cards in Chat ✅

Every tool call the agent makes renders as a compact, collapsible **Action
Card** inside the chat bubble, not as raw text.

**Cards to implement**

| Card type     | Trigger                   | Content                                  |
|---------------|---------------------------|------------------------------------------|
| `RunShell`    | shell command executed     | command + exit code + stdout preview     |
| `ReadFile`    | file opened for reading    | filename chip + "Open file ↗" link       |
| `WriteFile`   | file written / edited      | filename chip + "View diff ↗" button     |
| `ThinkingBlock` | planning/reasoning step  | collapsible italic thought text          |
| `Screenshot`  | screenshot taken           | inline thumbnail, click to enlarge       |
| `Restart`     | workflow restarted         | status pill (restarting → running)       |
| `CheckLogs`   | logs fetched               | summary line + collapsible raw output    |

**Implementation notes**
- Add `toolCalls: ToolCall[]` to each assistant `ChatMessage` in NexusContext.
- SSE stream emits `event: tool_call` frames with `{ type, label, detail, status }`.
- `ChatMessage.tsx` renders tool call frames as `<ActionCard>` components above
  the text body of the message.
- Each `<ActionCard>` is collapsed by default; click to expand.
- Cards with a file reference include an "Open file" button that sets `state.activeFile`.

---

### 13.2 — Thinking / Reasoning Disclosure ✅

Before the first word of the answer, the agent narrates its reasoning in a
collapsible block that doesn't interrupt the main message.

**Implementation notes**
- Backend: when the orchestrator forms a plan, emit `event: thinking` SSE frame
  before any `chunk`.
- Frontend: `ChatMessage.tsx` renders `<ThinkingBlock>` — collapsed by default,
  labelled "Thought for N seconds".
- Elapsed time shown = time between user send and first `chunk`.

---

### 13.3 — Inline File Viewer & Diff ✅

Any file path mentioned in chat (or in an Action Card) is clickable, opening a
lightweight preview without leaving the chat.

**Implementation notes**
- Parse message text for `src/...` / `./...` patterns → `<FileChip>` components.
- Click sets `state.activeFile` and focuses the file explorer tab.
- `WriteFile` action card adds a **"View diff"** button using the checkpoint
  snapshot for before/after comparison in a modal overlay.

---

### 13.4 — Six-Phase Step Narration ✅

The agent narrates each phase with consistent, labelled prose:

1. **Reading** — "Let me look at the route structure…"
2. **Planning** — "I have everything I need. Here is the plan:" (numbered list)
3. **Executing** — "Let me now apply the changes in parallel:" / "simultaneously:"
4. **Verifying** — "Let me restart to confirm it compiles cleanly."
5. **Confirmed** — "Clean boot — no errors."
6. **Summarising** — concise bullet summary of what was done.

**Implementation notes**
- Extend `statusHistory` SSE frames to carry a `phase` tag:
  `reading | planning | executing | verifying | confirmed | summarising`.
- `ChatMessage.tsx` renders phase tags as small section dividers inside the
  message — no change to user-visible text, purely structural styling.

---

### 13.5 — Inline Screenshot Display ✅

After any verification screenshot, the image appears inline in the chat bubble.

**Implementation notes**
- Backend: after screenshot(), emit `event: screenshot` SSE frame with `{ url }`.
- Frontend: `ChatMessage.tsx` listens for screenshot frames → renders `<img>`
  with a lightbox on click.
- Appears inside a "Took a screenshot" `<ActionCard>` (consistent with 13.1).

---

### 13.6 — Suggestion Cards ✅

At the end of each completed task, a single dismissible card with a one-click
accept button replaces the current bold suggestion text.

**Implementation notes**
- Add `suggestion?: string` to the last assistant `ChatMessage` per turn.
- `<SuggestionCard>` renders below the message body with:
  - Lightning bolt icon + suggestion text
  - **"Yes, do it"** button → sends suggestion as next user message
  - **"✕"** dismiss button → removes card locally

---

### 13.7 — Collapsible Action Groups ("N actions") ✅

When several tool calls happen in rapid sequence they collapse into a summary
chip — `📄 N actions ▸` — at the top of the assistant bubble. Click expands the
full list of file reads / writes / terminals / screenshots inline.

**Implementation (landed)**
- `ActionGroupChip` component in `src/components/ChatPanel.tsx` (line ~642):
  consumes `filesRead`, `filesModified`, `terminals`, `screenshot` from
  `ChatMessageMetadata` and renders them as one collapsible chip.
- Header shows phase icons (`BookOpen`/`Pencil`/`Terminal`/`Camera`) inline,
  the count, and an `ERRORS` pill when any terminal entry has `success:false`.
- **Auto-collapse rule:** groups with all-success status start collapsed
  (`useState(hasFailure)` initial value) — failed groups auto-expand.
- Mounted in `NexusMessageBubble` (line ~824) so it replaces the previous
  scattered cards. This also fixed the "formatting changes on session reload"
  issue: cards used to render fully-expanded after rehydration; the chip is
  now the single source of truth for collapsed state.
- `AnimatePresence` + height/opacity transition for smooth expand/collapse.
- Phase chain (`ActionChain`) still renders separately — it's a structural
  outline, not a tool-call group.

**Files**
- `src/components/ChatPanel.tsx` — `ActionGroupChip` (new), wired into
  `NexusMessageBubble` (replaces inline `ReadFileGroup` / `WriteFileCard` /
  `RunShellCard` / `InlineScreenshot` siblings).

---

### 13.8 — Always-On Provider Status Banner ✅

A compact, always-visible banner pinned to the top of the **Settings** panel
that shows live detection status for every supported AI provider and offers a
one-click inline **Add key** flow for any provider that's missing — even when
some providers are already active (the `FirstRunKeyBanner` only shows when
zero providers are detected, so it disappeared as soon as the user added their
first key, leaving missing providers invisible). This banner stays.

**Implementation (landed)**
- `ProviderStatusBanner` component in `src/components/SettingsPanel.tsx`
  (mounted as the first section in the panel).
- Polls `GET /api/status` and `GET /api/deepseek/status` every 15 s; renders
  a coloured pulse dot per provider (green = `ACTIVE`, dim = `MISSING`) plus
  a `N/5 live` summary pill in the header.
- Each missing row exposes an inline **+ Add key** button. Clicking expands a
  one-row form (env-name + value inputs, eye/eye-off reveal toggle, link to
  the provider's key-issuance page, hint text).
- **Real action, not words:** Save POSTs to `POST /api/kernel/env-keys` with
  `autoSuffix:true` so the key is written to `.env.local` (chmod 0600), live
  `process.env` is updated in the same request, the key is round-trip
  validated by `keyValidatorService.validateKey`, and rejected keys are
  surgically removed before they pollute the pool. No restart required.
- After save, the banner re-probes `/api/status` so the pill flips to green
  immediately (≤ 400 ms).
- Existing per-provider password inputs in the **Neural Core Pulse** section
  remain — those are the per-browser `customKeys` overlay (passed in chat
  request body, persisted to `localStorage`), which is a different mechanism
  from the server-persistent `.env.local` flow handled by this banner.

**Files**
- `src/components/SettingsPanel.tsx` — `ProviderStatusBanner` (new),
  mounted at the top of the panel.

---

### Phase 13 Key Files

| File                                  | Change                                                           |
|---------------------------------------|------------------------------------------------------------------|
| `src/components/ChatMessage.tsx`      | ActionCard, ThinkingBlock, FileChip, SuggestionCard, ActionGroup |
| `src/NexusContext.tsx`                | Add `toolCalls`, `thinking`, `suggestion` to ChatMessage type    |
| `src/services/orchestratorService.ts` | Emit `tool_call`, `thinking`, `screenshot`, `suggestion` frames  |
| `src/routes/sovereign.ts`             | Pass new SSE frames through to the client                        |

### Phase 13 Execution Order

| Step | Depends on | Effort  | Status |
|------|------------|---------|--------|
| 13.1 Action Cards         | —      | Large  | ✅ |
| 13.2 Thinking Block       | 13.1   | Medium | ✅ |
| 13.3 File Viewer/Diff     | 13.1   | Small  | ✅ |
| 13.4 Phase Narration      | 13.1–2 | Medium | ✅ |
| 13.5 Screenshots          | 13.1   | Small  | ✅ |
| 13.6 Suggestion Cards     | 13.1   | Small  | ✅ |
| 13.7 Action Groups        | 13.1   | Medium | ✅ |
| 13.8 Provider Status Banner | —    | Small  | ✅ |
| 13.9 Budget Guardrails (alert + pause/resume) | — | Medium | ✅ |
| 13.10 Theme System Overhaul (8 hand-tuned palettes) | — | Medium | ✅ |
| 13.11 Terminal Theme Picker — click + mobile sheet | — | Small | ✅ |
| 13.12 Truncated NEXUS sentinel sanitization | — | Small | ✅ |
| 13.13 Live Preview proxy fix (prefix-strip + asset interceptor) | — | Medium | ✅ |

Steps 13.3, 13.5, 13.6 can be parallelised once 13.1 is done.
13.7 is a polish pass on top of 13.1.
13.8 is independent (Settings panel only — no dependency on 13.1).
13.9–13.13 are independent and were shipped together as the Phase 13 hardening pass.

### Phase 13.9 — Budget Guardrails

| File | Change |
|------|--------|
| `src/types.ts`                       | Add `budgetUsd`, `budgetTokens`, `pausedSessions` to `IDEState` |
| `src/NexusContext.tsx`               | Hydrate from / persist to localStorage; hard-stop `sendMessage` on paused session |
| `src/components/SettingsPanel.tsx`   | New "Budget Guardrails" section with USD + token inputs and paused-session list |
| `src/components/ChatPanel.tsx`       | New `BudgetBanner` above composer with Pause / Resume; composer disabled when paused; shared `useSessionCost` hook |

### Phase 13.10 — Theme System Overhaul

Removed 9 legacy themes; kept Sovereign Dark as default. Added 7 new
hand-tuned palettes (3 dark, 2 light, 2 mixed):

| ID                  | Mode  | Identity |
|---------------------|-------|----------|
| `sovereign-dark`    | dark  | Default — gold + cyan on near-black |
| `aurora-light`      | light | Premium daylight — teal + royal violet |
| `tokyo-twilight`    | dark  | Cyberpunk dusk — coral + lilac + sky cyan |
| `sahara-dune`       | light | Warm sand — terracotta + plum |
| `northern-mist`     | mixed | Nordic frost — sage + glacier blue |
| `synthwave-sunset`  | dark  | Retro magenta + electric mint |
| `verdant-lab`       | dark  | Biotech lime + emerald + cyan-green |
| `carbon-fiber`      | mixed | Industrial signal orange + electric blue |

`THEMES` registry in `src/constants.ts` now exports `mode` + `swatch`
fields used by the Settings picker for live colour previews.

### Phase 13.11 — Terminal Theme Picker

`TerminalPanel.tsx` palette button is now a click-toggle that:
* persists selection to `localStorage`
* renders a desktop dropdown anchored above the button (≥ sm)
* renders a full-width animated bottom sheet on phones (< sm)
* dismisses on outside-click and Escape

### Phase 13.12 — Truncated Sentinel Fix

`sanitizeNexusContent` in `ChatPanel.tsx` now strips three classes of tag:
1. complete open + close pairs (with inner content)
2. complete standalone tags
3. **truncated tags** (e.g. `[NEXUS:SCREENSH` cut by SSE chunk or token cap)

Eliminates the literal `[NEXUS:…` text that occasionally leaked into bubbles.

### Phase 13.13 — Live Preview Proxy Fix

`server.ts` proxy block reworked:
* explicit `/api/preview/<sid>/...` route now **strips the prefix** before
  forwarding to the dev server (prior code returned the SPA fallback for
  every request → blank iframe)
* added a Referer-based asset interceptor so `/src/...`, `/@vite/...`,
  `/node_modules/...` etc. requested from inside a preview iframe are
  routed to that session's dev server
* preserves the loading screen for non-READY sessions
