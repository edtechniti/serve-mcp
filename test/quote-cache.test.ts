import { describe, expect, it } from "vitest";

import { QuoteCache, type CachedQuote } from "../src/state/quote-cache.js";

const waypoint = {
  address: { street_address_1: "1 A St", city: "X", state: "CA", zip_code: "1", country: "US" },
  location: { lat: 0, lng: 0 },
};

function quote(id: string, expiresAt: Date): CachedQuote {
  return {
    quoteId: id,
    pickup: waypoint,
    dropoff: waypoint,
    feeCents: 500,
    currency: "USD",
    expiresAt,
  };
}

describe("QuoteCache", () => {
  it("tracks the lifecycle of a quote", () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const cache = new QuoteCache(() => now);
    cache.add(quote("q1", new Date("2026-01-01T00:05:00Z")));

    expect(cache.lookup("q1").status).toBe("ok");
    expect(cache.lookup("nope").status).toBe("unknown");

    now = new Date("2026-01-01T00:05:00Z");
    expect(cache.lookup("q1").status).toBe("expired");
  });

  it("refuses a quote once used", () => {
    const cache = new QuoteCache(() => new Date("2026-01-01T00:00:00Z"));
    cache.add(quote("q1", new Date("2026-01-01T00:05:00Z")));
    cache.markUsed("q1");
    expect(cache.lookup("q1").status).toBe("used");
  });
});
