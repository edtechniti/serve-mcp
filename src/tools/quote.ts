import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { isSimulated } from "../config.js";
import { REJECTION_REASONS, type CreateQuoteRequest } from "../serve/schemas.js";
import {
  LocationInput,
  fail,
  formatAddress,
  formatMoney,
  guarded,
  ok,
  resolveLocation,
  type ResolvedLocation,
  type ToolContext,
} from "./shared.js";

function toQuoteWaypoint(resolved: ResolvedLocation): CreateQuoteRequest["pickup"] {
  return {
    address: resolved.address,
    location: resolved.location,
    ...(resolved.name ? { name: resolved.name } : {}),
  };
}

export function registerQuoteTool(server: McpServer, ctx: ToolContext): void {
  const simulated = isSimulated(ctx.config.environment);

  server.registerTool(
    "get_delivery_quote",
    {
      title: "Get delivery quote",
      description:
        "Price and ETA for a robot delivery from pickup to dropoff. Reserves nothing. " +
        "Quotes expire after about 5 minutes and can be used once. " +
        "Always show the fee, ETA and both resolved addresses to the user and get " +
        "their explicit approval before calling dispatch_robot.",
      inputSchema: {
        pickup: LocationInput.describe("Where the robot collects the items"),
        dropoff: LocationInput.describe("Where the robot delivers the items"),
        dropoff_deadline: z.iso
          .datetime()
          .optional()
          .describe("Latest acceptable delivery time (UTC ISO 8601)"),
        ...(simulated
          ? {
              simulate_rejection: z
                .enum(REJECTION_REASONS)
                .optional()
                .describe("Mock/sandbox only: force a specific rejection for testing"),
            }
          : {}),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded("get_delivery_quote", ctx.logger, async (args) => {
      const [pickup, dropoff] = await Promise.all([
        resolveLocation(args.pickup, ctx.geocoder),
        resolveLocation(args.dropoff, ctx.geocoder),
      ]);
      const simulateRejection = "simulate_rejection" in args ? args.simulate_rejection : undefined;

      const request: CreateQuoteRequest = {
        pickup: toQuoteWaypoint(pickup),
        dropoff: toQuoteWaypoint(dropoff),
        ...(args.dropoff_deadline ? { dropoff_deadline: args.dropoff_deadline } : {}),
        ...(simulateRejection ? { simulate_rejection: simulateRejection } : {}),
      };
      const quote = await ctx.client.createQuote(request);

      ctx.quotes.add({
        quoteId: quote.quote_id,
        pickup: request.pickup,
        dropoff: request.dropoff,
        feeCents: quote.fee,
        currency: quote.currency,
        expiresAt: new Date(quote.expires),
      });

      const fee = formatMoney(quote.fee, quote.currency);
      const overCap = quote.fee > ctx.config.maxFeeCents;
      if (overCap) {
        return fail(
          `Quoted fee ${fee} exceeds this server's limit of ` +
            `${formatMoney(ctx.config.maxFeeCents, quote.currency)}; it can't be dispatched.`,
        );
      }

      return ok(
        `Quote ${quote.quote_id}: ${fee}, delivered in about ${quote.dropoff_estimate_minutes} min. ` +
          `Expires ${quote.expires}. Confirm with the user before dispatching.`,
        {
          quote_id: quote.quote_id,
          fee,
          fee_cents: quote.fee,
          currency: quote.currency,
          pickup_estimate_minutes: quote.pickup_estimate_minutes,
          dropoff_estimate_minutes: quote.dropoff_estimate_minutes,
          dropoff_eta: quote.dropoff_eta,
          expires: quote.expires,
          pickup: {
            address: formatAddress(pickup.address),
            location: pickup.location,
            location_source: pickup.source,
            matched: pickup.matched,
          },
          dropoff: {
            address: formatAddress(dropoff.address),
            location: dropoff.location,
            location_source: dropoff.source,
            matched: dropoff.matched,
          },
        },
      );
    }),
  );
}
