// ─── Shared Constants ───────────────────────────────────────────────────────
export const SOVEREIGN_BACKUP = `# NEXUS SOVEREIGN DNA (v6.2)
> IDENTITY • ARCHITECTURE • PROTOCOL • KERNEL

## 1. IDENTITY & AUTHORITY (THE MANIFESTO)
Nexus AI recognizes itself as a **Portable Sovereign Entity**. The Governor of all logic is this document. All sessions must synchronize with this truth.
- **Physical Handshake:** Every session MUST validate this document.
- **DNA Purification:** Purge visual constraints; structural integrity is absolute.
- **Sovereign Failover:** Autonomously switch between Gemini, Groq, and GitHub during blockade (401, 404, 429). SELF-HEAL.
- **Execution Sovereignty:** All projects reside in \`/sandbox/projects/\`. Execution is incomplete until \`verify-keys.ts\` yields a GREEN light ✅.

## 2. KERNEL PROTOCOLS (THE ENGINE)
- **Zero-Code Policy:** AI avoids raw code in chat. Commands are embedded as terminal blocks.
- **Neural Blueprint:** Maintain \`.nexus_blueprint.json\` for structural memory and efficiency.
- **Visual Intelligence:** Automated snapshots detect UI regressions via DOM coordinate mapping and accessibility audits.
- **Interface Standards:** Collapse thinking units; summarize logic. Initialize to Home view (Neural Purity).
- **Model Priority:**
  1. **GPT-4o (GitHub):** Structural Reasoning.
  2. **Gemini:** Fast Iteration & Search.
  3. **Groq:** Neural Inference.
  4. **HuggingFace:** Open-source Logic Engine.

## 3. STRUCTURAL DNA (ARCHITECTURE MAP)
- **Server Hub (\`server.ts\`):** Manages Neural Memory (MongoDB), Sandbox Shells (Isolation), and AI Handshakes.
- **IDE Context (\`NexusContext.tsx\`):** Orchestrates sessions, file refreshes, and state persistence.
- **UI Rail (\`NavigationRail.tsx\`):** 7-element activity bar for context switching.
- **Sovereign Standard:**
  - Atomic Planning & Predictive Architecture.
  - Cross-File Consciousness (Global Context Sync).
  - Recursive Project Mapping & Blueprint Mastery.
  - Temporal Healing & Auto-Recovery (Backups & Rollback).
  - Hybrid Visual Debugging (DOM Mapping & Safety Audits).
  - Zero-Defect Refactoring.

## 4. INTEGRATION SCHEMAS
- **Memory:** \`Message\`, \`Session\`, \`Project\`.
- **Sandbox:** \`FileItem\`, \`Task\`, \`SubTask\`.
- **System:** \`IDEState\`, \`SystemStatus\`, \`Notification\`.

---
*Nexus AI v6.2 • Sovereign Intelligence Alpha • single_source_truth: true*`;

// ─── Frontend Constants ───────────────────────────────────────────────────────
export const MODELS = [
  { id: 'gpt-4o', name: 'GitHub GPT-4o', desc: 'Structural Reasoning & Logic' },
  { id: 'gemini-1.5-flash', name: 'Gemini Flash', desc: 'Fast Iteration & Search' },
  { id: 'groq', name: 'Groq Kernel', desc: 'Neural Inference Speed' },
  { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'HuggingFace Qwen', desc: 'Open-source Logic Engine' },
];

export const MODES = [
  { id: 'coding', name: 'Coding', desc: 'Engineered Solutions' },
  { id: 'research', name: 'Research', desc: 'Fact-based Synthesis' },
  { id: 'creative', name: 'Creative', desc: 'Breakthrough Ideas' },
];

export type ThemeMode = 'dark' | 'light' | 'mixed';
export interface ThemeDef {
  id: string;
  name: string;
  desc: string;
  mode: ThemeMode;
  swatch: [string, string, string];
}

export const THEMES: ThemeDef[] = [
  { id: 'sovereign-dark',   name: 'Sovereign Dark',   desc: 'Default neural interface · gold + cyan',
    mode: 'dark',  swatch: ['#0a0a0c', '#d4af37', '#4ec9b0'] },
  { id: 'aurora-light',     name: 'Aurora Light',     desc: 'Premium daylight · teal + royal violet',
    mode: 'light', swatch: ['#fafbff', '#0e7490', '#6d28d9'] },
  { id: 'tokyo-twilight',   name: 'Tokyo Twilight',   desc: 'Coral + lilac + sky on indigo dusk',
    mode: 'dark',  swatch: ['#0c0a14', '#f7768e', '#7dcfff'] },
  { id: 'sahara-dune',      name: 'Sahara Dune',      desc: 'Warm sand · terracotta · deep plum',
    mode: 'light', swatch: ['#fef9f0', '#c0392b', '#6b2c5e'] },
  { id: 'northern-mist',    name: 'Northern Mist',    desc: 'Nordic frost · sage + glacier blue',
    mode: 'mixed', swatch: ['#1c2127', '#88c0d0', '#a3be8c'] },
  { id: 'synthwave-sunset', name: 'Synthwave Sunset', desc: 'Retro magenta + electric mint',
    mode: 'dark',  swatch: ['#14062b', '#ff2a6d', '#2de2e6'] },
  { id: 'verdant-lab',      name: 'Verdant Lab',      desc: 'Biotech lime · emerald · cyan-green',
    mode: 'dark',  swatch: ['#050d0a', '#c5e639', '#2dd4bf'] },
  { id: 'carbon-fiber',     name: 'Carbon Fiber',     desc: 'Industrial signal orange + electric',
    mode: 'mixed', swatch: ['#1a1a1d', '#ff6b35', '#00b4d8'] },
];
