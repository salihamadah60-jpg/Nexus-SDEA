/**
 * Manifest Healer — Phase 12.5
 *
 * Runs after the AI's file-write batch lands but BEFORE the autopilot
 * boots npm install / vite. Purpose: patch the all-too-common
 * configuration mistakes the planner LLM makes that turn a "high-end
 * landing page" prompt into a 3-attempt crash loop.
 *
 * Heals (idempotent — safe to run on every write batch):
 *   1. package.json missing "type": "module"          → adds it
 *   2. vite pinned to <5 with @tailwindcss/vite v4    → bumps vite to ^6
 *   3. stray tailwind.config.{js,ts,cjs} for Tailwind v4 → deletes it
 *      (Tailwind v4 uses CSS @theme, not a JS config — keeping the
 *       file makes vite throw "Cannot find module 'tailwindcss/v4'")
 *   4. src/index.css missing @import "tailwindcss"     → prepends it
 *   5. vite hardcoded port 5000                       → swaps to 3001
 *
 * Returns a summary so the caller can broadcast "healed N issues" to
 * the chat panel.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { nexusLog } from "./logService.js";

const log = nexusLog("healer");

export interface HealReport {
  healed: number;
  fixes: string[];
}

async function readJson(p: string): Promise<any | null> {
  try { return JSON.parse(await fs.readFile(p, "utf-8")); } catch { return null; }
}

async function writeJson(p: string, data: any): Promise<void> {
  await fs.writeFile(p, JSON.stringify(data, null, 2));
}

function isVitePre5(version: string | undefined): boolean {
  if (!version) return false;
  const m = version.match(/(\d+)/);
  if (!m) return false;
  return parseInt(m[1], 10) < 5;
}

export async function healManifest(sandboxRoot: string): Promise<HealReport> {
  const fixes: string[] = [];

  // ── 1 & 2. package.json -------------------------------------------------
  const pkgPath = path.join(sandboxRoot, "package.json");
  const pkg = await readJson(pkgPath);
  if (pkg) {
    let dirty = false;

    if (pkg.type !== "module") {
      pkg.type = "module";
      dirty = true;
      fixes.push('package.json: added "type": "module" (required for ESM vite.config + @tailwindcss/vite)');
    }

    const usesTwVite = !!(pkg.devDependencies?.["@tailwindcss/vite"] || pkg.dependencies?.["@tailwindcss/vite"]);
    const viteVer = pkg.devDependencies?.vite || pkg.dependencies?.vite;
    if (usesTwVite && isVitePre5(viteVer)) {
      if (pkg.devDependencies?.vite) pkg.devDependencies.vite = "^6.2.0";
      if (pkg.dependencies?.vite) pkg.dependencies.vite = "^6.2.0";
      dirty = true;
      fixes.push(`package.json: bumped vite ${viteVer} → ^6.2.0 (@tailwindcss/vite v4 requires vite >=5)`);
    }

    // Make sure react & react-dom are present when @vitejs/plugin-react is.
    if ((pkg.devDependencies?.["@vitejs/plugin-react"] || pkg.dependencies?.["@vitejs/plugin-react"]) &&
        !pkg.dependencies?.react) {
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies.react = "^18.3.1";
      pkg.dependencies["react-dom"] = "^18.3.1";
      dirty = true;
      fixes.push("package.json: restored missing react/react-dom dependencies");
    }

    if (dirty) await writeJson(pkgPath, pkg);
  }

  // ── 3. stray tailwind.config.* for v4 ----------------------------------
  for (const ext of ["js", "ts", "cjs", "mjs"]) {
    const cfg = path.join(sandboxRoot, `tailwind.config.${ext}`);
    try {
      const content = await fs.readFile(cfg, "utf-8");
      // Tailwind v4 doesn't ship a config module — any import from it crashes.
      // The most common bad pattern is `import { defineConfig } from 'tailwindcss/v4'`.
      // Safest action: delete (Tailwind v4 reads @theme from CSS instead).
      if (/tailwindcss\/v4|tailwindcss\/v3|defineConfig/.test(content) || pkg?.devDependencies?.["@tailwindcss/vite"]) {
        await fs.unlink(cfg);
        fixes.push(`removed ${path.basename(cfg)} (Tailwind v4 uses CSS @theme — JS config is unused & breaks builds)`);
      }
    } catch { /* not present */ }
  }

  // ── 4. src/index.css must start with @import "tailwindcss" -----------
  const cssPath = path.join(sandboxRoot, "src", "index.css");
  try {
    const css = await fs.readFile(cssPath, "utf-8");
    // Strip illegal // comments first (Tailwind v4 plugin chokes on them)
    const stripped = css.replace(/^\s*\/\/[^\n]*\n/gm, "");
    if (!/^\s*@import\s+["']tailwindcss["']/m.test(stripped) &&
        pkg?.devDependencies?.["@tailwindcss/vite"]) {
      const fixed = `@import "tailwindcss";\n\n` + stripped;
      await fs.writeFile(cssPath, fixed);
      fixes.push('src/index.css: prepended @import "tailwindcss" (required by @tailwindcss/vite plugin)');
    } else if (stripped !== css) {
      await fs.writeFile(cssPath, stripped);
      fixes.push("src/index.css: stripped illegal // comments (Tailwind v4 plugin requires /* */ only)");
    }
  } catch { /* no css yet */ }

  // ── 5. vite.config: never hardcode port 5000 --------------------------
  const viteCfg = path.join(sandboxRoot, "vite.config.ts");
  try {
    const content = await fs.readFile(viteCfg, "utf-8");
    if (/\bport\s*:\s*5000\b/.test(content)) {
      const patched = content.replace(/\bport\s*:\s*5000\b/g, "port: Number(process.env.PORT) || 3001");
      await fs.writeFile(viteCfg, patched);
      fixes.push("vite.config.ts: replaced hardcoded port 5000 → process.env.PORT || 3001 (5000 is reserved by Nexus)");
    }
  } catch { /* none */ }

  if (fixes.length > 0) {
    log.info(`[healer] ✔ Healed ${fixes.length} manifest issue(s) in ${path.basename(sandboxRoot)}`);
  }

  return { healed: fixes.length, fixes };
}
