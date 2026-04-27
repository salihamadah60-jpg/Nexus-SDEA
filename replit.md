# Nexus AI Sovereign IDE v8.0 — Silent Operator

## Phase 13.1 — Quality Bar, Loop Guard, Manifest Healer (2026-04-27)

| # | Fix | Files | Summary |
|---|-----|-------|---------|
| 1 | **`autoFixCommand` heals "Missing script: test"** | `src/services/aiService.ts` | When a generated project crashes with `npm ERR! Missing script: "test"`, the autoFixCommand now reads the project's `package.json`, injects `"test": "vitest run"` (and adds `vitest@^2.1.4` to devDependencies if absent), and re-runs the test command. Replaces a previous infinite "test → fail → test" loop. |
| 2 | **Real React stub generation** | `src/services/importReifierService.ts` | `generateStub()` for `.tsx`/`.jsx` paths now emits a real default-exported React component returning `null` (not `export {};`), so missing-import auto-stubbing no longer breaks Vite's React refresh boundary check. |
| 3 | **No-op file-write guard** | `src/services/aiService.ts` | Before writing a file the AI proposed, the orchestrator reads the existing content; if it's byte-identical to the new content the write is skipped. This prevents chokidar from triggering a Vite restart loop when the AI re-emits the same file across self-correction passes. |
| 4 | **Vitest baked into scaffold** | `src/services/scaffoldService.ts` | The `react-vite` template now ships with `vitest@^2.1.4`, a `vitest.config.ts` (jsdom env + setup file), and `"test": "vitest run"` in package.json, so a freshly scaffolded project never crashes on the test gate. |
| 5 | **Manifest Healer service** | `src/services/manifestHealerService.ts` (new), `src/services/aiService.ts` | After every AI write batch, `healManifest(projectDir)` runs *before* diagnostics: ensures `"type": "module"`, bumps `vite` to `^6.2.0` if `<5`, deletes any stray `tailwind.config.{js,ts,cjs}` (Tailwind v4 reads tokens from CSS `@theme`, not JS), strips broken `@import "tailwindcss/v4"` lines, and rewrites server.port from `5000` (reserved for the IDE itself) to `3001`. Eliminates the most common AI-generated boot crashes without another LLM round-trip. |
| 6 | **Loop Guard in Autopilot** | `src/services/autopilotService.ts` | `SessionProcess` now captures the dev process's last 4 KB of stderr. On each crash during STARTING, the close handler distills error/throw lines into a normalized signature (paths/numbers/timestamps stripped). If two consecutive attempts share the same signature, autopilot aborts with `[LOOP-GUARD]` instead of burning all `MAX_ATTEMPTS` on the same deterministic bug. |
| 7 | **Quality Bar in System Prompt** | `src/services/aiService.ts` (`buildSystemPrompt`) | Added a non-negotiable Quality Bar with a forbidden-output blacklist ("Streamline Your Workflow", 17-line Heros, flat solid sections, hardcoded `bg-primary` without `@theme`) and a 10-point checklist (specific copy with numbers, 4-6 brand colors in `@theme`, 6+ rich sections, framer-motion entrance + scroll animations, lucide icons everywhere, gradient depth, responsive breakpoints, semantic HTML, working interactivity, minimum component sizes). Stack rules now explicitly forbid `vite@^4`, require `"type": "module"`, and forbid hand-written `tailwind.config.*` for Tailwind v4. |
| 8 | **Healed broken sandbox** | `sandbox/projects/session-1777224332222-qvn7p4/` | Direct in-place repair of the user's stuck project: rewrote `package.json` with `"type":"module"` + `vite@^6.2.0` + framer-motion/lucide/clsx/tailwind-merge, removed the bad `tailwind.config.js`, deleted stale `node_modules` and `package-lock.json` so a clean install can run. |

## Phase 13 — Chat UX & Preview Fixes (2026-04-27)

