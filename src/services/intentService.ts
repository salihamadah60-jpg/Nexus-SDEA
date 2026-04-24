/**
 * Nexus Intent Classifier — gates Nexus's verbosity by request type.
 *
 * Goal: a "Hello" should get a one-line greeting back, NOT a 5-step build plan.
 * A vague "make something cool" should trigger full plan/chain/build mode.
 *
 * Returns one of:
 *   - "smalltalk"   greetings, thanks, single-word acks
 *   - "question"    info/clarification — short, direct prose answer; no CHAIN/FILE markers
 *   - "build"       implementation request — full Sovereign protocol response
 *   - "command"     explicit operational command (run X, deploy, audit, rollback)
 */

export type Intent = "smalltalk" | "question" | "build" | "command";

const SMALLTALK = [
  /^\s*(hi|hello|hey|yo|sup|hola|salam|salaam|اهلا|مرحبا|مرحبًا|السلام عليكم)[\s!.,?]*$/i,
  /^\s*(thanks|thank you|thx|ty|شكرا|شكراً)[\s!.,?]*$/i,
  /^\s*(ok|okay|cool|nice|great|good|👍|👌|تمام|حسنا|حسناً)[\s!.,?]*$/i,
  /^\s*(bye|goodbye|cya|مع السلامة|وداعا)[\s!.,?]*$/i,
];

const COMMAND_VERBS = /^\s*(run|exec|execute|start|stop|kill|restart|deploy|publish|audit|rollback|checkpoint|install)\b/i;

const BUILD_TRIGGERS = [
  /\b(build|make|create|generate|implement|scaffold|design|develop|write|add|integrate|wire up|set up|setup)\b/i,
  /\b(app|application|page|component|api|endpoint|service|feature|dashboard|landing|tracker|game|tool|website|site)\b/i,
];

const QUESTION_MARKERS = [
  /^\s*(what|why|how|when|where|which|who|can you explain|tell me|do you know|is there|are there|does)\b/i,
  /\?\s*$/,
  /^\s*(ما|ماذا|لماذا|كيف|متى|أين|من|هل)\b/,
];

export function classifyIntent(message: string): Intent {
  const m = (message || "").trim();
  if (!m) return "smalltalk";
  if (m.length <= 24 && SMALLTALK.some(r => r.test(m))) return "smalltalk";

  // A short message that is purely a greeting + name is still smalltalk.
  if (m.length <= 40 && /^(hi|hello|hey|salam|اهلا|مرحبا)\b/i.test(m) && !/[?]/.test(m)) {
    return "smalltalk";
  }

  if (COMMAND_VERBS.test(m) && m.split(/\s+/).length <= 6) return "command";

  const buildHits = BUILD_TRIGGERS.filter(r => r.test(m)).length;
  if (buildHits >= 2) return "build";
  if (buildHits === 1 && m.length > 30) return "build";

  if (QUESTION_MARKERS.some(r => r.test(m))) return "question";

  // Default: short → question, long → build
  return m.length > 60 ? "build" : "question";
}

/** Recommended response shape per intent (for prompt steering). */
export function intentDirective(intent: Intent): string {
  switch (intent) {
    case "smalltalk":
      return [
        "INTENT: SMALLTALK.",
        "Reply in ONE short line, plain prose. No THOUGHT, CHAIN, FILE, TERMINAL, or SCREENSHOT markers.",
        "Match the user's language (Arabic ↔ Arabic, English ↔ English). Do not narrate steps.",
      ].join(" ");
    case "question":
      return [
        "INTENT: QUESTION.",
        "Answer directly in 1–4 sentences. No build markers. No CHAIN. No FILE writes.",
        "Only emit a short [NEXUS:THOUGHT] block if your reasoning is non-trivial; otherwise omit it.",
      ].join(" ");
    case "command":
      return [
        "INTENT: OPERATIONAL COMMAND.",
        "Acknowledge briefly, then emit the minimum markers needed (e.g. one [NEXUS:TERMINAL] block).",
        "Do not re-plan the entire project.",
      ].join(" ");
    case "build":
      return [
        "INTENT: BUILD.",
        "Use the full Sovereign protocol: [NEXUS:THOUGHT] → [NEXUS:CHAIN] → [NEXUS:FILE:…] → [NEXUS:TERMINAL] → [NEXUS:SCREENSHOT].",
        "Write COMPLETE production-grade file contents.",
      ].join(" ");
  }
}

/**
 * Sanitize Nexus's outgoing visible text:
 *   - drop characters from scripts the user didn't write in (Cyrillic, CJK, Hangul,
 *     Devanagari, Greek, Hebrew, Thai) when the user wrote in Arabic or Latin only.
 *   - collapse smart-quote noise.
 *
 * Markers and code inside [NEXUS:FILE:…] are NOT touched.
 */
export function sanitizeLanguage(reply: string, userMessage: string): string {
  const userScript = detectScripts(userMessage);
  const allowAr = userScript.has("ar");
  const allowLatin = userScript.has("latin") || !allowAr; // default to latin if unknown
  const FORBIDDEN = /[\u0400-\u04FF\u0500-\u052F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\u0900-\u097F\u0370-\u03FF\u0590-\u05FF\u0E00-\u0E7F]/g;

  // Split reply by NEXUS:FILE blocks; only sanitize outside of them.
  const parts = reply.split(/(\[NEXUS:FILE:[^\]]+\][\s\S]*?\[\/NEXUS:FILE\])/gi);
  return parts.map(part => {
    if (/^\[NEXUS:FILE:/i.test(part)) return part;
    let p = part.replace(FORBIDDEN, "");
    if (!allowAr) {
      // strip Arabic if user didn't write in Arabic
      p = p.replace(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g, "");
    }
    if (!allowLatin) {
      p = p.replace(/[A-Za-z]/g, "");
    }
    return p;
  }).join("");
}

function detectScripts(s: string): Set<string> {
  const out = new Set<string>();
  if (/[A-Za-z]/.test(s)) out.add("latin");
  if (/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(s)) out.add("ar");
  if (/[\u0400-\u04FF]/.test(s)) out.add("cyrillic");
  if (/[\u3040-\u30FF\u3400-\u9FFF]/.test(s)) out.add("cjk");
  return out;
}
