import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to mock mode with no credentials", () => {
    const config = loadConfig({});
    expect(config.environment).toBe("mock");
    expect(config.baseUrl).toBe("http://127.0.0.1:4010");
    expect(config.partnerId).toBe("ptnr_mock");
    expect(config.apiKey).toBeUndefined();
    expect(config.maxFeeCents).toBe(1500);
  });

  it("requires credentials for sandbox", () => {
    expect(() => loadConfig({ SERVE_ENV: "sandbox" })).toThrow(/SERVE_PARTNER_ID/);
    expect(() => loadConfig({ SERVE_ENV: "sandbox", SERVE_PARTNER_ID: "ptnr_x" })).toThrow(
      /SERVE_API_KEY/,
    );
    const config = loadConfig({
      SERVE_ENV: "sandbox",
      SERVE_PARTNER_ID: "ptnr_x",
      SERVE_API_KEY: "k",
    });
    expect(config.baseUrl).toBe("https://api.sandbox.serverobotics.com");
  });

  it("requires an explicit opt-in for production", () => {
    const env = { SERVE_ENV: "production", SERVE_PARTNER_ID: "ptnr_x", SERVE_API_KEY: "k" };
    expect(() => loadConfig(env)).toThrow(/SERVE_ALLOW_PRODUCTION/);
    expect(loadConfig({ ...env, SERVE_ALLOW_PRODUCTION: "true" }).baseUrl).toBe(
      "https://api.prod.serverobotics.com",
    );
  });

  it("rejects plain http outside mock mode", () => {
    expect(() =>
      loadConfig({
        SERVE_ENV: "sandbox",
        SERVE_PARTNER_ID: "p",
        SERVE_API_KEY: "k",
        SERVE_BASE_URL: "http://example.com",
      }),
    ).toThrow(/https/);
  });

  it("rejects invalid values without echoing secrets", () => {
    try {
      loadConfig({ SERVE_MAX_FEE_CENTS: "-5", SERVE_API_KEY: "super-secret" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).toMatch(/SERVE_MAX_FEE_CENTS/);
      expect(String(error)).not.toContain("super-secret");
    }
  });

  it("treats empty strings as unset and trims trailing slashes", () => {
    const config = loadConfig({ SERVE_API_KEY: "", SERVE_BASE_URL: "http://localhost:9999///" });
    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBe("http://localhost:9999");
  });
});