| # | Fix | Files | Summary |
|---|-----|-------|---------|
| 1 | **Preview proxy fixed** | `src/config/middleware.ts` | Removed a hardcoded `http-proxy-middleware` rule pointing at `localhost:3001` that intercepted every `/api/preview/:sessionId` request before the dynamic port proxy in `server.ts` could handle it, causing "Preview server not running on port 3001" on every session. Now the dynamic proxy in `server.ts` (which reads `session.port` at request time) is the sole handler. |
| 2 | **Vite port-drift race fixed** | `src/services/autopilotService.ts` | `performVisualAudit` was called when the `"ready in"` line appeared — a chunk that arrives *before* the `"Local: http://localhost:PORT/"` line. The port hadn't been detected yet, so the audit probed the wrong port. Now the audit only fires on the `Local:/Network:/Available on:` line, which always carries the confirmed port. |
| 3 | **Buttons always visible** | `src/components/ChatPanel.tsx` | Changed action-row opacity from `opacity-0 hover:opacity-100` (invisible on mobile/touch) to `opacity-40 hover:opacity-100`. All file Open buttons in `ReadFileGroup` and `WriteFileCard` changed from `opacity-0 group-hover:opacity-100` to always-visible. |
| 4 | **13.7 Action Groups** | `src/components/ChatPanel.tsx` | Added `ActionGroupChip` component that collapses all tool-call cards (file reads, file writes, terminals, screenshot) into a single `"N actions ▸"` chip. Collapsed by default; auto-expanded when there are terminal failures. Replaces the previous individual expanded cards in `NexusMessageBubble`, fixing the formatting-change-on-reload issue (previously cards appeared expanded after session reload). |
| 5 | **View Diff button** | `src/components/ChatPanel.tsx`, `src/types.ts`, `src/services/aiService.ts` | `WriteFileCard` now shows a **Diff** button when `beforeContent` is available. Clicking opens `DiffModal`, which fetches the current file content from `/api/files/content` and renders a unified line diff (deletions in red, insertions in green). `aiService.ts` now reads the old file content before writing and includes it as `beforeContent` in the `nexus_file_write` SSE event. `FileWriteEntry` type extended with `beforeContent?: string`. |

## Phase 12.8 — Self-Healing History Panel (2026-04-26)

| # | Feature | Files | Summary |
|---|---------|-------|---------|
| 18 | **Self-Healing Panel** | `SelfHealingPanel.tsx`, `NavigationRail.tsx`, `NexusCore.tsx` | New sidebar panel accessible via the ShieldCheck icon in session mode. Parses two live sources: (1) terminal journal lines for AUTOPILOT Vite/CSS healer events, (2) SSE `statusHistory` from chat messages for Reviewer audit events. Displays structured HealEvent rows (pass type, status, filename, detail), a 6-stat summary bar (healed/failed/pattern/AI/audit/total), and a live success-rate badge. Auto-scrolls, supports clear, expandable detail rows. Failed AI Healer events show a **Retry Fix** button that calls `POST /api/kernel/heal/retry`, re-runs `requestAIFileFix`, writes the corrected file to disk, and overlays the row with the new outcome inline. |
| 20 | **`POST /api/kernel/heal/retry`** | `sovereign.ts` | New endpoint: reads the file from the sandbox (path-traversal safe), calls `requestAIFileFix(filePath, content, errorHint)`, writes the corrected content back, and returns `{ success, filePath, detail }`. |
| 19 | **Real Dependency Audit Gate** | `aiService.ts` | Replaced the 800ms fake delay with a real `npm audit --json --audit-level=high` execution. Parses vulnerability JSON, surfaces high/critical package names and count to the journal stream before install proceeds. |

## Bug Fixes Applied (2026-04-26 — Phase 12.7 — AI Self-Healing Loop)

