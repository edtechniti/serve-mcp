import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { JobIdInput, guarded, ok, summarizeJob, type ToolContext } from "./shared.js";

export function registerUnlockTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "unlock_robot_bin",
    {
      title: "Unlock robot bin",
      description:
        "Open the robot's cargo bin so the recipient can collect the items. " +
        "Only works once the robot has arrived at the dropoff.",
      inputSchema: { delivery_id: JobIdInput },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded("unlock_robot_bin", ctx.logger, async ({ delivery_id }) => {
      const job = await ctx.client.unlockJob(delivery_id);
      return ok(`Bin unlocked for delivery ${job.delivery_id}.`, summarizeJob(job));
    }),
  );
}
