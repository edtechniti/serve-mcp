import { describe, expect, it } from "vitest";

import { createLogger, redact } from "../src/logger.js";

describe("logger", () => {
  it("redacts secrets from messages and fields", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      secrets: ["sk_live_123"],
      write: (l) => lines.push(l),
    });
    logger.info("using key sk_live_123", { header: "x-api-key: sk_live_123" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("sk_live_123");
    expect(lines[0]).toContain("[REDACTED]");
  });

  it("respects the level threshold", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "warn", write: (l) => lines.push(l) });
    logger.info("hidden");
    logger.warn("shown");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ level: "warn", message: "shown" });
  });

  it("ignores empty secrets", () => {
    expect(redact("abc", [""])).toBe("abc");
  });
});
