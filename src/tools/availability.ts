import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { LocationInput, guarded, ok, resolveLocation, type ToolContext } from "./shared.js";

export function registerAvailabilityTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "check_robot_availability",
    {
      title: "Check robot availability",
      description:
        "Count delivery robots on duty near a location. Use this to check whether " +
        "Serve operates in an area before quoting a delivery.",
      inputSchema: {
        location: LocationInput,
        radius_m: z
          .number()
          .min(50)
          .max(50_000)
          .default(1000)
          .describe("Search radius in meters (default 1000)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded("check_robot_availability", ctx.logger, async ({ location, radius_m }) => {
      const resolved = await resolveLocation(location, ctx.geocoder);
      const result = await ctx.client.countNearbyRobots({
        lat: resolved.location.lat,
        lng: resolved.location.lng,
        radiusM: radius_m,
      });
      const summary =
        result.count === 0
          ? `No robots on duty within ${result.radius_m} m of that location.`
          : `${result.count} robot(s) on duty within ${result.radius_m} m.`;
      return ok(summary, {
        ...result,
        location_source: resolved.source,
        matched: resolved.matched,
      });
    }),
  );
}
