import { z } from "zod";

import type { LogLevel } from "./logger.js";

export const SERVE_ENVIRONMENTS = ["mock", "sandbox", "production"] as const;
export type ServeEnvironment = (typeof SERVE_ENVIRONMENTS)[number];

const DEFAULT_BASE_URLS: Record<ServeEnvironment, string> = {
  mock: "http://127.0.0.1:4010",
  sandbox: "https://api.sandbox.serverobotics.com",
  production: "https://api.prod.serverobotics.com",
};

const MOCK_PARTNER_ID = "ptnr_mock";

export interface Config {
  readonly environment: ServeEnvironment;
  readonly baseUrl: string;
  readonly partnerId: string;
  readonly apiKey: string | undefined;
  /** Hard ceiling on any single delivery fee, in cents. */
  readonly maxFeeCents: number;
  readonly requestTimeoutMs: number;
  readonly geocoder: "nominatim" | "none";
  readonly geocoderUserAgent: string;
  readonly logLevel: LogLevel;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const booleanFlag = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : v));

const EnvSchema = z.object({
  SERVE_ENV: z.enum(SERVE_ENVIRONMENTS).default("mock"),
  SERVE_BASE_URL: optionalString.pipe(z.url().optional()),
  SERVE_PARTNER_ID: optionalString,
  SERVE_API_KEY: optionalString,
  SERVE_ALLOW_PRODUCTION: booleanFlag,
  SERVE_MAX_FEE_CENTS: z.coerce.number().int().positive().max(100_000).default(1500),
  SERVE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  GEOCODER: z.enum(["nominatim", "none"]).default("nominatim"),
  GEOCODER_USER_AGENT: optionalString,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

/**
 * Parse and validate configuration from environment variables.
 * Fails fast with a readable message; never echoes secret values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  const environment = e.SERVE_ENV;

  if (environment === "production" && !e.SERVE_ALLOW_PRODUCTION) {
    throw new ConfigError(
      "SERVE_ENV=production dispatches real robots and incurs real fees. " +
        "Set SERVE_ALLOW_PRODUCTION=true to confirm.",
    );
  }

  if (environment !== "mock") {
    if (!e.SERVE_PARTNER_ID)
      throw new ConfigError(`SERVE_PARTNER_ID is required for ${environment}.`);
    if (!e.SERVE_API_KEY) throw new ConfigError(`SERVE_API_KEY is required for ${environment}.`);
  }

  const baseUrl = (e.SERVE_BASE_URL ?? DEFAULT_BASE_URLS[environment]).replace(/\/+$/, "");
  if (environment !== "mock" && !baseUrl.startsWith("https://")) {
    throw new ConfigError("SERVE_BASE_URL must use https outside mock mode.");
  }

  return {
    environment,
    baseUrl,
    partnerId: e.SERVE_PARTNER_ID ?? MOCK_PARTNER_ID,
    apiKey: e.SERVE_API_KEY,
    maxFeeCents: e.SERVE_MAX_FEE_CENTS,
    requestTimeoutMs: e.SERVE_REQUEST_TIMEOUT_MS,
    geocoder: e.GEOCODER,
    geocoderUserAgent: e.GEOCODER_USER_AGENT ?? "serve-delivery-mcp (open-source MCP server)",
    logLevel: e.LOG_LEVEL,
  };
}

/** True when simulation-only tools may be exposed. */
export function isSimulated(environment: ServeEnvironment): boolean {
  return environment !== "production";
}
