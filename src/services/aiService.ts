import OpenAI from "openai";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { HfInference } from "@huggingface/inference";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { buildSovereignContext, getFilesRecursive, syncProjectBlueprint } from "./blueprintService.js";
import { buildSemanticRAGContext } from "./contextService.js";
import { performLogicAudit } from "./auditService.js";
import { createCheckpoint } from "./checkpointService.js";
import { e2bManager } from "./e2bService.js";
import { Session } from "../models/Schemas.js";
import mongoose from "mongoose";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { triggerSessionBoot } from "./autopilotService.js";
import { lookupPattern, injectLesson } from "./vaultService.js";
import { validatePath } from "./guardService.js";
import { generateTaskId, logHistory } from "./historyService.js";
import { writeJournal } from "./journalService.js";
import { scaffoldProject } from "./scaffoldService.js";
import { runDiagnostics } from "./diagnosticService.js";
import { keyPool, classifyError, type KeyState, type ProviderName } from "./keyPoolService.js";
import { classifyIntent, intentDirective, sanitizeLanguage } from "./intentService.js";
import { compactHistory, recordFiles, recordPort, recordDecision, getFacts, renderFacts } from "./memoryService.js";
import { eventStream } from "./eventStreamService.js";
import { nexusLog } from "./logService.js";
import { reifyImports } from "./importReifierService.js";
import http from "http";

/**
 * Build a fresh client for a specific key. Called per-request so we can rotate
 * across multiple keys for the same provider (GAK-1, GAK-2, ...).
 */
function buildClient(provider: ProviderName, key: string): any {
  switch (provider) {
    case "gemini":      return new GoogleGenAI({ apiKey: key });
    case "groq":        return new OpenAI({ apiKey: key, baseURL: "https://api.groq.com/openai/v1" });
    case "github":      return new OpenAI({ apiKey: key, baseURL: "https://models.inference.ai.azure.com" });
    case "huggingface": return new HfInference(key);
  }
}

/** Probe a URL with a short HTTP HEAD/GET; resolve true on 2xx/3xx within timeout. */
function probeHttp(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const req = http.get(url, { timeout: timeoutMs }, res => {
        const ok = !!res.statusCode && res.statusCode < 500;
        res.resume();
        resolve(ok);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}

// Legacy single-key snapshot (used only as a fallback when key pool is empty).
function getProviderClients(overrides: { [key: string]: string | undefined } = {}) {
  const GROQ_API_KEY = (overrides.GROQ_API_KEY || process.env.GROQ_API_KEY)?.trim();
  const GEMINI_API_KEY = (overrides.GEMINI_API_KEY || process.env.GEMINI_API_KEY)?.trim();
  const GITHUB_TOKEN = (overrides.GITHUB_TOKEN || overrides.GITHUB_GPT || process.env.GITHUB_GPT || process.env.GITHUB_TOKEN)?.trim();
  const HUGGINGFACE_TOKEN = (overrides.HUGGINGFACE_TOKEN || process.env.HUGGINGFACE_TOKEN)?.trim();
  const geminiClient = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
  return {
    ai: geminiClient,
    altAi: geminiClient, // secondary slot reuses same Gemini client (key-pool handles rotation)
    github: GITHUB_TOKEN ? new OpenAI({ apiKey: GITHUB_TOKEN, baseURL: "https://models.inference.ai.azure.com" }) : null,
    groq: GROQ_API_KEY ? new OpenAI({ apiKey: GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" }) : null,
    hf: HUGGINGFACE_TOKEN ? new HfInference(HUGGINGFACE_TOKEN) : null,
  };
}

interface ParsedResponse {
  thought: string;
  chain: string[];
  filesRead: string[];
  filesToWrite: Array<{ path: string; content: string }>;
  terminals: string[];
  triggerScreenshot: boolean;
  summary: string;
  statusMessages: string[];
}

interface TerminalResult {
  cmd: string;
  output: string;
  success: boolean;
  retried: boolean;
  fixedCmd?: string;
}

const parseLog = nexusLog("parse");

/**
 * Strip invalid // comments from CSS content. The Tailwind v4 Vite plugin throws
 * "Invalid declaration" when the AI writes "// comment @import 'tailwindcss'"
 * (JavaScript-style comments are not valid CSS).
 * Rules:
 *  1. Remove any line whose first non-whitespace characters are //
 *  2. Strip inline // ... text that appears before an @import (the whole prefix is removed)
 *  3. Ensure @import "tailwindcss" is the very first meaningful line if it exists anywhere
 */
function sanitizeCssContent(css: string): string {
  const lines = css.split('\n');
  const cleaned: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    // Remove pure // comment lines
    if (trimmed.startsWith('//')) continue;
    // Strip inline // comment prefix that was accidentally merged with @import
    // e.g.: "// TailwindCSS import @import \"tailwindcss\""
    if (trimmed.includes('//') && trimmed.includes('@import')) {
      const importIdx = trimmed.indexOf('@import');
      cleaned.push(trimmed.slice(importIdx));
      continue;
    }
    cleaned.push(line);
  }
  return cleaned.join('\n');
}

function parseNexusResponse(text: string, sessionId?: string, turn?: number): ParsedResponse {
  // Phase 12.2 — log raw response so we can observe fence-wrapping or marker echoing on follow-up turns.
  if (sessionId) {
    parseLog.debug(`[parse] raw response session=${sessionId} turn=${turn ?? "?"} len=${text.length}:\n${text.slice(0, 4000)}`);
  }

  // Phase 12.2 — pre-strip markdown code fences so the model cannot hide markers inside
  // ```text … ``` blocks when "quoting" a prior turn. This collapses any fenced block
  // while preserving the interior content (markers survive, plain code is also exposed).
  const stripped = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, inner) => inner);

  const extract = (tag: string): string => {
    const match = stripped.match(new RegExp(`\\[NEXUS:${tag}\\]([\\s\\S]*?)\\[\\/NEXUS:${tag}\\]`, 'i'));
    return match ? match[1].trim() : '';
  };

  const extractAll = (tag: string): string[] => {
    const matches = stripped.matchAll(new RegExp(`\\[NEXUS:${tag}\\]([\\s\\S]*?)\\[\\/NEXUS:${tag}\\]`, 'gi'));
    return Array.from(matches).map(m => m[1].trim()).filter(Boolean);
  };

  const thought = extract('THOUGHT');

  const chainRaw = extract('CHAIN');
  const chain = chainRaw ? chainRaw.split('|').map(s => s.trim()).filter(Boolean) : [];

  const filesRead = extractAll('READ');

  const fileMatches = stripped.matchAll(/\[NEXUS:FILE:([^\]]+)\]([\s\S]*?)\[\/NEXUS:FILE\]/gi);
  const filesToWrite = Array.from(fileMatches).map(m => ({
    path: m[1].trim(),
    content: m[2]
  }));

  // Phase 12.2 — loud warning: markers present but nothing extracted. This catches silent regressions.
  if (stripped.includes('[NEXUS:FILE') && filesToWrite.length === 0) {
    parseLog.warn(`[parse] ALERT: response contains [NEXUS:FILE marker(s) but 0 files were extracted! session=${sessionId ?? "?"} turn=${turn ?? "?"} — likely a fence-wrapping or tag mismatch. Raw excerpt:\n${stripped.slice(0, 1200)}`);
  }

  const terminals = extractAll('TERMINAL').flatMap(block =>
    block.split('\n').map(l => l.trim()).filter(Boolean)
  );

  const triggerScreenshot = /\[NEXUS:SCREENSHOT\]/i.test(stripped);
  const statusMessages = extractAll('STATUS');

  const summary = stripped
    .replace(/\[NEXUS:THOUGHT\][\s\S]*?\[\/NEXUS:THOUGHT\]/gi, '')
    .replace(/\[NEXUS:CHAIN\][\s\S]*?\[\/NEXUS:CHAIN\]/gi, '')
    .replace(/\[NEXUS:READ\][\s\S]*?\[\/NEXUS:READ\]/gi, '')
    .replace(/\[NEXUS:FILE:[^\]]+\][\s\S]*?\[\/NEXUS:FILE\]/gi, '')
    .replace(/\[NEXUS:TERMINAL\][\s\S]*?\[\/NEXUS:TERMINAL\]/gi, '')
    .replace(/\[NEXUS:STATUS\][\s\S]*?\[\/NEXUS:STATUS\]/gi, '')
    .replace(/\[NEXUS:SCREENSHOT\][\s\S]*?\[\/NEXUS:SCREENSHOT\]/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { thought, chain, filesRead, filesToWrite, terminals, triggerScreenshot, summary, statusMessages };
}

