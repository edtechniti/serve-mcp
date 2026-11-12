/**
 * In-memory mock of the Serve AV Delivery API (v2).
 *
 * Built from Serve's public API reference so the MCP server can be developed
 * and demoed without credentials. Behaviour is simplified but follows the
 * documented contract: paths, payload shapes, error format, single-use quotes
 * with a 5-minute expiry, the job lifecycle and its error codes.
 *
 * Not affiliated with Serve Robotics. Fees and ETAs are invented.
 */
import { randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { z } from "zod";

import {
  AdvanceJobRequestSchema,
  CancelJobRequestSchema,
  CreateJobRequestSchema,
  CreateQuoteRequestSchema,
  JOB_STATUSES,
  isTerminalStatus,
  type CreateQuoteRequest,
  type JobResponse,
  type LatLng,
  type QuoteResponse,
  type RejectionReason,
} from "../src/serve/schemas.js";

export interface MockOptions {
  port?: number;
  host?: string;
  /** If set, requests must send this X-API-Key. */
  apiKey?: string;
  /** Maximum pickup→dropoff distance in meters before rejecting. */
  maxDistanceM?: number;
  now?: () => Date;
}

export interface MockServer {
  readonly url: string;
  close(): Promise<void>;
  /** Exposed for tests. */
  readonly state: MockState;
}

interface StoredQuote {
  response: QuoteResponse;
  request: CreateQuoteRequest;
  used: boolean;
}

export interface MockState {
  quotes: Map<string, StoredQuote>;
  jobs: Map<string, JobResponse & { _order: number }>;
  /** Fail the next N job creations after storing the job, to simulate a lost response. */
  dropNextJobResponses: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

const QUOTE_TTL_MS = 5 * 60 * 1000;
const ROBOT_SPEED_MPS = 1.6;
const BASE_FEE_CENTS = 299;
const FEE_PER_KM_CENTS = 150;

const REJECTION_STATUS: Record<RejectionReason, number> = {
  pickup_untraversable: 422,
  dropoff_untraversable: 422,
  delivery_distance_exceeds_limit: 422,
  outside_operating_hours: 422,
  pickup_deadline_unreachable: 422,
  dropoff_deadline_unreachable: 422,
  couriers_busy: 503,
  internal_error: 500,
};

const STAGE_ORDER = new Map<string, number>(JOB_STATUSES.map((status, index) => [status, index]));

export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const id = (prefix: string): string => `${prefix}_${randomBytes(8).toString("hex")}`;

export async function startMockServer(options: MockOptions = {}): Promise<MockServer> {
  const now = options.now ?? (() => new Date());
  const maxDistanceM = options.maxDistanceM ?? 8000;
  const state: MockState = { quotes: new Map(), jobs: new Map(), dropNextJobResponses: 0 };
  let order = 0;

  const iso = (date: Date): string => date.toISOString();
  const addMinutes = (minutes: number): string => iso(new Date(now().getTime() + minutes * 60_000));

  function parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) {
      const first = result.error.issues[0];
      throw new HttpError(
        400,
        "validation_error",
        first ? `${first.path.join(".")}: ${first.message}` : "Invalid request",
      );
    }
    return result.data;
  }

  function getJob(jobId: string): JobResponse & { _order: number } {
    const job = state.jobs.get(jobId);
    if (!job) throw new HttpError(404, "not_found", `Job ${jobId} not found`);
    return job;
  }

  function touch(job: JobResponse, status: string, eventName?: string): void {
    job.status = status;
    job.updated = iso(now());
    if (eventName) {
      job.events = [
        ...(job.events ?? []),
        { event_id: id("evt"), event_name: eventName, timestamp: job.updated },
      ];
    }
    const pickup = job.pickup?.location;
    const dropoff = job.dropoff?.location;
    if (pickup && dropoff && job.courier) {
      const at: Record<string, LatLng> = {
        pickup_arrived: pickup,
        dropoff_en_route: {
          lat: (pickup.lat + dropoff.lat) / 2,
          lng: (pickup.lng + dropoff.lng) / 2,
        },
        dropoff_arrived: dropoff,
        dropoff_complete: dropoff,
      };
      job.courier.location = at[status] ?? job.courier.location ?? null;
    }
  }

  function publicJob(job: JobResponse & { _order: number }): JobResponse {
    const copy: Partial<typeof job> = { ...job };
    delete copy._order;
    return copy as JobResponse;
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function createQuote(body: unknown): [number, unknown] {
    const request = parse(CreateQuoteRequestSchema, body);
    if (request.simulate_rejection) {
      const reason = request.simulate_rejection;
      throw new HttpError(REJECTION_STATUS[reason], reason, `Simulated rejection: ${reason}`);
    }
    const distance = haversineMeters(request.pickup.location, request.dropoff.location);
    if (distance > maxDistanceM) {
      throw new HttpError(
        422,
        "delivery_distance_exceeds_limit",
        `Distance ${Math.round(distance)} m exceeds ${maxDistanceM} m`,
      );
    }
    const pickupMinutes = 5;
    const dropoffMinutes = pickupMinutes + Math.max(5, Math.ceil(distance / ROBOT_SPEED_MPS / 60));
    const response: QuoteResponse = {
      quote_id: id("qte"),
      created: iso(now()),
      expires: iso(new Date(now().getTime() + QUOTE_TTL_MS)),
      fee: BASE_FEE_CENTS + Math.round((distance / 1000) * FEE_PER_KM_CENTS),
      currency: "USD",
      pickup_estimate_minutes: pickupMinutes,
      dropoff_estimate_minutes: dropoffMinutes,
      dropoff_eta: addMinutes(dropoffMinutes),
      external_ref_id: request.external_ref_id ?? null,
      suggested_spots: [],
    };
    state.quotes.set(response.quote_id, { response, request, used: false });
    return [201, response];
  }

  function createJob(body: unknown): [number, unknown] {
    const request = parse(CreateJobRequestSchema, body);
    const stored = state.quotes.get(request.quote_id);
    if (!stored) throw new HttpError(422, "invalid_quote", "Unknown quote_id");
    if (stored.used) throw new HttpError(409, "used_quote", "Quote has already been used");
    if (new Date(stored.response.expires).getTime() <= now().getTime()) {
      throw new HttpError(422, "expired_quote", "Quote has expired");
    }
    const same = (a: LatLng, b: LatLng): boolean => a.lat === b.lat && a.lng === b.lng;
    if (
      !same(request.pickup.location, stored.request.pickup.location) ||
      !same(request.dropoff.location, stored.request.dropoff.location)
    ) {
      throw new HttpError(400, "mismatched_quote", "Pickup or dropoff does not match the quote");
    }
    stored.used = true;

    const created = iso(now());
    const job: JobResponse & { _order: number } = {
      _order: order++,
      delivery_id: id("del"),
      status: "pending_courier_assignment",
      created,
      updated: created,
      quote_id: request.quote_id,
      external_order_id: request.external_order_id,
      fee: stored.response.fee,
      currency: stored.response.currency,
      courier: { courier_id: id("cor"), name: "Mock Robot", location: request.pickup.location },
      courier_unlock_code:
        request.courier_unlock_code ??
        request.external_order_id.replace(/\D/g, "").slice(-3).padStart(3, "0"),
      cancel_reason: null,
      pickup: request.pickup,
      dropoff: request.dropoff,
      delivery_items: request.delivery_items,
      pickup_eta: addMinutes(stored.response.pickup_estimate_minutes),
      dropoff_eta: stored.response.dropoff_eta,
      events: [],
      undeliverable_action: request.undeliverable_action ?? "return",
    };
    touch(job, "pickup_en_route", "reserved_courier");
    touch(job, "pickup_en_route", "courier_dispatched");
    state.jobs.set(job.delivery_id, job);

    if (state.dropNextJobResponses > 0) {
      state.dropNextJobResponses--;
      throw new HttpError(-1, "dropped", "Simulated lost response");
    }
    return [201, publicJob(job)];
  }

  function listJobs(query: URLSearchParams): [number, unknown] {
    const active = query.get("active") !== "false";
    const offset = Math.max(0, Number(query.get("offset") ?? 0) || 0);
    const limit = Math.min(100, Math.max(1, Number(query.get("limit") ?? 20) || 20));
    const jobs = [...state.jobs.values()]
      .filter((job) => !active || !isTerminalStatus(job.status))
      .sort((a, b) => b._order - a._order)
      .slice(offset, offset + limit)
      .map(publicJob);
    return [200, jobs];
  }

  function cancelJob(jobId: string, body: unknown): [number, unknown] {
    const request = parse(CancelJobRequestSchema, body);
    const job = getJob(jobId);
    if (isTerminalStatus(job.status)) {
      throw new HttpError(409, "noncancelable_delivery", "Job already finished");
    }
    job.cancel_reason = request.reason;
    touch(job, "canceled", "cancel_delivery");
    return [200, publicJob(job)];
  }

  function unlockJob(jobId: string): [number, unknown] {
    const job = getJob(jobId);
    if (job.status === "pending_courier_assignment") {
      throw new HttpError(409, "no_courier_assigned", "No courier assigned");
    }
    if (job.status !== "dropoff_arrived") {
      throw new HttpError(409, "not_arrived_at_dropoff", "Courier has not arrived at dropoff");
    }
    job.updated = iso(now());
    return [200, publicJob(job)];
  }

  function jobRoute(jobId: string): [number, unknown] {
    const job = getJob(jobId);
    const pickup = job.pickup?.location;
    const dropoff = job.dropoff?.location;
    const start = job.courier?.location ?? pickup;
    if (!pickup || !dropoff || !start) throw new HttpError(404, "not_found", "Route not found");
    const leg = (from: LatLng, to: LatLng, waypoint: string): unknown => ({
      waypoint_id: waypoint,
      distance: Math.round(haversineMeters(from, to) * 10) / 10,
      openlr_route: null,
      route: {
        type: "LineString",
        coordinates: [
          [from.lng, from.lat],
          [to.lng, to.lat],
        ],
      },
    });
    return [
      200,
      {
        delivery_id: job.delivery_id,
        courier_id: job.courier?.courier_id ?? "cor_unassigned",
        legs: [leg(start, pickup, "way_pickup"), leg(pickup, dropoff, "way_dropoff")],
      },
    ];
  }

  function nearbyCount(query: URLSearchParams): [number, unknown] {
    const lat = Number(query.get("lat"));
    const lng = Number(query.get("lng"));
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      throw new HttpError(400, "validation_error", "lat and lng are required");
    }
    const radius = Number(query.get("radius_m") ?? 1000);
    const busy = [...state.jobs.values()].filter((job) => !isTerminalStatus(job.status)).length;
    return [200, { count: Math.max(0, 5 - busy), lat, lng, radius_m: radius }];
  }

  function advanceJob(jobId: string, body: unknown): [number, unknown] {
    const request = parse(AdvanceJobRequestSchema, body);
    const job = getJob(jobId);
    if (request.target_stage === "rejected" && !request.reject_reason) {
      throw new HttpError(400, "validation_error", "reject_reason is required for rejected");
    }
    const current = STAGE_ORDER.get(job.status) ?? 0;
    const target = STAGE_ORDER.get(request.target_stage) ?? 0;
    const forward = request.target_stage === "rejected" || target > current;
    if (isTerminalStatus(job.status) || !forward) {
      throw new HttpError(
        409,
        "invalid_state_transition",
        `Cannot move from ${job.status} to ${request.target_stage}`,
      );
    }
    const eventFor: Record<string, string> = {
      pickup_arrived: "arrived_pick_up",
      dropoff_en_route: "dropoff_en_route",
      dropoff_arrived: "dropoff_arrived",
      dropoff_complete: "dropoff_complete",
    };
    touch(job, request.target_stage, eventFor[request.target_stage]);
    return [200, publicJob(job)];
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  async function route(req: IncomingMessage): Promise<[number, unknown]> {
    const url = new URL(req.url ?? "/", "http://mock.local");
    const match = /^\/v2\/partners\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!match?.[2]) throw new HttpError(404, "not_found", "Unknown path");
    const path = match[2];

    if (options.apiKey && req.headers["x-api-key"] !== options.apiKey) {
      throw new HttpError(401, "unauthorized", "Invalid or missing API key");
    }

    const method = req.method ?? "GET";
    const body = method === "POST" ? await readBody(req) : undefined;
    const segments = path.split("/").filter(Boolean).map(decodeURIComponent);

    const [a, b, c, d] = segments;
    if (method === "POST" && a === "quotes" && segments.length === 1) return createQuote(body);
    if (a === "jobs" && segments.length === 1) {
      if (method === "POST") return createJob(body);
      if (method === "GET") return listJobs(url.searchParams);
    }
    if (a === "jobs" && b && segments.length === 2 && method === "GET")
      return [200, publicJob(getJob(b))];
    if (a === "jobs" && b && segments.length === 3) {
      if (method === "POST" && c === "cancel") return cancelJob(b, body);
      if (method === "POST" && c === "unlock") return unlockJob(b);
      if (method === "GET" && c === "route") return jobRoute(b);
    }
    if (method === "GET" && a === "robots" && b === "nearby_count")
      return nearbyCount(url.searchParams);
    if (method === "POST" && a === "simulated_fleet" && b === "jobs" && c && d === "advance") {
      return advanceJob(c, body);
    }
    throw new HttpError(404, "not_found", `No route for ${method} ${path}`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const [status, payload] = await route(req);
      send(res, status, payload);
    } catch (error) {
      if (error instanceof HttpError && error.status === -1) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        send(res, error.status, { code: error.code, detail: error.detail });
        return;
      }
      send(res, 500, { code: "internal_error", detail: "Mock server error" });
    }
  }

  const server: Server = createHttpServer((req, res) => {
    void handle(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://${address.address}:${address.port}`,
    state,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const MAX_BODY_BYTES = 1_000_000;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Body too large");
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }
}
