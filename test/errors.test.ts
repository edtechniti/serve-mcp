import { describe, expect, it } from "vitest";

import { ServeApiError, ServeTransportError, describeError } from "../src/serve/errors.js";

describe("describeError", () => {
  it("prefers code-specific guidance", () => {
    const guidance = describeError(new ServeApiError(503, "couriers_busy", "busy"));
    expect(guidance.retryable).toBe(true);
    expect(guidance.message).toMatch(/No robot is free/);
  });

  it("falls back to status guidance", () => {
    expect(describeError(new ServeApiError(401, "whatever", "x")).message).toMatch(/credentials/);
  });

  it("passes through unknown codes with detail", () => {
    const guidance = describeError(new ServeApiError(418, "teapot", "short and stout"));
    expect(guidance.message).toContain("short and stout");
    expect(guidance.retryable).toBe(false);
  });

  it("handles transport and unknown errors", () => {
    expect(describeError(new ServeTransportError("timed out", true)).retryable).toBe(true);
    expect(describeError("weird").message).toMatch(/unexpected/);
  });
});
