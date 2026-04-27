/**
 * Quality Verdict Reviewer (Phase 13.2)
 * ─────────────────────────────────────────────────────────────
 * Static-analysis grader that scores a batch of AI-generated files
 * against the 10-point Quality Bar in the system prompt. No extra
 * LLM call — pure regex + structural checks. Runs on every write
 * batch; scores below the revision threshold trigger an automatic
 * AI revision pass via requestQualityRevision().
 *
 * The reviewer's job is to make the AI honest: if it ships a
 * 17-line generic Hero with "Streamline Your Workflow" copy, the
 * verdict catches it before the user does.
 */

import { requestAuditFix } from "./orchestratorService.js";

export interface QualityCheck {
  id: string;
  label: string;
  passed: boolean;
  weight: number;
  detail?: string;
}

export interface QualityVerdict {
  score: number;             // 0–100
  passed: boolean;           // score >= REVISION_THRESHOLD
  checks: QualityCheck[];
  fails: QualityCheck[];     // convenience: only the failed checks
  summary: string;           // human-readable one-liner
  feedback: string;          // structured feedback to send back to the AI
}

const REVISION_THRESHOLD = 70;

const FORBIDDEN_PHRASES = [
  "streamline your workflow",
  "lorem ipsum",
  "welcome to my app",
  "welcome to my website",
  "click here to get started",
  "your awesome product",
  "your tagline here",
  "feature one",
  "feature two",
  "feature three",
];

function isUiFile(p: string): boolean {
  return /\.(tsx|jsx)$/i.test(p);
}

function isCssFile(p: string): boolean {
  return /\.(css|scss)$/i.test(p);
}

function looksLikeLandingApp(files: Array<{ path: string; content: string }>): boolean {
  // We grade as a landing page when the user is shipping a multi-section UI.
  const ui = files.filter(f => isUiFile(f.path));
  if (ui.length < 2) return false;
  const blob = ui.map(f => f.content).join("\n").toLowerCase();
  return /hero|landing|features?|pricing|testimonial|footer|nav(bar)?/.test(blob);
}

/**
 * Grade a batch of files. Pure static analysis — no LLM call.
 */
