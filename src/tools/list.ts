import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { describeStatus, guarded, ok, summarizeJob, type ToolContext } from "./shared.js";

export function registerListTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_deliveries",
    {
      title: "List deliveries",
      description: "List deliveries, newest first. Defaults to active deliveries only.",
      inputSchema: {
        active_only: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded("list_deliveries", ctx.logger, async ({ active_only, limit }) => {
      const jobs = await ctx.client.listJobs({ active: active_only, limit });
      if (jobs.length === 0) {
        return ok(active_only ? "No active deliveries." : "No deliveries found.");
      }
      const lines = jobs.map((job) => `- ${job.delivery_id}: ${describeStatus(job.status)}`);
      return ok(`${jobs.length} deliver${jobs.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}`, {
        deliveries: jobs.map(summarizeJob),
      });
    }),
  );
}
