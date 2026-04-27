/**
 * Visual Auditor (Phase 13.3)
 * ────────────────────────────────────────────────────────────────
 * After the dev server boots and a screenshot is captured, this
 * service feeds the rendered PNG to Gemini 2.0 Flash (multimodal)
 * and asks for a structured visual review. This catches things
 * static analysis can't see:
 *   • ugly color clashes / unreadable contrast
 *   • broken or overlapping layouts
 *   • empty states / blank-page bugs that compile cleanly
 *   • generic stock-template look ("Bootstrap 2014 vibes")
 *   • missing imagery, broken icons
 *
 * Result: a VisualVerdict { score, summary, wins[], issues[],
 * recommendations[] } broadcast to the SSE journal and persisted
 * to history. Runs asynchronously so it never blocks the preview
 * from going READY.
 */

import fs from "fs/promises";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { keyPool } from "./keyPoolService.js";
import { requestAuditFix } from "./orchestratorService.js";

export interface VisualIssue {
  severity: "high" | "medium" | "low";
  category: "layout" | "typography" | "color" | "imagery" | "copy" | "polish" | "accessibility";
  message: string;
}

export interface VisualVerdict {
  score: number;                     // 0–100
  summary: string;                   // one-sentence verdict
  wins: string[];                    // what works
  issues: VisualIssue[];             // what doesn't
  recommendations: string[];         // concrete next steps
  passed: boolean;                   // score >= 70
  raw?: string;                      // raw model output for debugging
  modelUsed?: string;
}

const VISUAL_SYSTEM = `You are a SENIOR PRODUCT DESIGNER reviewing the screenshot of a freshly generated web app.
You judge what a paying customer would see. You are honest, specific, and ruthless about generic output.

Score the rendered page 0–100 against this rubric (be strict — most freshly generated UIs deserve 50–65):
  • Visual hierarchy & composition (does the eye know where to land?)
  • Typography quality (sizing, weight contrast, line-height, no walls of text)
  • Color system (deliberate palette? adequate contrast? tasteful gradients vs garish?)
  • Spacing & alignment (consistent rhythm? cramped? lazy centering?)
  • Density of real content (is there substance or is it 3 floating divs?)
  • Imagery / iconography (real icons present? hero visual or empty void?)
  • Polish (shadows, borders, micro-details — does it look launched or sketched?)
  • Brand cohesion (does it feel like one product or 6 random sections glued together?)
  • Empty / broken states (white page? unstyled fallbacks? overlapping text?)
  • "Tweet-worthy" factor (would a designer screenshot it without embarrassment?)

Return STRICT JSON ONLY — no markdown fences, no prose:
{
  "score": <0-100>,
  "summary": "<one sentence verdict>",
  "wins": ["<concrete thing that works>", ...],
  "issues": [
    {"severity": "high|medium|low", "category": "layout|typography|color|imagery|copy|polish|accessibility", "message": "<specific observation>"}
  ],
  "recommendations": ["<concrete actionable next step>", ...]
}

Hard rules:
- A blank/white page is automatic ≤ 20.
- "Welcome to my app" / Lorem ipsum / placeholder text is automatic ≤ 35.
- A flat single-color section with one heading and two buttons is ≤ 50.
- A genuinely beautiful, dense, multi-section landing with visible motion cues, real icons, and brand cohesion can earn 80–95.
- Reserve 95+ for output you would actually pin to your portfolio.
- Output ONLY the JSON object. No prose before or after.`;

