import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Config } from "../config.js";
import { GeocodingError, type Geocoder } from "../geo/geocoder.js";
import type { Logger } from "../logger.js";
import type { ServeClient } from "../serve/client.js";
import { describeError } from "../serve/errors.js";
import type { Address, JobResponse, LatLng } from "../serve/schemas.js";
import type { QuoteCache } from "../state/quote-cache.js";

/** Everything a tool handler needs. Built once at startup. */
export interface ToolContext {
  readonly config: Config;
  readonly client: ServeClient;
  readonly geocoder: Geocoder;
  readonly quotes: QuoteCache;
  readonly logger: Logger;
  /** Generates a unique external order id for each dispatch. */
  readonly newOrderId: () => string;
}

// ---------------------------------------------------------------------------
// Input schemas shared across tools
// ---------------------------------------------------------------------------

export const LocationInput = z.object({
  street_address_1: z.string().trim().min(1).max(200).describe("Street number and name"),
  street_address_2: z.string().trim().max(200).optional().describe("Suite, unit, floor"),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(2).max(50).describe("State or region, e.g. CA"),
  zip_code: z.string().trim().min(3).max(12),
  country: z.string().trim().min(2).max(56).default("US").describe("Country code, e.g. US"),
  lat: z.number().min(-90).max(90).optional().describe("Latitude, if known"),
  lng: z.number().min(-180).max(180).optional().describe("Longitude, if known"),
  name: z.string().trim().max(100).optional().describe("Business or place name"),
});
export type LocationInput = z.infer<typeof LocationInput>;

export const JobIdInput = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe("Delivery id returned by dispatch_robot");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface ResolvedLocation {
  readonly address: Address;
  readonly location: LatLng;
  readonly name: string | undefined;
  /** Where the coordinates came from, for transparency in tool output. */
  readonly source: "provided" | "geocoded";
  readonly matched: string | undefined;
}

export async function resolveLocation(
  input: LocationInput,
  geocoder: Geocoder,
): Promise<ResolvedLocation> {
  const address: Address = {
    street_address_1: input.street_address_1,
    street_address_2: input.street_address_2 ?? null,
    city: input.city,
    state: input.state,
    zip_code: input.zip_code,
    country: input.country,
  };
  if (input.lat !== undefined && input.lng !== undefined) {
    return {
      address,
      location: { lat: input.lat, lng: input.lng },
      name: input.name,
      source: "provided",
      matched: undefined,
    };
  }
  if (input.lat !== undefined || input.lng !== undefined) {
    throw new GeocodingError("Provide both lat and lng, or neither.");
  }
  const result = await geocoder.geocode(address);
  return {
    address,
    location: result.location,
    name: input.name,
    source: "geocoded",
    matched: result.displayName,
  };
}

export function formatMoney(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function formatAddress(address: Partial<Address> | null | undefined): string {
  if (!address) return "unknown address";
  return [
    address.street_address_1,
    address.street_address_2,
    address.city,
    [address.state, address.zip_code].filter(Boolean).join(" "),
  ]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join(", ");
}

const STATUS_LABELS: Record<string, string> = {
  pending_courier_assignment: "Waiting for a robot to be assigned",
  pickup_en_route: "Robot heading to pickup",
  pickup_arrived: "Robot at pickup — ready to be loaded",
  dropoff_en_route: "Robot on the way to dropoff",
  dropoff_arrived: "Robot at dropoff — ready to unlock",
  dropoff_complete: "Delivered",
  canceled: "Canceled",
  rejected: "Rejected",
};

export function describeStatus(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * Public view of a job for tool output.
 * Deliberately omits the bin unlock code: unlocking is a separate, explicit action.
 */
export function summarizeJob(job: JobResponse): Record<string, unknown> {
  const latestEvent = job.events?.at(-1);
  return {
    delivery_id: job.delivery_id,
    status: job.status,
    status_label: describeStatus(job.status),
    fee: job.fee != null ? formatMoney(job.fee, job.currency ?? "USD") : undefined,
    pickup: formatAddress(job.pickup?.address),
    dropoff: formatAddress(job.dropoff?.address),
    items: job.delivery_items ?? undefined,
    robot_location: job.courier?.location ?? undefined,
    pickup_eta: job.pickup_eta ?? undefined,
    dropoff_eta: job.dropoff_eta ?? undefined,
    latest_event: latestEvent
      ? { name: latestEvent.event_name, at: latestEvent.timestamp }
      : undefined,
    cancel_reason: job.cancel_reason ?? undefined,
    created: job.created,
    updated: job.updated,
  };
}

/** A successful tool result: a one-line summary plus machine-readable details. */
export function ok(summary: string, details?: unknown): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: summary }];
  if (details !== undefined) {
    content.push({ type: "text", text: JSON.stringify(details, null, 2) });
  }
  return { content };
}

/** A tool-level error the model can read and act on (not a protocol error). */
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wrap a handler so any thrown error becomes a readable tool error. */
export function guarded<A>(
  name: string,
  logger: Logger,
  handler: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      const guidance = describeError(error);
      logger.warn("Tool failed", {
        tool: name,
        error: error instanceof Error ? error.name : "unknown",
        message: guidance.message,
      });
      const hint = guidance.retryable ? " (This may succeed if retried later.)" : "";
      return fail(`${guidance.message}${hint}`);
    }
  };
}
