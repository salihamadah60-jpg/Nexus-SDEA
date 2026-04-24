# Nexus AI Core: Kernel Protocol v2.0

This document outlines the hardcoded logic and architectural constraints of the Nexus AI system. 

## 1. Zero-Code & Mini-Action Policy
- **ZERO-CODE:** AI is strictly FORBIDDEN from outputting code in the main chat.
- **MINI-ACTIONS:** System commands must be embedded as ```terminal units INSIDE `<thought>` blocks. No direct terminal blocks in main chat.

## 2. Neural Blueprint (Structural Memory)
- **BLUEPRINT:** Maintain `.nexus_blueprint.json` in project root.
- **MAPPING:** Track directory trees, file purposes, function mappings, and successful shell patterns.
- **EFFICIENCY:** References the blueprint to target specific files/lines, saving API credits and reducing fix latency.

## 3. UI: Collapsible Neural Logic
- **DEFAULTS:** Thinking Process (Thought blocks) are collapsed by default.
- **SUMMARIES:** Show logic headers; expand only on user intent.

## 4. Clean Start (Neural Purity)
- **HOME PAGE:** Every refresh initializes a 'Clean Session' with center-aligned input.
- **NO AUTO-LOAD:** Previous memory is only recalled via Sidebar interaction.

## 5. Model Priority Loop
1. **GPT-4o (GitHub/GITHUB_GPT):** Structural Reasoning.
2. **Gemini (NEXUS_AI_KEY):** Fast Iteration.
3. **Groq/HF:** Neural Inference.

---
*Nexus AI v2.0 • Tier-1 Senior Architect*
