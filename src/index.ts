#!/usr/bin/env node
/**
 * Entry point: load config, start the MCP server on stdio.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    secrets: config.apiKey ? [config.apiKey] : [],
  });

  const server = createServer({ config, logger });
  const transport = new StdioServerTransport();

  const shutdown = (signal: string): void => {
    logger.info("Shutting down", { signal });
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  await server.connect(transport);
  logger.info("serve-delivery-mcp ready", {
    environment: config.environment,
    baseUrl: config.baseUrl,
    maxFeeCents: config.maxFeeCents,
  });
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConfigError ? error.message : "Fatal error starting serve-delivery-mcp";
  console.error(message);
  if (!(error instanceof ConfigError)) console.error(error);
  process.exit(1);
});
