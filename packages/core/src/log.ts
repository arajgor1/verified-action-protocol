import { redact, redactString } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
  base?: Record<string, unknown>;
  /** Called when redaction altered a log record; feeds the redaction metric. */
  onRedaction?: () => void;
}

/**
 * Structured JSON logger. Every record is redacted before serialization; request bodies
 * and credentials are never logged by the runtime, and this is the backstop.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = ORDER[opts.level ?? ((process.env.VAP_LOG_LEVEL as LogLevel | undefined) ?? "info")] ?? ORDER.info;
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const base = opts.base ?? {};
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const record = { severity: level.toUpperCase(), time: new Date().toISOString(), message: redactString(msg, 1024), ...base, ...(fields ?? {}) };
    const safe = redact(record, { maxDepth: 6, maxStringLength: 4096 });
    sink(JSON.stringify(safe));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
