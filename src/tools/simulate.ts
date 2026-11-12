import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { REJECTION_REASONS, SIMULATED_TARGET_STAGES } from "../serve/schemas.js";
import {
  JobIdInput,
  describeStatus,
  fail,
  guarded,
  ok,
  summarizeJob,
  type ToolContext,
} from "./shared.js";

/** Registered only in mock and sandbox modes. */
export function registerSimulateTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "simulate_delivery_progress",
    {
      title: "Simulate delivery progress",
      description:
        "Testing only (mock/sandbox): move a simulated delivery to a later stage, " +
        "or reject it with a reason, to demo the full lifecycle.",
      inputSchema: {
        delivery_id: JobIdInput,
        target_stage: z.enum(SIMULATED_TARGET_STAGES),
        reject_reason: z
          .enum(REJECTION_REASONS)
          .optional()
          .describe("Required when target_stage is 'rejected'"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded("simulate_delivery_progress", ctx.logger, async (args) => {
      if (args.target_stage === "rejected" && !args.reject_reason) {
        return fail("reject_reason is required when target_stage is 'rejected'.");
      }
      const job = await ctx.client.advanceSimulatedJob(args.delivery_id, {
        target_stage: args.target_stage,
        ...(args.reject_reason ? { reject_reason: args.reject_reason } : {}),
      });
      return ok(`${job.delivery_id}: ${describeStatus(job.status)}.`, summarizeJob(job));
    }),
  );
}