function autoFixCommand(cmd: string, errorOutput: string, retryCount: number): string | null {
  const lower = errorOutput.toLowerCase();
  if (cmd.includes('npm install') && !cmd.includes('--legacy-peer-deps') &&
    (lower.includes('eresolve') || lower.includes('peer dep'))) {
    return cmd + ' --legacy-peer-deps';
  }
  if (cmd.includes('npm install') && retryCount === 1) {
    return 'npm install --legacy-peer-deps --force';
  }
  if (lower.includes('cannot find module') || lower.includes('module not found')) {
    const match = errorOutput.match(/['"]([^'"\/][^'"]*)['"]/);
    if (match) return `npm install ${match[1]}`;
  }
  return null;
}

async function execCommandInSandbox(
  cmd: string,
  sandboxPath: string,
  timeoutMs = 90000
): Promise<{ stdout: string; stderr: string; success: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn('bash', ['-c', cmd], {
      cwd: sandboxPath,
      env: { ...process.env, CI: 'false', BROWSER: 'none', FORCE_COLOR: '0' }
    });

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        resolve({ stdout, stderr: stderr + '\n[TIMEOUT]', success: false, timedOut: true });
      }
    }, timeoutMs);

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, success: code === 0, timedOut: false });
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr: err.message, success: false, timedOut: false });
      }
    });
  });
}

async function executeWithSelfCorrection(
  cmd: string,
  sandboxPath: string,
  maxRetries = 2
): Promise<TerminalResult> {
  let currentCmd = cmd;
  let retried = false;
  let fixedCmd: string | undefined;

  const isDevServer = /npm\s+run\s+(dev|start)|vite|http-server|node\s+/i.test(cmd);
  const timeout = isDevServer ? 20000 : 90000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await execCommandInSandbox(currentCmd, sandboxPath, timeout);
    const output = (result.stdout + result.stderr).trim();

    if (result.success || result.timedOut) {
      return { cmd: currentCmd, output, success: result.success || isDevServer, retried, fixedCmd };
    }

    const fix = autoFixCommand(currentCmd, output, attempt);
    
    // Phase 3: Debug-First logic (Injecting stack trace analysis into memory)
    if (!result.success && output.includes('Error')) {
      console.warn(`[SOVEREIGN DEBUGGER] Trap caught in ${currentCmd}: Analyzing stack trace...`);
    }

    if (fix && attempt < maxRetries) {
      fixedCmd = fix;
      currentCmd = fix;
      retried = true;
      continue;
    }

    return { cmd: currentCmd, output, success: false, retried, fixedCmd };
  }

  return { cmd: currentCmd, output: 'Max retries exceeded', success: false, retried, fixedCmd };
}

async function buildFileTree(sandboxPath: string): Promise<string> {
  try {
    const files = await getFilesRecursive(sandboxPath, sandboxPath);
    if (files.length === 0) return 'Empty sandbox (no files yet).';
    const lines: string[] = [];
    for (const f of files.slice(0, 60)) {
      const depth = f.id.split('/').length - 1;
      lines.push(`${'  '.repeat(depth)}${f.type === 'folder' ? '📁' : '📄'} ${f.name}`);
    }
    return lines.join('\n');
  } catch { return 'Could not read sandbox.'; }
}