function safeParseJson(s: string): any | null {
  // Strip code fences, find first { ... }
  const cleaned = s.replace(/```json\s*|\s*```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Send a screenshot to Gemini's vision model and return a structured verdict.
 * Returns null if no Gemini key is available or the call fails.
 */
export async function auditScreenshot(
  imagePath: string,
  userGoal: string = "",
  taskId?: string,
  sessionId?: string
): Promise<VisualVerdict | null> {
  let imgBytes: Buffer;
  try {
    imgBytes = await fs.readFile(imagePath);
  } catch {
    return null;
  }
  if (imgBytes.length === 0 || imgBytes.length > 8 * 1024 * 1024) {
    return null; // skip empty or oversized screenshots
  }
  const base64 = imgBytes.toString("base64");
  const mimeType = imagePath.toLowerCase().endsWith(".jpg") || imagePath.toLowerCase().endsWith(".jpeg")
    ? "image/jpeg"
    : "image/png";

  const promptText = `USER GOAL: ${userGoal.slice(0, 300) || "(unspecified)"}

Review the screenshot. Score it 0–100 against the rubric. Return JSON only.`;

  const tried = new Set<string>();
  const modelName = "gemini-2.0-flash";

  for (let attempt = 0; attempt < 3; attempt++) {
    const k = keyPool.next("gemini");
    if (!k || tried.has(k.id)) break;
    tried.add(k.id);

    try {
      const client = new GoogleGenAI({ apiKey: k.value });
      const r: any = await (client as any).models.generateContent({
        model: modelName,
        contents: [{
          role: "user",
          parts: [
            { text: promptText },
            { inlineData: { mimeType, data: base64 } },
          ],
        }],
        config: {
          systemInstruction: VISUAL_SYSTEM,
          maxOutputTokens: 1500,
          temperature: 0.3,
          responseMimeType: "application/json",
        },
      });

      const text = r?.text || r?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      keyPool.recordSuccess(k, promptText.length / 4, text.length / 4);

      const parsed = safeParseJson(text);
      if (!parsed || typeof parsed.score !== "number") continue;

      const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
      const verdict: VisualVerdict = {
        score,
        summary: String(parsed.summary || "").slice(0, 300),
        wins: Array.isArray(parsed.wins) ? parsed.wins.slice(0, 8).map(String) : [],
        issues: Array.isArray(parsed.issues)
          ? parsed.issues.slice(0, 12).map((i: any): VisualIssue => ({
              severity: ["high", "medium", "low"].includes(i?.severity) ? i.severity : "medium",
              category: ["layout", "typography", "color", "imagery", "copy", "polish", "accessibility"].includes(i?.category) ? i.category : "polish",
              message: String(i?.message || "").slice(0, 240),
            }))
          : [],
        recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 8).map(String) : [],
        passed: score >= 70,
        modelUsed: modelName,
      };
      return verdict;
    } catch (e: any) {
      keyPool.recordFailure(k, String(e?.status || "unknown"), e);
      console.warn(`[VISUAL AUDITOR] gemini key ${k.id} failed: ${String(e?.message || "").slice(0, 120)}`);
    }
  }

  return null;
}

/**
 * Format a verdict for the SSE journal — one line summary plus the top
 * 3 high-severity issues and top 2 recommendations.
 */
export function formatVerdictForJournal(v: VisualVerdict): string {
  const lines: string[] = [
    `[VISUAL AUDITOR] Score: ${v.score}/100 — ${v.summary}`,
  ];
  if (v.wins.length) {
    lines.push(`  ✓ Wins: ${v.wins.slice(0, 3).join(" • ")}`);
  }
  const highIssues = v.issues.filter(i => i.severity === "high").slice(0, 3);
  if (highIssues.length) {
    lines.push(`  ✗ Top issues: ${highIssues.map(i => `[${i.category}] ${i.message}`).join(" • ")}`);
  }
  if (v.recommendations.length) {
    lines.push(`  → Next: ${v.recommendations.slice(0, 2).join(" • ")}`);
  }
  return lines.join("\n");
}

/**
 * Read the candidate UI files in a sandbox that are worth feeding to a visual revision pass.
 * Limits to src/App.{tsx,jsx}, src/components/*.{tsx,jsx}, and src/index.css.
 * Skips any file > 12 KB to keep prompt size manageable.
 */
export async function readSandboxUiFiles(
  projectDir: string,
  maxFiles = 8
): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  const candidates: string[] = [];

  // Top-level App + index.css
  for (const rel of ["src/App.tsx", "src/App.jsx", "src/index.css"]) {
    candidates.push(rel);
  }

  // src/components/*.{tsx,jsx}
  try {
    const compDir = path.join(projectDir, "src", "components");
    const entries = await fs.readdir(compDir);
    for (const e of entries) {
      if (/\.(t|j)sx$/.test(e)) candidates.push(`src/components/${e}`);
    }
  } catch {}

  for (const rel of candidates) {
    if (out.length >= maxFiles) break;
    try {
      const abs = path.join(projectDir, rel);
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > 12 * 1024) continue;
      const content = await fs.readFile(abs, "utf-8");
      out.push({ path: rel, content });
    } catch {}
  }
  return out;
}

/**
 * When the visual verdict scores below threshold, ask the writer model to
 * regenerate the failing UI files using the verdict as the brief. Returns
 * the merged file array (revised entries override originals by path), or
 * null when no key is available / the call fails.
 */
export async function requestVisualRevision(
  files: Array<{ path: string; content: string }>,
  verdict: VisualVerdict,
  userGoal: string,
  taskId?: string,
  sessionId?: string
): Promise<Array<{ path: string; content: string }> | null> {
  if (verdict.passed || files.length === 0) return null;

  // Convert the visual verdict into the issues[] shape that requestAuditFix expects.
  const issueLines: string[] = [];
  issueLines.push(`VISUAL SCORE: ${verdict.score}/100 — ${verdict.summary}`);
  for (const i of verdict.issues) {
    issueLines.push(`[${i.severity.toUpperCase()} • ${i.category}] ${i.message}`);
  }
  for (const r of verdict.recommendations) {
    issueLines.push(`RECOMMEND: ${r}`);
  }
  issueLines.push(
    "Re-emit the affected UI files with these design problems FIXED.",
    "Keep file paths and component exports identical so the import graph stays intact.",
    "Apply the QUALITY BAR: ≥6 sections for landings, real @theme palette in index.css,",
    "framer-motion entrance + scroll animations, lucide icons throughout, ≥6 visual-depth",
    "signals (gradients, shadow-xl, backdrop-blur, ring-*), ≥10 responsive classes,",
    "semantic HTML, real interactivity, and components ≥40 lines.",
    "DO NOT regress to placeholder copy or 17-line stubs — the visual reviewer will see it."
  );

  try {
    const revised = await requestAuditFix(
      files,
      issueLines,
      `${userGoal}\n\nThis is a visual-quality revision pass. Address every issue above.`,
      sessionId,
      taskId
    );
    if (!revised || revised.length === 0) return null;
    return revised;
  } catch {
    return null;
  }
}