| # | Fix | Files | Summary |
|---|-----|-------|---------|
| 13 | **Pre-write audit feedback loop completed** | `aiService.ts`, `orchestratorService.ts` | The stub at line 848 ("We'd normally call the LLM again here") is now a real self-correction pass. When `performLogicAudit()` fails, `requestAuditFix()` sends the files + issues to a fast AI (Groq→Gemini), merges the corrections back into `parsed.filesToWrite`, and continues. Broken files are no longer written to disk. |
| 14 | **Vite runtime AI self-healer** | `autopilotService.ts`, `orchestratorService.ts` | `autoFixVitePreTransformError` now has a two-pass strategy: (1) instant pattern fix for CSS `//` comments, (2) AI-powered fix via `requestAIFileFix()` for all other Vite/TypeScript errors. The fixed file is written back and Vite HMR reloads it without a restart. |
| 15 | **`autoFixCommand` expanded** | `aiService.ts` | Added 5 new patterns: missing module (extracts package name + `npm install`), missing `@scope/pkg` paths, `ENOTFOUND`/network retry with `--prefer-offline`, `EACCES` + `--unsafe-perm`, TypeScript errors in build command (strips `tsc &&` and falls through to Vite). |
| 16 | **SOVEREIGN DEBUGGER stub replaced** | `aiService.ts` | The hollow `console.warn('Analyzing stack trace...')` is replaced with a real error-line extractor that surfaces the relevant error + attempted fix in structured log output. |
| 17 | **`requestAIFileFix` + `requestAuditFix`** | `orchestratorService.ts` | Two new exported helpers. `requestAIFileFix(filePath, content, error)` asks a fast AI to repair a single file and return the raw fixed content. `requestAuditFix(files, issues, goal)` asks AI to regenerate failing files after an audit. Both cascade Groq→Gemini with key-pool rotation. |

## Bug Fixes Applied (2026-04-26 — Phase 12.6 — CSS Error Detection & Auto-Fix)

| # | Fix | Files | Summary |
|---|-----|-------|---------|
| 9 | **CSS `//` comment crash** | `aiService.ts` | AI was writing `// comment @import "tailwindcss"` in CSS — invalid CSS that crashes Tailwind v4 Vite plugin. `sanitizeCssContent()` strips all `//` lines/prefixes from `.css` files before they are written to disk. |
| 10 | **System prompt CSS rule** | `aiService.ts` | Added explicit ⚠️ CRITICAL CSS RULE to system prompt: CSS never uses `//` comments; `@import "tailwindcss"` must be first line with nothing before it. |
| 11 | **Vite pre-transform auto-fix** | `autopilotService.ts` | Autopilot stderr handler now detects `Pre-transform error`/`Invalid declaration`. Calls `autoFixVitePreTransformError()` which parses the offending file path from the error, strips `//` comments, rewrites the file, and lets Vite HMR recover without a restart. |
| 12 | **Post-build CSS diagnostics** | `diagnosticService.ts` | `runDiagnostics()` now scans all `.css` files in the sandbox for invalid `//` comments and auto-fixes them before the dev server starts, giving a third line of defence. |

## Bug Fixes Applied (2026-04-26 — Pre-Phase 12.5 Session)

| # | Fix | Files | Summary |
|---|-----|-------|---------|
| 1 | **Port conflicts** | `portService.ts` | Removed shell command substitution (`kill -9 $(lsof ...)`). All kills now use typed `findPidsOnPort + killPid` APIs. Clean 4-retry reclaim loop, deterministic fallback scan. |
| 2 | **E2B sandbox check** | `e2bService.ts`, `/api/health` | E2B is active only when `E2B_API_KEY` is set. Terminal + preview are always local. `/api/health` reports `sandbox: "e2b" \| "local"`. |
| 3 | **Nexus creation behavior** | `aiService.ts`, `scaffoldService.ts` | System prompt hardened with FORBIDDEN PHRASES list. Model must write ALL files in ONE response — no "I will start creating…" preamble. Scaffold updated to Tailwind v4. |
| 4 | **EAGAIN / process limit** | `autopilotService.ts` | Removed `shell: true` from all `spawn()` calls — this was creating an extra `sh -c` process per install/dev-server, doubling process count. Added `EAGAIN`/`ENOMEM` error handlers with back-off retries. |
| 5 | **Visual Audit Fail** | `autopilotService.ts` | Reduced retry loop from 10 → 3 attempts. Early-exit when `captureVisualSnapshot` returns null (no browser binary) — no more 10-cycle "no browser" spam. |
| 6 | **Core Dumped** | `visualService.ts` | Added full set of container-safe Chromium flags: `--disable-dev-shm-usage`, `--no-zygote`, `--single-process`, `--disable-gpu`, `--disable-software-rasterizer`, etc. Added Nix store paths to binary search. |
| 7 | **Vite config ESM Workers** | `vite.config.ts` | Fixed proxy target 3000 → 5000. Added `optimizeDeps.exclude` for `web-tree-sitter`, `tree-sitter-wasms`, `better-sqlite3`. Added `worker.format: 'es'`. |
| 8 | **Phase 12.5** | `autopilotService.ts`, `api.ts` | `getLiveSessions()` cross-checks sandbox dirs against SQLite `sessions` table. Orphan dirs skipped on boot. `POST /api/autopilot/gc` endpoint for manual purge. |

