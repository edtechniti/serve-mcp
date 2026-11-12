import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  JobIdInput,
  describeStatus,
  guarded,
  ok,
  summarizeJob,
  type ToolContext,
} from "./shared.js";

export function registerTrackTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "track_delivery",
    {
      title: "Track delivery",
      description: "Current status, robot position and ETAs for a delivery.",
      inputSchema: { delivery_id: JobIdInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded("track_delivery", ctx.logger, async ({ delivery_id }) => {
      const job = await ctx.client.getJob(delivery_id);
      const eta = job.dropoff_eta ? ` ETA ${job.dropoff_eta}.` : "";
      return ok(`${job.delivery_id}: ${describeStatus(job.status)}.${eta}`, summarizeJob(job));
    }),
  );
}