export function gradeFiles(
  files: Array<{ path: string; content: string }>,
  userGoal: string = ""
): QualityVerdict {
  const checks: QualityCheck[] = [];
  const ui = files.filter(f => isUiFile(f.path));
  const css = files.filter(f => isCssFile(f.path));
  const allUiBlob = ui.map(f => f.content).join("\n");
  const allCssBlob = css.map(f => f.content).join("\n");
  const isLanding = looksLikeLandingApp(files);

  // ── 1. No forbidden placeholder copy ─────────────────────
  const lowerBlob = allUiBlob.toLowerCase();
  const hits = FORBIDDEN_PHRASES.filter(p => lowerBlob.includes(p));
  checks.push({
    id: "no_placeholder_copy",
    label: "No generic placeholder copy",
    weight: 15,
    passed: hits.length === 0,
    detail: hits.length ? `Found banned phrases: ${hits.slice(0, 3).join(", ")}` : undefined,
  });

  // ── 2. Specific, believable copy (numbers / stats present) ──
  const numericClaims = (allUiBlob.match(/\b\d{1,3}(?:[.,]\d+)?\s*(?:%|x|k|m|ms|s|min|hours?|days?|users?|customers?|teams?|companies)\b/gi) || []).length;
  checks.push({
    id: "specific_copy",
    label: "Concrete numbers / stats in copy",
    weight: 8,
    passed: !isLanding || numericClaims >= 3,
    detail: `${numericClaims} numeric claim(s) found (need ≥3 for a landing page)`,
  });

  // ── 3. Tailwind v4 @theme block ──────────────────────────
  const hasTheme = /@theme\s*\{[^}]*--color-/.test(allCssBlob) || /@theme\s+inline/.test(allCssBlob);
  checks.push({
    id: "design_system_theme",
    label: "Brand colors defined in CSS @theme",
    weight: 10,
    passed: !isLanding || hasTheme,
    detail: hasTheme ? undefined : "No @theme { --color-* } block in CSS — define brand palette in src/index.css",
  });

  // ── 4. Section count ─────────────────────────────────────
  const sectionTags = (allUiBlob.match(/<section\b/gi) || []).length;
  const componentImports = (allUiBlob.match(/^import\s+\w+\s+from\s+['"][^'"]*\/components\//gm) || []).length;
  const sectionCount = Math.max(sectionTags, componentImports);
  checks.push({
    id: "rich_sections",
    label: "Rich page composition (≥6 sections for landing)",
    weight: 12,
    passed: !isLanding || sectionCount >= 6,
    detail: `${sectionCount} section(s) detected (need ≥6 for landing pages)`,
  });

  // ── 5. Motion (framer-motion) ────────────────────────────
  const usesMotion = /from\s+['"]framer-motion['"]/.test(allUiBlob);
  const motionUses = (allUiBlob.match(/<motion\.\w+/g) || []).length;
  checks.push({
    id: "motion",
    label: "Framer Motion entrance + scroll animations",
    weight: 10,
    passed: !isLanding || (usesMotion && motionUses >= 3),
    detail: usesMotion ? `${motionUses} <motion.*> element(s)` : "framer-motion not imported",
  });

  // ── 6. Iconography (lucide-react) ────────────────────────
  const usesLucide = /from\s+['"]lucide-react['"]/.test(allUiBlob);
  const lucideImports = (allUiBlob.match(/from\s+['"]lucide-react['"]/g) || []).length;
  checks.push({
    id: "icons",
    label: "Lucide icons throughout UI",
    weight: 8,
    passed: !isLanding || (usesLucide && lucideImports >= 2),
    detail: usesLucide ? `${lucideImports} file(s) import lucide-react` : "lucide-react not imported",
  });

  // ── 7. Visual depth (gradients / shadows / blur) ─────────
  const depthSignals =
    (allUiBlob.match(/bg-gradient-to-|from-\w+-\d+|to-\w+-\d+/g) || []).length +
    (allUiBlob.match(/shadow-(?:lg|xl|2xl)/g) || []).length +
    (allUiBlob.match(/backdrop-blur|ring-\d|ring-black\/|ring-white\//g) || []).length;
  checks.push({
    id: "visual_depth",
    label: "Visual depth (gradients, shadows, glass)",
    weight: 8,
    passed: !isLanding || depthSignals >= 6,
    detail: `${depthSignals} depth signal(s) — need ≥6 (gradient/shadow-xl/backdrop-blur/ring)`,
  });

  // ── 8. Responsive breakpoints ────────────────────────────
  const responsiveHits = (allUiBlob.match(/\b(?:sm|md|lg|xl|2xl):/g) || []).length;
  checks.push({
    id: "responsive",
    label: "Responsive breakpoints used",
    weight: 8,
    passed: !isLanding || responsiveHits >= 10,
    detail: `${responsiveHits} responsive class(es) — need ≥10`,
  });

  // ── 9. Semantic HTML ─────────────────────────────────────
  const semantic = /<(header|nav|main|footer|article|aside)\b/i.test(allUiBlob);
  checks.push({
    id: "semantic_html",
    label: "Semantic HTML (header/nav/main/footer)",
    weight: 6,
    passed: !isLanding || semantic,
    detail: semantic ? undefined : "Use <header>, <nav>, <main>, <footer> instead of all <div>",
  });

  // ── 10. Interactivity (state / handlers) ─────────────────
  const interactive =
    /useState\s*\(/.test(allUiBlob) ||
    /onClick=\{|onChange=\{|onSubmit=\{/.test(allUiBlob);
  checks.push({
    id: "interactivity",
    label: "Working interactivity (state or handlers)",
    weight: 5,
    passed: !isLanding || interactive,
    detail: interactive ? undefined : "Add at least one interactive element (mobile menu, FAQ, pricing toggle)",
  });

  // ── 11. Component sizes (anti-stub check) ────────────────
  const tinyUiFiles = ui.filter(f => {
    const lines = f.content.split("\n").length;
    const isTrivial = /\b(main|index|app)\.(t|j)sx$/i.test(f.path);
    return !isTrivial && lines < 40;
  });
  checks.push({
    id: "component_substance",
    label: "No stub-sized components (<40 lines)",
    weight: 10,
    passed: tinyUiFiles.length === 0,
    detail: tinyUiFiles.length
      ? `Stub-sized: ${tinyUiFiles.map(f => f.path.split("/").pop() + ` (${f.content.split("\n").length}L)`).slice(0, 3).join(", ")}`
      : undefined,
  });

  // ── Compute weighted score ───────────────────────────────
  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce((s, c) => s + (c.passed ? c.weight : 0), 0);
  const score = Math.round((earned / totalWeight) * 100);
  const fails = checks.filter(c => !c.passed);

  const summary = fails.length === 0
    ? `Quality Verdict: ${score}/100 — all checks passed.`
    : `Quality Verdict: ${score}/100 — ${fails.length} check(s) failed.`;

  const feedback = fails.length === 0
    ? ""
    : "QUALITY VERDICT FAILED — REVISE THE FOLLOWING:\n" +
      fails.map((c, i) => `  ${i + 1}. [${c.label}] ${c.detail || "Failed"}`).join("\n") +
      `\n\nThis is a hard contract. Re-emit the affected files with the fixes applied. Do NOT ship boilerplate.`;

  return {
    score,
    passed: score >= REVISION_THRESHOLD,
    checks,
    fails,
    summary,
    feedback,
  };
}

/**
 * If the verdict failed, ask the writer model to revise the failing files.
 * Returns the merged files (revised entries replace originals).
 */
export async function requestQualityRevision(
  files: Array<{ path: string; content: string }>,
  verdict: QualityVerdict,
  userGoal: string,
  taskId?: string,
  sessionId?: string
): Promise<Array<{ path: string; content: string }>> {
  if (verdict.passed) return files;

  // requestAuditFix expects string[] issues
  const issues = verdict.fails.map(c => `${c.label}: ${c.detail || "Failed"}`);

  try {
    const revised = await requestAuditFix(
      files,
      issues,
      `${userGoal}\n\n${verdict.feedback}`,
      sessionId,
      taskId
    );

    if (!revised || revised.length === 0) return files;

    // Merge: revised entries override originals by path
    const byPath = new Map(files.map(f => [f.path, f]));
    for (const r of revised) byPath.set(r.path, r);
    return Array.from(byPath.values());
  } catch {
    return files;
  }
}
