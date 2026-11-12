import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ServeApiError, ServeTransportError } from "../serve/errors.js";
import { JobItemSchema, type CreateJobRequest, type JobResponse } from "../serve/schemas.js";
import { fail, formatMoney, guarded, ok, summarizeJob, type ToolContext } from "./shared.js";

const PhoneNumber = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ().-]{7,20}$/, "Use digits, optionally starting with +");

const DispatchInput = {
  quote_id: z.string().trim().min(1).describe("quote_id from get_delivery_quote"),
  confirmed: z
    .boolean()
    .describe("Must be true, and only after the user explicitly approved this quote's fee"),
  items: z.array(JobItemSchema).min(1).max(20).describe("What is being delivered"),
  recipient_name: z.string().trim().min(1).max(100),
  recipient_phone: PhoneNumber.optional(),
  dropoff_notes: z.string().trim().max(500).optional().describe("Instructions for the handoff"),
  pickup_notes: z.string().trim().max(500).optional().describe("Instructions for loading"),
};

export function registerDispatchTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "dispatch_robot",
    {
      title: "Dispatch robot",
      description:
        "Send a robot to fulfil a quote from get_delivery_quote. This creates a real " +
        "delivery and incurs the quoted fee (outside mock mode). Only call it after the " +
        "user has seen the fee and addresses and explicitly said yes; set confirmed=true " +
        "only in that case. Pickup and dropoff are taken from the quote and can't be changed.",
      inputSchema: DispatchInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guarded("dispatch_robot", ctx.logger, async (args) => {
      if (!args.confirmed) {
        return fail(
          "Not dispatched. Show the user the fee and addresses, get an explicit yes, " +
            "then call again with confirmed=true.",
        );
      }

      const lookup = ctx.quotes.lookup(args.quote_id);
      switch (lookup.status) {
        case "unknown":
          return fail("Unknown quote_id. Get a quote with get_delivery_quote first.");
        case "expired":
          return fail("That quote has expired. Get a new quote and confirm it with the user.");
        case "used":
          return fail("That quote was already dispatched. Use list_deliveries to find it.");
        case "ok":
          break;
      }
      const quote = lookup.quote;

      if (quote.feeCents > ctx.config.maxFeeCents) {
        return fail(
          `The fee ${formatMoney(quote.feeCents, quote.currency)} exceeds this server's ` +
            `limit of ${formatMoney(ctx.config.maxFeeCents, quote.currency)}.`,
        );
      }

      const request: CreateJobRequest = {
        quote_id: quote.quoteId,
        external_order_id: ctx.newOrderId(),
        pickup: {
          ...quote.pickup,
          ...(args.pickup_notes ? { notes: args.pickup_notes } : {}),
        },
        dropoff: {
          ...quote.dropoff,
          name: args.recipient_name,
          ...(args.recipient_phone ? { phone_number: args.recipient_phone } : {}),
          ...(args.dropoff_notes ? { notes: args.dropoff_notes } : {}),
        },
        delivery_items: args.items,
        undeliverable_action: "return",
      };

      const job = await createJobSafely(ctx, request);
      ctx.quotes.markUsed(quote.quoteId);

      return ok(
        `Dispatched delivery ${job.delivery_id} for ${formatMoney(quote.feeCents, quote.currency)}. ` +
          `Status: ${job.status}. Use track_delivery to follow it.`,
        summarizeJob(job),
      );
    }),
  );
}

/**
 * Create a job without risking a duplicate dispatch.
 *
 * Job creation is never blindly retried. If the response is lost, look the job
 * up by its unique external_order_id: it either exists (success) or it doesn't
 * (safe to report failure).
 */
async function createJobSafely(ctx: ToolContext, request: CreateJobRequest): Promise<JobResponse> {
  try {
    return await ctx.client.createJob(request);
  } catch (error) {
    if (error instanceof ServeApiError && error.code === "used_quote") {
      ctx.quotes.markUsed(request.quote_id);
    }
    if (!(error instanceof ServeTransportError) || !error.mayHaveReachedServer) throw error;

    ctx.logger.warn("Job creation response lost; reconciling", {
      external_order_id: request.external_order_id,
    });
    const existing = await findJobByOrderId(ctx, request.external_order_id);
    if (existing) return existing;
    throw new ServeTransportError(
      "The delivery request didn't get a response and no matching delivery was found. " +
        "Check list_deliveries before trying again.",
      false,
      { cause: error },
    );
  }
}

async function findJobByOrderId(
  ctx: ToolContext,
  externalOrderId: string,
): Promise<JobResponse | undefined> {
  const recent = await ctx.client.listJobs({ active: true, limit: 100 });
  return recent.find((job) => job.external_order_id === externalOrderId);
}
