import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CANCEL_REASONS } from "../serve/schemas.js";
import { JobIdInput, guarded, ok, summarizeJob, type ToolContext } from "./shared.js";

export function registerCancelTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "cancel_delivery",
    {
      title: "Cancel delivery",
      description:
        "Cancel a delivery that hasn't finished. Confirm with the user first; " +
        "a canceled delivery can't be resumed.",
      inputSchema: {
        delivery_id: JobIdInput,
        reason: z.enum(CANCEL_REASONS).default("cx_canceled"),
        notes: z.string().trim().max(500).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded("cancel_delivery", ctx.logger, async ({ delivery_id, reason, notes }) => {
      const job = await ctx.client.cancelJob(delivery_id, {
        reason,
        ...(notes ? { notes } : {}),
      });
      return ok(`Delivery ${job.delivery_id} canceled.`, summarizeJob(job));
    }),
  );
}
