import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { DisabledGeocoder } from "../src/geo/geocoder.js";
import { silentLogger } from "../src/logger.js";
import { createServer } from "../src/server.js";

describe("production mode", () => {
  it("does not expose simulation tools or rejection simulation", async () => {
    const config = loadConfig({
      SERVE_ENV: "production",
      SERVE_ALLOW_PRODUCTION: "true",
      SERVE_PARTNER_ID: "ptnr_x",
      SERVE_API_KEY: "k",
    });
    const server = createServer({ config, logger: silentLogger, geocoder: new DisabledGeocoder() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(b), client.connect(a)]);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("simulate_delivery_progress");
    const quote = tools.find((t) => t.name === "get_delivery_quote");
    expect(JSON.stringify(quote?.inputSchema)).not.toContain("simulate_rejection");

    await client.close();
    await server.close();
  });
});
