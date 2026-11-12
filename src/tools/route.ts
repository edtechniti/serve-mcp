import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { JobIdInput, guarded, ok, type ToolContext } from "./shared.js";

export function registerRouteTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_delivery_route",
    {
      title: "Get delivery route",
      description:
        "The robot's planned route for a delivery: distance per leg, and optionally " +
        "the GeoJSON geometry for mapping.",
      inputSchema: {
        delivery_id: JobIdInput,
        include_geometry: z.boolean().default(false).describe("Include GeoJSON LineStrings"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded("get_delivery_route", ctx.logger, async ({ delivery_id, include_geometry }) => {
      const route = await ctx.client.getJobRoute(delivery_id);
      const totalMeters = route.legs.reduce((sum, leg) => sum + (leg.distance ?? 0), 0);
      const legs = route.legs.map((leg) => ({
        waypoint_id: leg.waypoint_id,
        distance_m: leg.distance ?? undefined,
        ...(include_geometry && leg.route ? { geometry: leg.route } : {}),
      }));
      return ok(
        `Route for ${route.delivery_id}: ${route.legs.length} leg(s), ` +
          `about ${(totalMeters / 1000).toFixed(2)} km.`,
        { delivery_id: route.delivery_id, total_distance_m: totalMeters, legs },
      );
    }),
  );
}
