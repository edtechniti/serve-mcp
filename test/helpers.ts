import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { startMockServer, type MockServer } from "../mock/server.js";
import { loadConfig, type Config } from "../src/config.js";
import type { GeocodeResult, Geocoder } from "../src/geo/geocoder.js";
import { silentLogger } from "../src/logger.js";
import type { Address } from "../src/serve/schemas.js";
import { createServer } from "../src/server.js";

/** Deterministic geocoder: a few known streets, everything else fails. */
export class FakeGeocoder implements Geocoder {
  calls = 0;
  private readonly known: Record<string, GeocodeResult> = {
    "100 main st": { location: { lat: 34.0522, lng: -118.2437 }, displayName: "100 Main St" },
    "200 spring st": { location: { lat: 34.0545, lng: -118.2425 }, displayName: "200 Spring St" },
    "1 far away rd": { location: { lat: 34.4, lng: -118.9 }, displayName: "1 Far Away Rd" },
  };

  geocode(address: Address): Promise<GeocodeResult> {
    this.calls++;
    const hit = this.known[address.street_address_1.toLowerCase()];
    return hit ? Promise.resolve(hit) : Promise.reject(new Error("Couldn't find that address."));
  }
}

export const PICKUP = {
  street_address_1: "100 Main St",
  city: "Los Angeles",
  state: "CA",
  zip_code: "90012",
  country: "US",
  name: "Corner Cafe",
};

export const DROPOFF = {
  street_address_1: "200 Spring St",
  city: "Los Angeles",
  state: "CA",
  zip_code: "90012",
  country: "US",
};

export interface Harness {
  client: Client;
  mock: MockServer;
  geocoder: FakeGeocoder;
  config: Config;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const mock = await startMockServer();
  const config = loadConfig({ SERVE_ENV: "mock", SERVE_BASE_URL: mock.url, ...env });
  const geocoder = new FakeGeocoder();
  let counter = 0;
  const server = createServer({
    config,
    logger: silentLogger,
    geocoder,
    newOrderId: () => `order_${String(++counter).padStart(4, "0")}`,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    mock,
    geocoder,
    config,
    call: async (name, args = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await client.close();
      await server.close();
      await mock.close();
    },
  };
}

export function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

export function details<T = Record<string, unknown>>(result: CallToolResult): T {
  const part = result.content[1];
  if (part?.type !== "text") throw new Error("No details block in tool result");
  return JSON.parse(part.text) as T;
}

export function urlOf(input: string | URL | Request | undefined): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}
