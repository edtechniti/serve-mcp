import { describe, expect, it, vi } from "vitest";

import { silentLogger } from "../src/logger.js";
import { ServeClient } from "../src/serve/client.js";
import { ServeApiError, ServeTransportError } from "../src/serve/errors.js";
import { urlOf } from "./helpers.js";

const job = {
  delivery_id: "del_1",
  status: "pickup_en_route",
  created: "2026-01-01T00:00:00Z",
  updated: "2026-01-01T00:00:00Z",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(fetchImpl: typeof fetch, sleep = vi.fn(() => Promise.resolve())) {
  const client = new ServeClient({
    baseUrl: "https://api.example.test",
    partnerId: "ptnr/odd id",
    apiKey: "secret-key",
    timeoutMs: 5000,
    logger: silentLogger,
    fetch: fetchImpl,
    sleep,
  });
  return { client, sleep };
}

describe("ServeClient", () => {
  it("builds partner-scoped URLs, encodes segments and sends the API key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(200, job)));
    const { client } = makeClient(fetchImpl);
    await client.getJob("del/1");

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(urlOf(url)).toBe("https://api.example.test/v2/partners/ptnr%2Fodd%20id/jobs/del%2F1");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("secret-key");
    expect(init?.redirect).toBe("error");
  });

  it("omits undefined query parameters", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(200, [])));
    const { client } = makeClient(fetchImpl);
    await client.listJobs({ active: false });
    expect(urlOf(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/jobs\?active=false$/);
  });

  it("retries safe requests on 429, honouring retry-after", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(429, { code: "rate_limited", detail: "slow" }, { "retry-after": "2" }),
      )
      .mockResolvedValueOnce(json(200, job));
    const { client, sleep } = makeClient(fetchImpl);

    await expect(client.getJob("del_1")).resolves.toMatchObject({ delivery_id: "del_1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("never retries job creation", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json(503, { code: "couriers_busy", detail: "busy" })),
    );
    const { client } = makeClient(fetchImpl);
    const body = {
      quote_id: "q",
      external_order_id: "o",
      pickup: {
        address: { street_address_1: "a", city: "b", state: "c", zip_code: "d", country: "US" },
        location: { lat: 0, lng: 0 },
      },
      dropoff: {
        address: { street_address_1: "a", city: "b", state: "c", zip_code: "d", country: "US" },
        location: { lat: 0, lng: 0 },
      },
      delivery_items: [{ name: "x", quantity: 1 }],
    };
    await expect(client.createJob(body)).rejects.toBeInstanceOf(ServeApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry client errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json(404, { code: "not_found", detail: "missing" })),
    );
    const { client } = makeClient(fetchImpl);
    await expect(client.getJob("x")).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the maximum attempts", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("fetch failed")));
    const { client, sleep } = makeClient(fetchImpl);
    await expect(client.getJob("x")).rejects.toBeInstanceOf(ServeTransportError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c: unknown[]) => c[0])).toEqual([500, 1000]);
  });

  it("handles non-JSON error bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("<html>bad gateway</html>", { status: 400, statusText: "Bad" })),
    );
    const { client } = makeClient(fetchImpl);
    await expect(client.getJob("x")).rejects.toMatchObject({ status: 400, code: "http_400" });
  });

  it("rejects responses that don't match the schema", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(200, { nope: true })));
    const { client } = makeClient(fetchImpl);
    await expect(client.getJob("x")).rejects.toThrow(/unexpected format/);
  });
});
