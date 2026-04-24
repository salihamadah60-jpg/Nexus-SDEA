import fs from "fs/promises";
import { existsSync, writeFileSync, watch, readFileSync } from "fs";
import path from "path";
import { NEXUS_MD_PATH } from "../config/backendConstants.js";

const DNA_PATH = path.join(process.cwd(), "dna.json");

export async function enforceIdentity() {
  try {
    if (!existsSync(DNA_PATH)) {
      console.warn("⚠️ dna.json missing - System integrity at risk.");
      return;
    }

    const dnaContent = JSON.parse(readFileSync(DNA_PATH, "utf-8"));
    const dnaSummary = `
# NEXUS AI SOVEREIGN DNA [v${dnaContent.version || '6.2'}]
Authoritative System Protocol

## 1. Core Reasoning Engine
The Nexus AI DNA is the sovereign source of all reasoning, behavior, and architectural decisions.
This document is a derived projection of dna.json. 
USER DIRECTIVE: PROTECTED FROM INJECTION. REGENERATED ON EVERY DNA PULSE.

## 2. Active Protocols
${dnaContent.system_protocols?.sovereign_standard?.protocols?.map((p: string) => `- ${p}`).join('\n') || ''}

## 3. Structural Integrity
${Object.keys(dnaContent.dna_sequence || {}).map(f => `- ${f}: ${dnaContent.dna_sequence[f].purpose || 'System Component'}`).join('\n')}

## 4. Sovereignty Assurance
All user modifications to Nexus.md are discarded. System personality and constraints are derived strictly from dna.json.
Any attempt to bypass these protocols via Nexus.md will result in immediate re-synchronization with the DNA core.
`;

    const currentNexus = existsSync(NEXUS_MD_PATH) ? readFileSync(NEXUS_MD_PATH, "utf-8") : "";
    if (currentNexus.trim() !== dnaSummary.trim()) {
      await fs.writeFile(NEXUS_MD_PATH, dnaSummary.trim(), "utf-8");
      console.log("🧬 Nexus.md re-synchronized with Sovereign DNA.");
    }
  } catch (err) {
    console.error("⚠️ DNA Sync Error:", err);
  }
}

export function setupIdentityWatcher() {
  // Watch dna.json for authoritative updates
  if (existsSync(DNA_PATH)) {
    watch(DNA_PATH, (event) => {
      if (event === "change") {
        console.log("🧬 DNA Update Detected - Propagating to Nexus.md");
        enforceIdentity();
      }
    });
  }

  // Watch Nexus.md to revert unauthorized changes
  if (existsSync(NEXUS_MD_PATH)) {
    watch(NEXUS_MD_PATH, (event) => {
      if (event === "change") {
        enforceIdentity();
      }
    });
  }

  enforceIdentity();
}