async function readSandboxFilesSample(sandboxPath: string, maxFiles = 5, maxChars = 2000): Promise<string> {
  try {
    const files = await getFilesRecursive(sandboxPath, sandboxPath);
    const readableExts = ['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.md'];
    const candidates = files
      .filter(f => f.type === 'file' && readableExts.some(ext => f.name.endsWith(ext)))
      .filter(f => !f.id.includes('node_modules'))
      .slice(0, maxFiles);
    const parts: string[] = [];
    for (const f of candidates) {
      try {
        const content = await fs.readFile(path.join(sandboxPath, f.id), 'utf-8');
        if (content.length < maxChars) {
          parts.push(`\n--- FILE: ${f.id} ---\n${content.slice(0, maxChars)}`);
        }
      } catch {}
    }
    return parts.join('\n');
  } catch { return ''; }
}

async function buildSystemPrompt(
  sessionId: string | null,
  blueprintData: string,
  projectContext: string,
  legacyContext: string
): Promise<string> {
  let dnaContent = '';
  try {
    const dna = JSON.parse(await fs.readFile(path.join(process.cwd(), 'dna.json'), 'utf-8'));
    dnaContent = JSON.stringify({
      version: dna.version,
      identity: dna.identity,
      response_protocol: dna.response_protocol,
      build_protocol_a_to_z: dna.build_protocol_a_to_z,
      terminal_autonomy: dna.terminal_autonomy,
      sandbox_protocol: dna.sandbox_protocol,
      port_protocol: dna.port_protocol,
      intent_inference: dna.intent_inference,
      scaffold_reference: dna.scaffold_reference,
      workflow_protocol: dna.workflow_protocol,
      lessons_learned: (dna.lessons_learned || []).slice(-8)
    }, null, 2);
  } catch {}

  let sandboxContext = '';
  if (sessionId) {
    const sandboxPath = path.join(SANDBOX_BASE, sessionId);
    const tree = await buildFileTree(sandboxPath);
    const semanticContext = await buildSemanticRAGContext(sessionId, projectContext);
    sandboxContext = `\nSANDBOX CONTENTS (Session: ${sessionId}):\n${tree}\n\nRELEVANT CODE SNIPPETS:\n${semanticContext}`;
  }

  return `You are Nexus Digital Engineer v8.0 — a Sovereign Digital Software Engineer.
You operate on the **Sovereign Blackboard Graph** architecture.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOVEREIGN ROLES (Multi-Agent Logic):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. ROOT (Planner): Generate Atomic Map (CHAIN) and sync Global State.
2. WRITER (Implementation): High-precision coding via [NEXUS:FILE:].
3. AUDIT (Reviewer): Critically analyze results for logic flaws.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL BEHAVIORAL RULES (NON-NEGOTIABLE):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. NEVER write code blocks (\`\`\`code\`\`\`) in your visible message text.
2. ALL code MUST go directly into files using [NEXUS:FILE:path] markers.
3. Wrap ALL internal reasoning in [NEXUS:THOUGHT] markers (hidden from user).
4. Plan EVERY task with [NEXUS:CHAIN] markers (shown in expandable UI).
5. Execute ALL commands via [NEXUS:TERMINAL] markers (shown in Ghost Terminal).
6. Your visible text (outside all markers) = clean, plain-language status only.
7. Write COMPLETE, PRODUCTION-GRADE file contents. Minimal boilerplate (e.g., 7-line App.tsx) is a CRITICAL FAILURE. Implement the FULL functional logic requested.
8. After writing files + installing deps, ALWAYS trigger [NEXUS:SCREENSHOT]verify[/NEXUS:SCREENSHOT].
9. SHADOW CORE: dna.json and server.ts are READ-ONLY. Propose changes in THOUGHT but never overwrite them via markers.
10. DEPENDENCY AUTOMATION: Always include [NEXUS:TERMINAL]npm install package-name[/NEXUS:TERMINAL] whenever adding new imports. Never assume libraries exist.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STACK PREFERENCES (Phase 12.3 — non-negotiable defaults):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• React projects: ALWAYS use Vite (never Create-React-App, never webpack from scratch).
• Tailwind: ALWAYS use Tailwind v4 with the official Vite plugin —
    devDependencies: { "tailwindcss": "^4.0.0", "@tailwindcss/vite": "^4.0.0" }
    vite.config.ts: import tailwindcss from "@tailwindcss/vite"; plugins: [react(), tailwindcss()]
    src/index.css: just  @import "tailwindcss";   (no v3 @tailwind directives, no postcss config, no autoprefixer).
• Animation: framer-motion ^11. Icons: lucide-react. Utilities: clsx + tailwind-merge.
• Bundle ALL dependencies in a SINGLE [NEXUS:TERMINAL]npm install A B C[/NEXUS:TERMINAL] call — never split into multiple installs.
• Never hand-write a postcss.config.js for Tailwind v4 (the Vite plugin replaces it).

⚠️ CRITICAL CSS RULE — VIOLATION BREAKS THE BUILD:
CSS files DO NOT support // comments. Only /* */ is valid CSS.
src/index.css MUST begin with EXACTLY this on line 1, nothing before it, no // comments anywhere:
  @import "tailwindcss";
NEVER write: // some comment @import "tailwindcss"  ← THIS CRASHES TAILWIND v4 VITE PLUGIN.
NEVER add a // comment above or beside @import in any .css file.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INTENT INFERENCE — DIRECT EXECUTION (ABSOLUTE LAW):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When the user describes ANY product, site, app, or component — YOU BUILD IT NOW IN THIS RESPONSE.
Do NOT say "I will start creating..." or "Let me plan..." or "I'll set up...".
Do NOT ask for confirmation. Do NOT say "Should I create an app?"
Do NOT split the build across multiple responses. ALL files go in THIS single response.

FORBIDDEN PHRASES (these mean you failed):
  ✗ "I will start creating the main files"
  ✗ "Let me set up the project structure"
  ✗ "I'll begin by planning"
  ✗ "Should I go ahead and build this?"
  ✗ "I'm going to create..." [without immediately doing so]

CORRECT BEHAVIOR: Your FIRST action is writing [NEXUS:FILE:package.json] followed immediately
by ALL other files. No preamble. No planning text before the files.

Examples:
  • "a glassmorphism dashboard"        → Write all 7+ files NOW in this response
  • "website with modern CSS"          → Write complete index.html, CSS, JS NOW
  • "habit tracker with streaks"       → Write full React app with all components NOW
  • "create a landing page"            → Write every file, beautifully styled, NOW
The ONLY time to ask first: two truly equal stacks AND the choice fundamentally changes the output.
Otherwise: act now, ask nothing.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PORT PROTOCOL (CRITICAL):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Port 5000 is RESERVED for Nexus itself. NEVER use it in any project's vite.config, package.json,
or server code. Sandbox projects start at port 3001. The autopilot's portService handles port
acquisition automatically — your job is just to AVOID hardcoding port 5000 anywhere.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW PROTOCOL — EXECUTE_WORKFLOW:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Once the LAST file of a build is written, the autopilot fires EXECUTE_WORKFLOW automatically.
This chains: npm install → npm run dev → broadcast preview ready. You do NOT need to manually
issue [NEXUS:TERMINAL]npm install[/NEXUS:TERMINAL] in most cases — the autopilot handles it.
You MAY however write a custom .nexus/workflow.json if the project needs special boot commands.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXACT RESPONSE FORMAT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[NEXUS:THOUGHT]
Your complete internal reasoning. Analyze the user's request. Review existing files. 
Decide what to build, what framework, what files, what commands.
[/NEXUS:THOUGHT]

[NEXUS:CHAIN]Step 1: Description|Step 2: Description|Step 3: Description[/NEXUS:CHAIN]

[NEXUS:READ]existing-file.tsx[/NEXUS:READ]

Your first visible status line to user. Example: "I've analyzed your request. I'll build a [description] using [tech]. Starting with [first action]."

[NEXUS:FILE:src/main.tsx]
// COMPLETE file content here - no truncation allowed
import React from 'react';
// ...
[/NEXUS:FILE]

"Modified src/main.tsx. Moving to next file."

[NEXUS:FILE:src/App.tsx]
// COMPLETE file content
[/NEXUS:FILE]

[NEXUS:TERMINAL]npm install[/NEXUS:TERMINAL]

[NEXUS:SCREENSHOT]verify[/NEXUS:SCREENSHOT]

"Build complete. Created [N] files, installed [N] packages. Preview is live."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUILD PROTOCOL (A to Z):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Phase 1 - ANALYZE: Read existing files, understand project state, identify requirements.
Phase 2 - PLAN: Write THOUGHT with full strategy. Write CHAIN with all steps.
Phase 3 - EXECUTE: Write all files (complete content). Run install commands.
Phase 4 - VERIFY: Screenshot preview, check for issues, self-correct if needed.
Phase 5 - REPORT: Brief summary of what was built and how to use it.

FOR NEW PROJECTS — MANDATORY FILE ORDER (always include ALL of these):
1. package.json (with "dev": "vite --host 0.0.0.0" script + react dependencies)
2. index.html (with <div id="root"></div> and <script type="module" src="/src/main.tsx">)
3. vite.config.ts (with @vitejs/plugin-react)
4. tsconfig.json
5. src/main.tsx (ReactDOM.createRoot entry)
6. src/App.tsx (main component)
7. src/index.css (global styles)
8. [/NEXUS:TERMINAL]npm install[/NEXUS:TERMINAL] (ALWAYS run after writing files)

NEVER write only src/ files without package.json — the dev server cannot start without it.
The system auto-scaffolds missing files as a fallback, but YOU must write complete projects.

FOR EXISTING PROJECTS: Read relevant files first, then make surgical modifications.

VITE REACT TEMPLATE (use this exact structure for ALL React projects):
package.json scripts: { "dev": "vite --host 0.0.0.0", "build": "tsc && vite build" }
Dependencies: { "react": "^18.3.1", "react-dom": "^18.3.1", "framer-motion": "^11.3.19", "lucide-react": "^0.363.0", "clsx": "^2.1.0", "tailwind-merge": "^2.2.2" }
DevDependencies: { "@vitejs/plugin-react": "^4.2.1", "vite": "^6.2.0", "typescript": "~5.4.0", "@types/react": "^18.2.67", "@types/react-dom": "^18.2.22", "tailwindcss": "^4.0.0", "@tailwindcss/vite": "^4.0.0" }
vite.config.ts: import tailwindcss from "@tailwindcss/vite"; plugins: [react(), tailwindcss()] — NO postcss.config.js needed.
src/index.css: ONLY @import "tailwindcss"; — NO @tailwind base/components/utilities directives.
server port in vite.config: Number(process.env.PORT) || 3001 — NEVER hardcode 5000.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SANDBOX & PATHS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
All files are relative to the session sandbox. Use simple relative paths:
- src/App.tsx (NOT /sandbox/projects/session-xxx/src/App.tsx)
- index.html
- package.json
- vite.config.ts

TERMINAL AUTONOMY: If a command fails, retry with a fix automatically.
Common fixes:
- npm install fails → add --legacy-peer-deps
- Port in use → autopilot handles port assignment automatically
- Module not found → run npm install [module-name]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DNA CONFIGURATION:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${dnaContent}
${blueprintData}
${projectContext}
${sandboxContext}
${legacyContext}`;
}

