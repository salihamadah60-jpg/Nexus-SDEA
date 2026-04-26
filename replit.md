# Nexus AI Sovereign IDE v8.0 — Silent Operator

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
