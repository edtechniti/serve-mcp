/**
 * Minimal structured logger.
 *
 * MCP's stdio transport owns stdout, so every log line goes to stderr.
 * Registered secrets are scrubbed from every message before it is written.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = "[REDACTED]";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Values that must never appear in output (e.g. API keys). */
  secrets?: readonly string[];
  /** Sink for formatted lines. Defaults to stderr. */
  write?: (line: string) => void;
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join(REDACTED);
  }
  return out;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level];
  const secrets = options.secrets ?? [];
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));

  const log = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    const entry = { time: new Date().toISOString(), level, message, ...fields };
    write(redact(JSON.stringify(entry), secrets));
  };

  return {
    debug: (m, f) => {
      log("debug", m, f);
    },
    info: (m, f) => {
      log("info", m, f);
    },
    warn: (m, f) => {
      log("warn", m, f);
    },
    error: (m, f) => {
      log("error", m, f);
    },
  };
}

/** A logger that discards everything; handy in tests. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
