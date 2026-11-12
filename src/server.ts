import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { isSimulated, type Config } from "./config.js";
import { DisabledGeocoder, NominatimGeocoder, type Geocoder } from "./geo/geocoder.js";
import type { Logger } from "./logger.js";
import { ServeClient } from "./serve/client.js";
import { QuoteCache } from "./state/quote-cache.js";
import {
  registerAvailabilityTool,
  registerCancelTool,
  registerDispatchTool,
  registerListTool,
  registerQuoteTool,
  registerRouteTool,
  registerSimulateTool,
  registerTrackTool,
  registerUnlockTool,
  type ToolContext,
} from "./tools/index.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export interface ServerDependencies {
  config: Config;
  logger: Logger;
  /** Overrides for tests. */
  client?: ServeClient;
  geocoder?: Geocoder;
  quotes?: QuoteCache;
  newOrderId?: () => string;
}

const INSTRUCTIONS = [
  "Tools for booking sidewalk robot deliveries via the Serve Robotics API.",
  "Workflow: get_delivery_quote → show the user the fee, ETA and addresses → get explicit",
  "approval → dispatch_robot with confirmed=true → track_delivery → unlock_robot_bin at dropoff.",
  "Never dispatch without the user's explicit approval of the quoted fee.",
].join(" ");

export function createServer(deps: ServerDependencies): McpServer {
  const { config, logger } = deps;

  const ctx: ToolContext = {
    config,
    logger,
    client:
      deps.client ??
      new ServeClient({
        baseUrl: config.baseUrl,
        partnerId: config.partnerId,
        apiKey: config.apiKey,
        timeoutMs: config.requestTimeoutMs,
        logger,
      }),
    geocoder: deps.geocoder ?? createGeocoder(config, logger),
    quotes: deps.quotes ?? new QuoteCache(),
    newOrderId: deps.newOrderId ?? (() => `mcp_${randomUUID()}`),
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerAvailabilityTool(server, ctx);
  registerQuoteTool(server, ctx);
  registerDispatchTool(server, ctx);
  registerTrackTool(server, ctx);
  registerListTool(server, ctx);
  registerCancelTool(server, ctx);
  registerUnlockTool(server, ctx);
  registerRouteTool(server, ctx);
  if (isSimulated(config.environment)) registerSimulateTool(server, ctx);

  return server;
}

function createGeocoder(config: Config, logger: Logger): Geocoder {
  return config.geocoder === "nominatim"
    ? new NominatimGeocoder({ userAgent: config.geocoderUserAgent, logger })
    : new DisabledGeocoder();
}