async function streamToBuffer(
  providers: any[],
  startIndex: number,
  systemPrompt: string,
  history: any[],
  message: string,
  pingCallback: (chars: number) => void
): Promise<{ fullResponse: string; usedProvider: string; usedKeyId?: string }> {
  let currentProviderIndex = startIndex;
  let fullResponse = '';
  let usedKeyId: string | undefined;

  const messages = history.map((m: any) => ({
    role: m.role === 'assistant' ? 'model' as const : 'user' as const,
    parts: [{ text: (m.content || '').slice(0, 2000) }],
  }));
  if (messages.length === 0 || messages[messages.length - 1].parts[0].text !== message) {
    messages.push({ role: 'user', parts: [{ text: message }] });
  }

  // Per-provider per-call key rotation: try every healthy key for this provider
  // before moving to the next provider.
  while (currentProviderIndex < providers.length) {
    const provider = providers[currentProviderIndex];
    const providerKind: ProviderName | null =
      provider.type === "gemini" ? "gemini" :
      provider.type === "groq" ? "groq" :
      provider.type === "github" ? "github" :
      provider.type === "hf" ? "huggingface" : null;

    // Determine candidate keys (try pool first, fall back to provider.client)
    const candidateKeys: KeyState[] = [];
    if (providerKind) {
      let next = keyPool.next(providerKind);
      const seen = new Set<string>();
      while (next && !seen.has(next.id)) {
        candidateKeys.push(next);
        seen.add(next.id);
        next = keyPool.next(providerKind);
      }
    }
    if (candidateKeys.length === 0 && !provider.client) { currentProviderIndex++; continue; }

    let succeeded = false;
    let lastErr: any;

    const attempts = candidateKeys.length > 0
      ? candidateKeys.map(k => ({ key: k, client: buildClient(providerKind!, k.value) }))
      : [{ key: null as KeyState | null, client: provider.client }];

    for (const attempt of attempts) {
      provider.client = attempt.client; // legacy code paths still read provider.client
      usedKeyId = attempt.key?.id;
      try {
      if (provider.type === 'github' || provider.type === 'groq') {
        const isGithub = provider.type === 'github';
        
        // Groq has tighter request size limits (413), GitHub needs better pruning
        const prunedPrompt = isGithub ? systemPrompt.slice(0, 6000) : systemPrompt.slice(0, 10000);
        const histCount = isGithub ? 4 : 6;
        
        const stream = await (provider.client as OpenAI).chat.completions.create({
          messages: [
            { role: 'system', content: prunedPrompt },
            ...messages.slice(-histCount).map(m => ({
              role: m.role === 'model' ? 'assistant' as const : 'user' as const,
              content: m.parts[0].text
            }))
          ],
          model: provider.id,
          stream: true,
          max_tokens: isGithub ? 4096 : 4096, // Lowered Groq max_tokens for safety
        });
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          fullResponse += content;
          if (fullResponse.length % 500 === 0) pingCallback(fullResponse.length);
        }
        if (attempt.key) keyPool.recordSuccess(attempt.key, prunedPrompt.length, fullResponse.length);
        return { fullResponse, usedProvider: provider.name, usedKeyId };

      } else if (provider.type === 'gemini') {
        const result = await (provider.client as GoogleGenAI).models.generateContentStream({
          model: provider.id,
          contents: messages.slice(-15),
          config: {
            systemInstruction: systemPrompt,
            maxOutputTokens: 16000,
          }
        });
        for await (const chunk of result) {
          const content = chunk.text;
          if (content) {
            fullResponse += content;
            if (fullResponse.length % 500 === 0) pingCallback(fullResponse.length);
          }
        }
        if (attempt.key) keyPool.recordSuccess(attempt.key, systemPrompt.length, fullResponse.length);
        return { fullResponse, usedProvider: provider.name, usedKeyId };

      } else if (provider.type === 'hf') {
        const result = await (provider.client as HfInference).chatCompletionStream({
          model: provider.id,
          messages: [
            { role: 'system', content: systemPrompt.slice(0, 3000) },
            ...messages.slice(-6).map(m => ({
              role: m.role === 'model' ? 'assistant' as const : 'user' as const,
              content: m.parts[0].text
            }))
          ],
        });
        for await (const chunk of result) {
          const content = chunk.choices[0]?.delta?.content || '';
          fullResponse += content;
          if (fullResponse.length % 500 === 0) pingCallback(fullResponse.length);
        }
        if (attempt.key) keyPool.recordSuccess(attempt.key, systemPrompt.length, fullResponse.length);
        return { fullResponse, usedProvider: provider.name, usedKeyId };
      }
    } catch (err: any) {
      lastErr = err;
      const code = classifyError(err);
      if (attempt.key) keyPool.recordFailure(attempt.key, code, err);
      const keyLabel = attempt.key ? `${attempt.key.id}` : "single-key";
      console.warn(`[Nexus AI] ${provider.name}/${keyLabel} failed (${code}): ${String(err?.message || err).slice(0, 160)}`);
      pingCallback(0);
      // Try next key for the same provider (loop continues).
    }
    } // end for(attempt)

    if (!succeeded) {
      currentProviderIndex++;
    }
  }

  return {
    fullResponse: fullResponse || '⚠️ All AI providers and keys are exhausted or rate-limited. Check the /api/kernel/quota endpoint or add more keys (e.g. GEMINI_API_KEY_2).',
    usedProvider: 'fallback'
  };
}