### Additional fixes
- `getProviderClients()` now returns `altAi` (was causing runtime destructuring error)
- Scaffold updated to Tailwind v4 (`@tailwindcss/vite`, `@import "tailwindcss"`, no postcss.config.js)
- `scaffoldService.ts` vite.config no longer uses `strictPort: true` (caused unnecessary EADDRINUSE cascades)

A unified, world-class AI coding IDE built on a sovereign architecture. Nexus builds projects autonomously from A to Z, operates silently (all code written directly to files), and presents clean structured responses with expandable intelligence sections.

## Architecture

**Single-server design:** `server.ts` runs Express on port 5000, embeds Vite dev middleware, and manages all subsystems. Port 5000 is reserved (deterministic single bind, no silent relocation); sandbox projects start at 3001+.

## SDEA Backend Layer (Software Development Engineering Agent)

Nexus's core logic was upgraded to compete with Replit/Cursor/MiniMax-class agents:

- **Key pool rotation** — `keyPoolService` scans env for variants (`GEMINI_API_KEY`, `GEMINI_API_KEY_1`, `GAK_2`, `GITHUB_TOKEN`, `ALT_GITHUB_GPT`, `GROQ_API_KEY`, `HF_TOKEN`, …), dedupes identical secrets, round-robins healthy keys per request, applies exponential cooldowns on 429/quota and hard-disables on 401/403.
- **Intent gating** — `intentService.classifyIntent()` routes "Hello" → 1-line reply, questions → short prose, build/command → full Sovereign protocol (THOUGHT/CHAIN/FILE/TERMINAL/SCREENSHOT). No more spinning up vite for a greeting.
- **Language hygiene** — `sanitizeLanguage()` strips Cyrillic/CJK/Hangul/Devanagari/etc. from outgoing prose when the user wrote in Arabic+Latin only. File contents are never touched.
- **Memory compaction** — `memoryService.compactHistory()` keeps the last 8 turns verbatim and condenses older ones into a digest line, plus a per-session facts table (filesWritten, packagesInstalled, portsUsed, decisions) injected into the prompt to prevent hallucinated file references.
- **Verified preview gate** — `autopilotService` only broadcasts `__OPEN_PREVIEW__` after an HTTP probe returns 2xx/3xx (10 attempts × 1s) — no more 404 flicker.
- **Event bus** — `eventStreamService` exposes Action/Observation events (file.write, file.copy, preview.ready, command.result …) via `GET /api/kernel/events`.

### New REST endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/kernel/quota`               | Masked snapshot of every key (calls, failures, cooldown remaining, health) |
| GET    | `/api/kernel/memory`              | Session facts (files/packages/ports tracked) |
| DELETE | `/api/kernel/memory/:sessionId`   | Wipe a session's compacted memory |
| GET    | `/api/kernel/events?sessionId=&limit=` | Recent Action/Observation events |
| POST   | `/api/files/copy` `{sessionId,srcPath,destPath,move?}` | Recursive copy or move (cp -R / mv) |
| GET    | `/api/blackboard/tasks?sessionId=` | All blackboard tasks for a session (polled by LiveBlackboardBar every 3s) |
| GET    | `/api/blackboard/task/:id` | Single task with plan steps and audit history |
| GET    | `/api/deploy/readiness` | 6-point pre-deploy checklist (SQLite, DNA, provider keys, MongoDB, stasis tasks, sandbox flavor) |


