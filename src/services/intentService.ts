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

/**
 * Fix 13.P — Short build confirmations.
 *
 * When a user replies "yes", "ok", "go ahead", "continue", "add it", etc.
 * after Nexus has partially built something, the intent was always BUILD
 * (resume/extend the work).  The generic short-message fallback was
 * incorrectly classifying these as "question", causing Nexus to reply with
 * a single prose sentence instead of writing the remaining files.
 *
 * These tokens are matched BEFORE the QUESTION_MARKERS check so they take
 * priority and receive the full Sovereign BUILD directive.
 */
const BUILD_CONFIRMATIONS =
  /^\s*(yes|yeah|yep|yup|sure|ok|okay|go|go ahead|continue|proceed|confirm|do it|build it|implement it|add it|fix it|make it|keep going|finish it|do that|perfect|exactly|correct|right|absolutely|definitely|اكمل|نعم|تمام|صح|بالضبط)\s*[!.,]?\s*$/i;

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

  // Build confirmations take priority over the question check
  if (BUILD_CONFIRMATIONS.test(m)) return "build";

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
 *   - PRESERVE technical Latin tokens (file paths, identifiers, code-style words)
 *     even in pure-Arabic replies, because those are language-neutral.
 *
 * Markers and code inside [NEXUS:FILE:…] are NOT touched.
 */
export function sanitizeLanguage(reply: string, userMessage: string): string {
  const userScript = detectScripts(userMessage);
  const allowAr = userScript.has("ar");
  const allowLatin = userScript.has("latin"); // pure Arabic user → Latin is non-conversational

  // Always-forbidden scripts (the user can never have meant these regardless of input language).
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
    if (allowAr && !allowLatin) {
      // Pure-Arabic user — strip Latin words but PRESERVE technical tokens
      // (file paths, code identifiers, urls, version numbers, brand words).
      // A "technical token" = run of [A-Za-z0-9._/-]+ that contains at least
      // one of: '/', '.', '_', '-', or is ALL-CAPS (acronym), or starts with
      // a digit, or matches a known tech keyword. Everything else is prose
      // English and gets stripped.
      const TECH_KEYWORDS = /^(react|vite|tailwind|nexus|api|css|html|js|ts|tsx|jsx|json|node|npm|http|https|url|ui|ux|ai|app|repl|github|google|gemini|gpt|llm|sse|json|xml|sql|db)$/i;
      p = p.replace(/[A-Za-z][A-Za-z0-9._/\-]*/g, (tok) => {
        if (/[._/\-]/.test(tok)) return tok;             // path-like
        if (/^[A-Z]{2,}$/.test(tok)) return tok;         // acronym
        if (/^[A-Z][a-z]+[A-Z]/.test(tok)) return tok;   // CamelCase identifier
        if (TECH_KEYWORDS.test(tok)) return tok;         // tech keyword
        return "";                                        // plain English word — drop
      });
      // Collapse the orphan spaces left behind.
      p = p.replace(/[ \t]{2,}/g, " ").replace(/\s+([،.!؟?])/g, "$1");
    }
    return p;
  }).join("");
}

/** Detect the dominant conversational language of the user's input. */
export function detectUserLanguage(s: string): "ar" | "en" {
  const arChars = (s.match(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const latChars = (s.match(/[A-Za-z]/g) || []).length;
  // If Arabic outnumbers Latin (or no Latin at all), reply in Arabic.
  if (arChars > 0 && arChars >= latChars) return "ar";
  return "en";
}

/**
 * Build a strong "respond in this language" directive that gets appended
 * to every system prompt. This is what closes the door on accidental
 * English replies when the user writes Arabic, and prevents stray Arabic
 * characters appearing in pure-English answers.
 */
export function languageDirective(userMessage: string): string {
  const lang = detectUserLanguage(userMessage);
  if (lang === "ar") {
    return [
      "━━━ LANGUAGE PROTOCOL ━━━",
      "The user wrote in ARABIC. You MUST reply in fluent, natural Arabic.",
      "• Visible text outside markers: Arabic only.",
      "• Allowed exceptions inside Arabic prose: file paths (src/App.tsx),",
      "  code identifiers, framework names (React, Vite, Tailwind), URLs,",
      "  version numbers, acronyms (API, CSS, HTML).",
      "• NEVER write entire English sentences inside an Arabic reply.",
      "• NEVER mix Cyrillic/CJK/Hangul/Hebrew characters into the response.",
      "• Punctuation: prefer Arabic punctuation (، ؛ ؟) where natural.",
      "• Code, file contents, and marker payloads stay in their native language",
      "  (TypeScript stays English, etc).",
    ].join("\n");
  }
  return [
    "━━━ LANGUAGE PROTOCOL ━━━",
    "The user wrote in ENGLISH. Reply in clear, natural English.",
    "• Visible text outside markers: English only.",
    "• NEVER inject Arabic, Cyrillic, CJK, Hangul, Hebrew, Devanagari, Greek,",
    "  or Thai characters into the response — those are filtered out and",
    "  produce abnormal-looking output.",
  ].join("\n");
}

function detectScripts(s: string): Set<string> {
  const out = new Set<string>();
  if (/[A-Za-z]/.test(s)) out.add("latin");
  if (/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(s)) out.add("ar");
  if (/[\u0400-\u04FF]/.test(s)) out.add("cyrillic");
  if (/[\u3040-\u30FF\u3400-\u9FFF]/.test(s)) out.add("cjk");
  return out;
}