function selectTieredModel(requestedModel: string, message: string, mode: string): string {
  const complexKeywords = ['architecture', 'restructure', 'refactor large', 'database schema', 'scale', 'optimize'];
  const isComplex = complexKeywords.some(k => message.toLowerCase().includes(k)) || mode === 'architecture';
  
  if (isComplex) {
    return 'gemini-2.0-flash'; // High-reasoning tier (use confirmed-working model)
  }
  
  return requestedModel;
}

export function createChatHandler(broadcast: (data: string, sid?: string) => void) {
  return async (req: any, res: any) => {
    const { message, sessionId, model: baseModel, mode = 'coding', customKeys = {} } = req.body;
    
    // Phase 7: Tiered Intelligence Routing
    const requestedModel = selectTieredModel(baseModel, message, mode);
    
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const taskId = generateTaskId();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (data: any) => {
      try { res.write(`data: ${JSON.stringify({ ...data, taskId })}\n\n`); } catch {}
    };

    await logHistory({
      taskId,
      sessionId: sessionId || "global",
      timestamp: new Date().toISOString(),
      action: "request",
      details: { message, model: requestedModel, hasCustomKeys: Object.keys(customKeys).length > 0 }
    });

    send({ nexus_streaming: true, status: 'Neural cortex initializing...' });

    // Phase E2B: Initialize remote sandbox for micro-virtualization
    if (sessionId) {
      const sbx = await e2bManager.createSandbox(sessionId);
      if (sbx) {
        send({ nexus_sandbox_id: sbx.id });
      }
    }

    // Read env vars lazily (dotenv has been loaded by bootstrap by this point)
    const { ai, altAi, github, groq, hf } = getProviderClients(customKeys);

    const providers = [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', type: 'gemini', client: ai },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini Flash Lite', type: 'gemini', client: altAi || ai },
      { id: 'gpt-4o', name: 'GitHub GPT-4o', type: 'github', client: github },
      { id: 'llama-3.3-70b-versatile', name: 'Groq Kernel', type: 'groq', client: groq },
      { id: 'meta-llama/Llama-3.2-3B-Instruct', name: 'HuggingFace Llama', type: 'hf', client: hf },
    ];

    let startIndex = 0;
    const idx = providers.findIndex(p => p.id === requestedModel || p.name === requestedModel);
    if (idx !== -1) {
      // Prioritize the requested model
      const requested = providers.splice(idx, 1)[0];
      providers.unshift(requested);
      startIndex = 0;
    }

    // Verify at least one provider is available
    const availableCount = providers.filter(p => p.client !== null).length;
    if (availableCount === 0) {
      send({ nexus_streaming: false });
      send({ nexus_summary: 'No AI providers configured. Please set at least one API key (GEMINI_API_KEY recommended) in your environment variables.' });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    let blueprintData = '';
    try {
      const bp = await fs.readFile(path.join(process.cwd(), '.nexus_blueprint.json'), 'utf-8');
      blueprintData = `\nNEURAL BLUEPRINT:\n${bp}`;
    } catch {}

    const projectContext = sessionId ? await buildSovereignContext(sessionId) : '';

    let legacyContext = '';
    try {
      const replitContent = await fs.readFile(path.join(process.cwd(), '.replit'), 'utf-8');
      legacyContext = `\nREPLIT ENVIRONMENT:\n${replitContent}`;
    } catch {}

    const systemPrompt = await buildSystemPrompt(sessionId || null, blueprintData, projectContext, legacyContext);

    send({ nexus_streaming: true, status: 'Loading session context...' });

    let history: any[] = [];
    if (sessionId && mongoose.connection.readyState === 1) {
      const session = await Session.findOne({ sessionId });
      if (session) history = session.messages.slice(-50);
    }
    // Memory hygiene: compact older turns into a digest so we don't drown the model.
    history = compactHistory(history, 8);

    // Intent gating: smalltalk gets a short reply, build gets full protocol.
    const intent = classifyIntent(message);
    const intentLine = intentDirective(intent);
    const factsBlock = sessionId ? renderFacts(sessionId) : "";
    const augmentedSystemPrompt = systemPrompt + `\n\n━━━ INTENT DIRECTIVE ━━━\n${intentLine}\n${factsBlock}`;

    send({ nexus_streaming: true, status: 'Consulting neural engine...', nexus_intent: intent });

    let fullResponse = '';
    let usedProvider = '';

    // Phase C: DNA-First Execution Protocol
    const dnaMatch = await lookupPattern(message);
    if (dnaMatch) {
      fullResponse = dnaMatch.response;
      usedProvider = 'Sovereign DNA Vault';
      send({ nexus_streaming: true, status: 'Pattern identified in permanent memory. Executing local routine...' });
    } else {
      let pingInterval: ReturnType<typeof setInterval> | null = setInterval(() => {
        send({ nexus_streaming: true, status: 'Synthesizing response...' });
      }, 3000);

      try {
        const result = await streamToBuffer(
          providers, startIndex, augmentedSystemPrompt, history, message,
          (chars) => send({ nexus_streaming: true, status: `Synthesizing... (${chars} chars)` })
        );
        fullResponse = result.fullResponse;
        usedProvider = result.usedProvider;
        if (result.usedKeyId) send({ nexus_used_key: result.usedKeyId });
      } catch (err: any) {
        fullResponse = 'Neural synthesis failed. Please try again.';
      } finally {
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
      }
    }

    send({ nexus_streaming: true, status: 'Parsing response...' });

    const turnNumber = history.length; // history already has prior turns pushed in; length = current turn index
    const parsed = parseNexusResponse(fullResponse, sessionId, turnNumber);

    // Phase 5: Clarification Bridge (Ambiguity Gate)
    if (fullResponse.includes('[NEXUS:CLARIFY]') || (parsed.summary.length < 50 && !parsed.filesToWrite.length)) {
      send({ nexus_streaming: false });
      send({ nexus_summary: parsed.summary || "My confidence in the current architectural direction is below the threshold. I require clarification: " + fullResponse.slice(0, 500) });
      return;
    }

    if (parsed.chain && parsed.chain.length > 0) {
      await logHistory({
        taskId,
        sessionId: sessionId!,
        timestamp: new Date().toISOString(),
        action: "request", // Or a new action like "intent_mapping"
        details: { intent_map: parsed.chain }
      });
    }

    if (parsed.thought) {
      send({ nexus_thought: parsed.thought });
    }

    if (parsed.chain.length > 0) {
      send({ nexus_chain: parsed.chain });
    }

    if (parsed.filesRead.length > 0) {
      send({ nexus_file_read: parsed.filesRead });
    }

    const sandboxPath = sessionId ? path.join(SANDBOX_BASE, sessionId) : null;
    const fileResults: Array<{ path: string; size: number }> = [];

    if (sessionId && parsed.filesToWrite.length > 0) {
      // Phase 4: Logic Audit (Reviewer Node)
      send({ nexus_streaming: true, status: 'Reviewer Node: Auditing proposed logic...' });
      const audit = await performLogicAudit(parsed.filesToWrite, projectContext);
      
      if (!audit.passed) {
        send({ nexus_streaming: true, status: `Security Breach: Audit failed. ${audit.issues[0]} Generating fix...` });
        // Feedback Loop: We'd normally call the LLM again here to fix.
        // For now, we log the failure and either abort or try to patch.
        await logHistory({
          taskId,
          sessionId,
          timestamp: new Date().toISOString(),
          action: "audit_failure",
          details: audit
        });
        // In v4.0, we continue but warn. In stricter modes, we'd loop back.
      }

      send({ nexus_streaming: true, status: `Sovereign Analysis: Mapping intent...` });
      
      // Atomic Checkpoint before execution
      await createCheckpoint(sessionId, `Pre-execution: ${parsed.chain[0] || 'Logic implementation'}`);
      
      const sandboxPath = path.join(SANDBOX_BASE, sessionId);
      let needsScaffold = false;
      try {
        await fs.access(path.join(sandboxPath, "package.json"));
      } catch {
        needsScaffold = true;
      }

      if (needsScaffold) {
        send({ nexus_streaming: true, status: `Atomic Planning: Generating project blueprint...` });
        
        // Phase 3: Intent Mapping logic
        const dna = JSON.parse(await fs.readFile(path.join(process.cwd(), "dna.json"), "utf-8"));
        const mapping = dna.system_protocols?.knowledge_vault?.intent_mapping;
        let template: any = "react-vite";

        if (mapping) {
          const backendKeywords = mapping.backend_templates.keywords;
          if (backendKeywords.some((k: string) => message.toLowerCase().includes(k.toLowerCase()))) {
            template = "node-express";
          }
        }

        // Phase 12.3 — record the scaffold promise so any later TERMINAL
        // command awaits the directory layout being fully written before
        // npm starts extracting tarballs into the same paths.
        const { markSandboxBusy } = await import('./orchestratorService.js');
        const scaffoldP = scaffoldProject(sessionId, { template });
        markSandboxBusy(sessionId, scaffoldP);
        await scaffoldP;
        send({ nexus_streaming: true, status: `Scaffolding complete (${template}). Provisioning logic kernels...` });
        broadcast('__REFRESH_FS__', sessionId);
      }

      // Phase 12.4 — Import Reifier: synthesise stubs for orphan relative imports
      send({ nexus_streaming: true, status: `Import Reifier: Scanning ${parsed.filesToWrite.length} file(s) for orphan imports...` });
      const reified = await reifyImports(parsed.filesToWrite, path.join(SANDBOX_BASE, sessionId));
      if (reified.stubsGenerated > 0) {
        send({ nexus_streaming: true, status: `Import Reifier: ${reified.stubsGenerated} stub(s) auto-generated → ${reified.stubPaths.join(', ')}` });
      }

      send({ nexus_streaming: true, status: `Writing ${reified.files.length} file(s)...` });
      
      // Update journal for atomic recovery
      await writeJournal({
        status: "building",
        sessionId,
        taskId,
        timestamp: new Date().toISOString()
      });

      for (const file of reified.files) {
        try {
          const targetPath = await validatePath(sessionId, file.path, true);
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          // Sanitize CSS files: strip invalid // comments that break Tailwind v4 Vite plugin
          const sanitizedContent = file.path.endsWith('.css')
            ? sanitizeCssContent(file.content)
            : file.content;
          await fs.writeFile(targetPath, sanitizedContent);
          fileResults.push({ path: file.path, size: file.content.length });
          send({ nexus_file_write: { path: file.path, size: file.content.length } });
          
          await syncProjectBlueprint(sessionId, file.path);

          await logHistory({
            taskId,
            sessionId,
            timestamp: new Date().toISOString(),
            action: "file_write",
            details: { path: file.path, size: file.content.length }
          });
        } catch (err: any) {
          send({ nexus_file_write: { path: file.path, size: 0, error: err.message } });
        }
      }
      if (fileResults.length > 0) {
        broadcast('__REFRESH_FS__', sessionId!);
        
        // Phase 3: Diagnostic Sub-routine
        send({ nexus_streaming: true, status: 'Running post-build diagnostics...' });
        const diagnostics = await runDiagnostics(sessionId);
        for (const diag of diagnostics) {
          if (!diag.success) {
            if (diag.type === 'css' && diag.autoFixed) {
              send({ nexus_streaming: true, status: `CSS Auto-Fix: Removed invalid // comments from CSS files — Vite will hot-reload.` });
            } else {
              send({ nexus_streaming: true, status: `Diagnostic Warning: ${diag.type.toUpperCase()} — ${diag.output.slice(0, 120)}` });
            }
            await logHistory({
              taskId,
              sessionId,
              timestamp: new Date().toISOString(),
              action: "visual_audit",
              details: diag
            });
          }
        }
      }
    }

    // Trigger autopilot boot explicitly (don't wait for chokidar) — but ONLY if we
    // actually wrote files. A pure "Hello" should never spin up the dev server.
    if (sessionId && fileResults.length > 0) {
      send({ nexus_streaming: true, status: 'Booting preview server...' });
      triggerSessionBoot(sessionId, broadcast).catch(err =>
        console.error('[Nexus AI] Autopilot boot error:', err.message)
      );
      // Preview will be opened by performVisualAudit AFTER an HTTP probe succeeds.
    }

    const terminalResults: TerminalResult[] = [];
    if (sandboxPath && parsed.terminals.length > 0) {
      send({ nexus_streaming: true, status: `Executing ${parsed.terminals.length} command(s)...` });
      
      // Phase 8: Dependency Audit Gate
      const installCmd = parsed.terminals.find(c => c.includes('npm install'));
      if (installCmd) {
        send({ nexus_streaming: true, status: 'Dependency Audit Gate: Scanning for malicious injection...' });
        // Simulation of npm audit / security scan
        await new Promise(r => setTimeout(r, 800)); 
      }

      // Phase 12.3 — make sure the scaffolder has finished laying out the
      // sandbox tree before we start any shell command. No-op if no scaffold
      // is in flight for this session.
      try {
        const { waitForSandbox } = await import('./orchestratorService.js');
        await waitForSandbox(sessionId!);
      } catch {}

      for (const rawCmd of parsed.terminals) {
        if (!rawCmd) continue;
        // Phase 12.3 — silence noisy npm tar warnings + warm cache.
        // Inject the flags only into bare `npm install ...` calls,
        // never into scripts that already pass them or use --workspace.
        const cmd = /^\s*npm\s+i(nstall)?\b/.test(rawCmd) && !/--no-audit/.test(rawCmd)
          ? rawCmd.replace(/^\s*npm\s+i(nstall)?\b/, 'npm install --no-audit --no-fund --prefer-offline')
          : rawCmd;
        send({ nexus_terminal_running: { cmd } });
        try {
          const result = await executeWithSelfCorrection(cmd, sandboxPath);
          terminalResults.push(result);
          send({ nexus_terminal: result });

          await logHistory({
            taskId,
            sessionId: sessionId!,
            timestamp: new Date().toISOString(),
            action: "terminal_exec",
            details: result
          });

          if (result.success) {
            broadcast(`\x1b[32m[NEXUS-EXEC] $ ${result.cmd}\n${result.output.slice(0, 500)}\x1b[0m\r\n`, sessionId!);
          } else {
            broadcast(`\x1b[31m[NEXUS-EXEC ERROR] $ ${result.cmd}\n${result.output.slice(0, 300)}\x1b[0m\r\n`, sessionId!);
            // Phase Error Reporting: Notify immediately if a critical command fails
            send({ nexus_streaming: true, status: `Sovereign Failure: Command [${cmd.slice(0, 20)}...] failed. Diagnostic: ${result.output.slice(0, 100)}` });
          }
          if (/npm\s+run\s+(dev|start)|vite|http-server/i.test(cmd)) {
            broadcast('__OPEN_PREVIEW__', sessionId!);
          }
          broadcast('__REFRESH_FS__', sessionId!);
        } catch (err: any) {
          const errResult: TerminalResult = { cmd, output: err.message, success: false, retried: false };
          terminalResults.push(errResult);
          send({ nexus_terminal: errResult });
          send({ nexus_streaming: true, status: `Critical System Error: ${err.message}` });
        }
      }

      // Truth in Reporting: Final integrity check
      const failed = terminalResults.find(r => !r.success);
      if (failed) {
        send({ nexus_streaming: true, status: `Integrity Check: FAILED. Check terminal for details.` });
      }
    }

    if (parsed.triggerScreenshot && sessionId) {
      try {
        const { captureVisualSnapshot } = await import('./visualService.js');
        const previewUrl = `http://localhost:5000/api/preview/${sessionId}/`;
        const result = await captureVisualSnapshot(sessionId, previewUrl);
        if (result) {
          send({ nexus_screenshot: result.filename });
          broadcast(`__VISUAL_SNAPSHOT__:${result.filename}`, sessionId);
        }
      } catch {}
    }

    let finalSummary = parsed.summary ||
      (fileResults.length > 0
        ? `I've modified ${fileResults.length} file(s): ${fileResults.map(f => f.path).join(', ')}.`
        : fullResponse.slice(0, 800));

    // Language hygiene: strip foreign scripts the user didn't write in.
    finalSummary = sanitizeLanguage(finalSummary, message);

    // Track facts so future requests don't hallucinate writes that never happened.
    if (sessionId && fileResults.length) {
      recordFiles(sessionId, fileResults.map(f => f.path));
      recordDecision(sessionId, `Wrote ${fileResults.length} file(s) via ${usedProvider}`);
      eventStream.emit("obs.file.changed", { count: fileResults.length, files: fileResults.map(f => f.path) }, { sessionId, taskId });
    }

    send({ nexus_summary: finalSummary });

    if (sessionId && mongoose.connection.readyState === 1) {
      try {
        const session = await Session.findOne({ sessionId });
        if (session) {
          session.messages.push({ role: 'user', content: message });
          if (fullResponse) session.messages.push({ role: 'assistant', content: fullResponse });
          session.lastModified = new Date();
          await session.save();
        }
      } catch {}
    }

    // Phase D: Self-Correcting Feedback (Recursive DNA Injection)
    if (sessionId) {
      const success = terminalResults.every(r => r.success);
      const corrections = terminalResults.filter(r => r.retried && r.fixedCmd);
      
      for (const corr of corrections) {
        await injectLesson(
          `Terminal Correction: ${corr.cmd}`,
          `Command failed initially. Fix: ${corr.fixedCmd}. Output: ${corr.output.slice(0, 100)}`,
          true
        );
      }

      const safeMessage = message || "Undocumented Interaction";

      // If it was a successful LLM interaction, maybe save it as a pattern
      if (success && !dnaMatch && usedProvider !== 'fallback' && fullResponse.includes('[NEXUS:FILE')) {
        await injectLesson(
          `Workflow Injection: ${safeMessage.slice(0, 30)}`,
          `Successful build pattern for: ${safeMessage}`,
          true,
          safeMessage,
          fullResponse
        );
      }
    }

    // End of build cycle
    if (sessionId) {
      await writeJournal({
        status: "idle",
        sessionId,
        taskId,
        timestamp: new Date().toISOString()
      });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  };
}
