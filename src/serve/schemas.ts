/**
 * Zod schemas for the subset of the Serve AV Delivery API (v2) this project uses.
 * Derived from Serve's public API reference.
 *
 * Response schemas are intentionally lenient: unknown fields are ignored and
 * free-form strings are used where the API may add new enum values, so a new
 * server-side field or status never breaks the client.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof LatLngSchema>;

export const AddressSchema = z.object({
  street_address_1: z.string().min(1),
  street_address_2: z.string().nullish(),
  city: z.string().min(1),
  state: z.string().min(1),
  zip_code: z.string().min(1),
  country: z.string().min(1),
});
export type Address = z.infer<typeof AddressSchema>;

export const WaypointSchema = z.object({
  address: AddressSchema,
  location: LatLngSchema,
  id: z.string().nullish(),
  name: z.string().nullish(),
  notes: z.string().nullish(),
  phone_number: z.string().nullish(),
  selected_spot_id: z.string().nullish(),
});
export type Waypoint = z.infer<typeof WaypointSchema>;

export const ErrorResponseSchema = z.object({
  code: z.string(),
  detail: z.string(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const JOB_STATUSES = [
  "pending_courier_assignment",
  "pickup_en_route",
  "pickup_arrived",
  "dropoff_en_route",
  "dropoff_arrived",
  "dropoff_complete",
  "canceled",
  "rejected",
] as const;
export type KnownJobStatus = (typeof JOB_STATUSES)[number];

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "dropoff_complete",
  "canceled",
  "rejected",
]);
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Stages a simulated job can be advanced to. */
export const SIMULATED_TARGET_STAGES = [
  "pickup_arrived",
  "dropoff_en_route",
  "dropoff_arrived",
  "dropoff_complete",
  "rejected",
] as const;
export type SimulatedTargetStage = (typeof SIMULATED_TARGET_STAGES)[number];

export const REJECTION_REASONS = [
  "pickup_untraversable",
  "dropoff_untraversable",
  "delivery_distance_exceeds_limit",
  "outside_operating_hours",
  "pickup_deadline_unreachable",
  "dropoff_deadline_unreachable",
  "couriers_busy",
  "internal_error",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** Subset of partner cancel reasons that make sense for an assistant to choose. */
export const CANCEL_REASONS = [
  "cx_canceled",
  "customer_opted_out",
  "customer_not_available",
  "mx_canceled",
  "pickup_not_ready",
  "order_does_not_fit",
  "missed_pickup_time",
  "missed_dropoff_time",
  "other_reason",
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export const QuoteWaypointSchema = WaypointSchema.pick({
  address: true,
  location: true,
  id: true,
  name: true,
});

export const CreateQuoteRequestSchema = z.object({
  pickup: QuoteWaypointSchema,
  dropoff: QuoteWaypointSchema,
  pickup_ready_time: z.iso.datetime().optional(),
  pickup_deadline: z.iso.datetime().optional(),
  dropoff_ready_time: z.iso.datetime().optional(),
  dropoff_deadline: z.iso.datetime().optional(),
  external_ref_id: z.string().optional(),
  simulate_rejection: z.enum(REJECTION_REASONS).optional(),
});
export type CreateQuoteRequest = z.infer<typeof CreateQuoteRequestSchema>;

export const SuggestedSpotSchema = z.object({
  waypoint: z.string(),
  spot_id: z.string(),
  location: LatLngSchema,
  capacity: z.number().int().nullish(),
  distance_meters: z.number().nullish(),
  name: z.string().nullish(),
});

export const QuoteResponseSchema = z.object({
  quote_id: z.string(),
  created: z.string(),
  expires: z.string(),
  fee: z.number().int(),
  currency: z.string(),
  dropoff_eta: z.string(),
  dropoff_estimate_minutes: z.number().int(),
  pickup_estimate_minutes: z.number().int(),
  external_ref_id: z.string().nullish(),
  suggested_spots: z.array(SuggestedSpotSchema).nullish(),
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const JobItemSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().int().positive(),
});
export type JobItem = z.infer<typeof JobItemSchema>;

export const CreateJobRequestSchema = z.object({
  quote_id: z.string().min(1),
  external_order_id: z.string().min(1),
  pickup: WaypointSchema,
  dropoff: WaypointSchema,
  delivery_items: z.array(JobItemSchema).min(1),
  courier_unlock_code: z
    .string()
    .regex(/^[0-9]{3,4}$/)
    .optional(),
  undeliverable_action: z.enum(["return", "dispose"]).optional(),
  partner_metadata: z.record(z.string(), z.string().max(500)).optional(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const JobEventSchema = z.object({
  event_id: z.string(),
  event_name: z.string(),
  timestamp: z.string(),
});

export const CourierSchema = z.object({
  courier_id: z.string().nullish(),
  name: z.string().nullish(),
  location: LatLngSchema.nullish(),
});

export const JobWaypointResponseSchema = WaypointSchema.partial().extend({
  spot_id: z.string().nullish(),
  spot_source: z.string().nullish(),
});

export const JobResponseSchema = z.object({
  delivery_id: z.string(),
  status: z.string(),
  created: z.string(),
  updated: z.string(),
  quote_id: z.string().nullish(),
  external_order_id: z.string().nullish(),
  fee: z.number().int().nullish(),
  currency: z.string().nullish(),
  courier: CourierSchema.nullish(),
  courier_unlock_code: z.string().nullish(),
  cancel_reason: z.string().nullish(),
  pickup: JobWaypointResponseSchema.nullish(),
  dropoff: JobWaypointResponseSchema.nullish(),
  delivery_items: z.array(JobItemSchema).nullish(),
  pickup_eta: z.string().nullish(),
  dropoff_eta: z.string().nullish(),
  events: z.array(JobEventSchema).nullish(),
  undeliverable_action: z.string().nullish(),
});
export type JobResponse = z.infer<typeof JobResponseSchema>;

export const JobListResponseSchema = z.array(JobResponseSchema);

export const CancelJobRequestSchema = z.object({
  reason: z.enum(CANCEL_REASONS),
  notes: z.string().max(500).optional(),
});
export type CancelJobRequest = z.infer<typeof CancelJobRequestSchema>;

export const AdvanceJobRequestSchema = z.object({
  target_stage: z.enum(SIMULATED_TARGET_STAGES),
  reject_reason: z.enum(REJECTION_REASONS).optional(),
});
export type AdvanceJobRequest = z.infer<typeof AdvanceJobRequestSchema>;

// ---------------------------------------------------------------------------
// Robots & routes
// ---------------------------------------------------------------------------

export const NearbyRobotsResponseSchema = z.object({
  count: z.number().int().min(0),
  lat: z.number(),
  lng: z.number(),
  radius_m: z.number(),
});
export type NearbyRobotsResponse = z.infer<typeof NearbyRobotsResponseSchema>;

export const RouteLegSchema = z.object({
  waypoint_id: z.string(),
  distance: z.number().nullish(),
  route: z
    .object({
      type: z.string(),
      coordinates: z.array(z.array(z.number())),
    })
    .nullish(),
});

export const JobRouteResponseSchema = z.object({
  delivery_id: z.string(),
  courier_id: z.string(),
  legs: z.array(RouteLegSchema),
});
export type JobRouteResponse = z.infer<typeof JobRouteResponseSchema>;
