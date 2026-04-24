/**
 * Nexus Uniform Diagnostic Logger.
 * Format: [NEXUS][component] LEVEL message
 * Levels: debug | info | warn | error | fatal
 * Honors NEXUS_LOG_LEVEL env var (default: info).
 */
const LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
type Level = typeof LEVELS[number];

const ENV_LEVEL = (process.env.NEXUS_LOG_LEVEL || "info").toLowerCase() as Level;
const minIdx = Math.max(0, LEVELS.indexOf(ENV_LEVEL));

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[1;31m",
};
const RESET = "\x1b[0m";

function emit(level: Level, component: string, msg: string, meta?: any) {
  if (LEVELS.indexOf(level) < minIdx) return;
  const c = COLORS[level];
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${c}[NEXUS][${component}] ${level.toUpperCase()}${RESET} ${ts} ${msg}`;
  if (level === "error" || level === "fatal") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  if (meta) {
    try { console.log("  └─", typeof meta === "string" ? meta : JSON.stringify(meta).slice(0, 600)); } catch {}
  }
}

export function nexusLog(component: string) {
  return {
    debug: (m: string, meta?: any) => emit("debug", component, m, meta),
    info: (m: string, meta?: any) => emit("info", component, m, meta),
    warn: (m: string, meta?: any) => emit("warn", component, m, meta),
    error: (m: string, meta?: any) => emit("error", component, m, meta),
    fatal: (m: string, meta?: any) => emit("fatal", component, m, meta),
  };
}

export type NexusLogger = ReturnType<typeof nexusLog>;