```
nexus-ai-sovereign-ide/
├── server.ts                  # Unified Express+Vite+WS server (port 5000)
├── dna.json                   # Living intelligence config — behavioral protocols, lessons learned
├── Nexus.md                   # Sovereign identity document (auto-enforced by identityService)
├── sandbox/projects/          # Per-session isolated sandboxes (UUID-scoped)
└── src/
    ├── main.tsx               # React entry + NexusProvider
    ├── theme.css              # Tailwind v4 theme (gold+cyan palette)
    ├── NexusContext.tsx       # Global state, WebSocket, AI SSE stream handler
    ├── NexusCore.tsx          # Root IDE layout (navbar, sidebar, editor, terminal, preview)
    ├── types.ts               # All TypeScript types (incl. ChatMessageMetadata)
    ├── constants.ts           # MODELS, MODES, NAV_TABS
    ├── utils.ts               # cn(), generateId(), etc.
    ├── services/
    │   ├── aiService.ts       # Multi-provider AI (structured marker protocol)
    │   ├── keyPoolService.ts  # SDEA: multi-key rotation, quota tracking, cooldowns
    │   ├── intentService.ts   # SDEA: smalltalk/question/build classifier + language hygiene
    │   ├── memoryService.ts   # SDEA: history compaction + session facts (anti-hallucination)
    │   ├── eventStreamService.ts # SDEA: OpenHands-style Action/Observation event bus
    │   ├── autopilotService.ts # Auto install + dev server with HTTP-verified preview gate
    │   ├── terminalService.ts  # Bash shell per session, nexus-* commands
    │   ├── blueprintService.ts # File tree scanning + sovereign context building
    │   ├── backupService.ts    # Atomic micro-backups + rollback
    │   ├── visualService.ts    # Puppeteer visual snapshots
    │   ├── ideationService.ts  # Proactive suggestion engine
    │   ├── workflowService.ts  # .nexus/workflow.json execution
    │   └── identityService.ts  # DNA-driven Nexus.md enforcement
    ├── config/
    │   ├── ws.ts              # WebSocket server (terminal I/O + signals)
    │   ├── db.ts              # MongoDB connection (ephemeral fallback)
    │   ├── middleware.ts       # Express middleware
    │   └── backendConstants.ts # SANDBOX_BASE, NEXUS_MD_PATH
    ├── routes/
    │   └── api.ts             # REST API (sessions, files/content/rename/delete, DNA, status)
    ├── models/
    │   └── Schemas.ts         # MongoDB schemas (Session, Message)
    └── components/
        ├── NavigationRail.tsx     # Activity bar
        ├── HomePanel.tsx          # Landing dashboard with kernel status
        ├── ChatPanel.tsx          # Silent Operator UI with expandable sections
        ├── FileExplorer.tsx       # Sandbox file tree (CRUD + search + rename)
        ├── EditorPanel.tsx        # CodeMirror editor with tab management
        ├── TerminalPanel.tsx      # WebSocket ANSI terminal
        ├── PreviewPanel.tsx       # Sandboxed iframe preview (3 device modes)
        ├── SessionPanel.tsx       # Session management
        ├── TaskTracker.tsx        # Orchestration queue with subtask tracking
        ├── SettingsPanel.tsx      # AI status + model/mode settings
        ├── LoadingKernel.tsx      # Animated boot screen
        ├── NotificationOverlay.tsx # Toast notifications
        └── VisualSnapshotPanel.tsx # Visual audit snapshots
```

## Silent Operator Protocol (v7.0)

