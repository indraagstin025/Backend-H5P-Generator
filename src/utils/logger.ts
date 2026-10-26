/**
 * Logger kecil tanpa dependensi: timestamp + level + scope.
 * Atur verbositas lewat LOG_LEVEL=debug|info|warn|error|silent.
 */
type Level = "debug" | "info" | "warn" | "error" | "silent";

const PRIORITY: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return PRIORITY[raw] ?? PRIORITY.info;
}

function write(level: Exclude<Level, "silent">, scope: string, message: string, meta?: unknown): void {
  if (PRIORITY[level] < threshold()) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const sink =
    level === "debug" ? console.debug : level === "info" ? console.info : level === "warn" ? console.warn : console.error;
  if (meta === undefined) sink(line);
  else sink(line, meta);
}

export interface Logger {
  debug: (message: string, meta?: unknown) => void;
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => write("debug", scope, message, meta),
    info: (message, meta) => write("info", scope, message, meta),
    warn: (message, meta) => write("warn", scope, message, meta),
    error: (message, meta) => write("error", scope, message, meta),
  };
}
