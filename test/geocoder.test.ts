import { describe, expect, it, vi } from "vitest";

import { DisabledGeocoder, GeocodingError, NominatimGeocoder } from "../src/geo/geocoder.js";
import { silentLogger } from "../src/logger.js";
import { urlOf } from "./helpers.js";

const address = {
  street_address_1: "100 Main St",
  city: "Los Angeles",
  state: "CA",
  zip_code: "90012",
  country: "US",
};

describe("NominatimGeocoder", () => {
  it("sends a structured query with an identifying User-Agent", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ lat: "34.05", lon: "-118.24", display_name: "Main St" }])),
      ),
    );
    const geocoder = new NominatimGeocoder({
      userAgent: "test-agent",
      logger: silentLogger,
      fetch: fetchImpl,
    });

    await expect(geocoder.geocode(address)).resolves.toEqual({
      location: { lat: 34.05, lng: -118.24 },
      displayName: "Main St",
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    const params = new URL(urlOf(url)).searchParams;
    expect(params.get("street")).toBe("100 Main St");
    expect(params.get("postalcode")).toBe("90012");
    expect(new Headers(init?.headers).get("user-agent")).toBe("test-agent");
  });

  it("waits between requests to respect the 1 req/s policy", async () => {
    let clock = 0;
    const sleep = vi.fn((ms: number) => {
      clock += ms;
      return Promise.resolve();
    });
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify([{ lat: "1", lon: "2" }]))),
    );
    const geocoder = new NominatimGeocoder({
      userAgent: "t",
      logger: silentLogger,
      fetch: fetchImpl,
      now: () => clock,
      sleep,
    });

    await Promise.all([geocoder.geocode(address), geocoder.geocode(address)]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(1000);
  });

  it("fails clearly when nothing matches", async () => {
    const geocoder = new NominatimGeocoder({
      userAgent: "t",
      logger: silentLogger,
      fetch: () => Promise.resolve(new Response("[]")),
    });
    await expect(geocoder.geocode(address)).rejects.toBeInstanceOf(GeocodingError);
  });
});

describe("DisabledGeocoder", () => {
  it("asks for coordinates", async () => {
    await expect(new DisabledGeocoder().geocode()).rejects.toThrow(/Provide lat\/lng/);
  });
});