Nexus AI operates silently — all code is written directly to sandbox files using structured marker format. Chat shows only clean status text, with deep details in expandable sections:

- **Neural Logic** — Nexus's thought process (collapsed by default)
- **Action Chain** — Step-by-step plan (expanded by default)
- **File Context** — Files read + files modified with "View" button to open in editor
- **Ghost Terminal** — Commands executed inline with output, copyable, auto-expanded on error
- **Visual Verification** — Screenshot of preview after build

### AI Response Marker Format

```
[NEXUS:THOUGHT]reasoning[/NEXUS:THOUGHT]
[NEXUS:CHAIN]Step 1: ...|Step 2: ...[/NEXUS:CHAIN]
[NEXUS:READ]filename.ts[/NEXUS:READ]
[NEXUS:FILE:path/to/file.tsx]complete file content[/NEXUS:FILE]
[NEXUS:TERMINAL]npm install[/NEXUS:TERMINAL]
[NEXUS:SCREENSHOT]verify[/NEXUS:SCREENSHOT]
Visible summary text to user (no code blocks)
```

### SSE Event Protocol

Backend sends structured events to frontend:
- `nexus_streaming` — keep-alive ping with status text
- `nexus_thought` — reasoning (goes to Neural Logic accordion)
- `nexus_chain` — action chain steps
- `nexus_file_read` — files analyzed
- `nexus_file_write` — file written to sandbox `{path, size}`
- `nexus_terminal` — command result `{cmd, output, success, retried, fixedCmd}`
- `nexus_screenshot` — visual verification filename
- `nexus_summary` — clean visible text for chat message

## Quad-System Integration

All four systems are hard-linked via WebSocket broadcast signals:

| Signal | Effect |
|--------|--------|
| `__REFRESH_FS__` | File Explorer re-scans sandbox |
| `__OPEN_PREVIEW__` | Preview panel opens automatically |
| `__REFRESH_PREVIEW__` | Preview iframe reloads |
| `__VISUAL_SNAPSHOT__:filename` | Snapshot added to gallery |

## Build Protocol A to Z

Nexus follows a 5-phase build protocol for every project:
1. **Analyze** — Scan existing files, understand request
2. **Plan** — Write THOUGHT + CHAIN, report to user
3. **Execute** — Write all files, run terminal commands
4. **Verify** — Screenshot preview, self-correct visual issues
5. **Report** — Summarize what was built

## Terminal Autonomy + Self-Correction

Autopilot and AI service both implement self-correction:
- npm install fails → retry with `--legacy-peer-deps`, then `--force`
- Port in use → autopilot auto-increments port
- Module not found → auto-install the missing package
- Max 3 retry attempts before reporting failure

## Sandbox Isolation

Each session gets a fully isolated sandbox:
- Path: `sandbox/projects/{sessionId}/`
- Shell: dedicated bash process per session
- Path traversal prevention: `guardPath()` on all API endpoints
- Auto-initialization: `Nexus.md` copied on session creation

## Tech Stack

- **Runtime:** Node.js 20 + TypeScript (tsx for dev)
- **Frontend:** React 18, Tailwind v4, motion/react, lucide-react
- **AI Providers:** Gemini 2.5 Flash Preview → Gemini 2.0 Flash → Gemini 2.0 Flash Lite → GitHub GPT-4o → Groq Llama-3.3-70B → HuggingFace Llama-3.2
- **Editor:** @uiw/react-codemirror + CodeMirror language extensions
- **Color Palette:** `#d4af37` (Nexus Gold), `#00f2ff` (Nexus Cyan), `#050508` (Deep Black)

## Environment Variables

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Primary Gemini key (required) |
| `ALT_GEMINI_KEY` | Fallback Gemini key |
| `GITHUB_GPT` / `GITHUB_TOKEN` | GitHub GPT-4o access |
| `GROQ_API_KEY` | Groq Llama-3.3-70B |
| `HUGGINGFACE_TOKEN` | HuggingFace Qwen 72B |
| `MONGODB_URI` | MongoDB (optional — ephemeral if missing) |
