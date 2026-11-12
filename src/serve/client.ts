/**
 * Typed client for the Serve AV Delivery API (v2).
 *
 * - Auth via the X-API-Key header (omitted in mock mode when no key is set).
 * - Per-request timeouts.
 * - Retries only for requests that are safe to repeat (GETs and quotes),
 *   honouring `retry-after` on 429s. Job creation is never retried here;
 *   see `dispatch` in the tools layer for duplicate-safe recovery.
 * - Every response body is validated with zod before it is returned.
 */
import type { z } from "zod";

import type { Logger } from "../logger.js";
import { ServeApiError, ServeTransportError } from "./errors.js";
import {
  ErrorResponseSchema,
  JobListResponseSchema,
  JobResponseSchema,
  JobRouteResponseSchema,
  NearbyRobotsResponseSchema,
  QuoteResponseSchema,
  type AdvanceJobRequest,
  type CancelJobRequest,
  type CreateJobRequest,
  type CreateQuoteRequest,
  type JobResponse,
  type JobRouteResponse,
  type NearbyRobotsResponse,
  type QuoteResponse,
} from "./schemas.js";

export interface ServeClientOptions {
  baseUrl: string;
  partnerId: string;
  apiKey?: string | undefined;
  timeoutMs: number;
  logger: Logger;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injected for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts for retryable requests (including the first). */
  maxAttempts?: number;
}

type Query = Record<string, string | number | boolean | undefined>;

interface RequestSpec<T> {
  method: "GET" | "POST";
  path: string;
  schema: z.ZodType<T>;
  query?: Query;
  body?: unknown;
  /** Whether the request is safe to repeat automatically. */
  retryable: boolean;
}

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 10_000;
const BASE_BACKOFF_MS = 500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class ServeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;

  constructor(private readonly options: ServeClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  countNearbyRobots(params: {
    lat: number;
    lng: number;
    radiusM?: number | undefined;
  }): Promise<NearbyRobotsResponse> {
    return this.request({
      method: "GET",
      path: "/robots/nearby_count",
      query: { lat: params.lat, lng: params.lng, radius_m: params.radiusM },
      schema: NearbyRobotsResponseSchema,
      retryable: true,
    });
  }

  /** Quotes reserve nothing, so they are safe to retry. */
  createQuote(body: CreateQuoteRequest): Promise<QuoteResponse> {
    return this.request({
      method: "POST",
      path: "/quotes",
      body,
      schema: QuoteResponseSchema,
      retryable: true,
    });
  }

  /** Never retried automatically: a repeated call could dispatch twice. */
  createJob(body: CreateJobRequest): Promise<JobResponse> {
    return this.request({
      method: "POST",
      path: "/jobs",
      body,
      schema: JobResponseSchema,
      retryable: false,
    });
  }

  getJob(jobId: string): Promise<JobResponse> {
    return this.request({
      method: "GET",
      path: `/jobs/${encodeURIComponent(jobId)}`,
      schema: JobResponseSchema,
      retryable: true,
    });
  }

  listJobs(
    params: {
      active?: boolean | undefined;
      offset?: number | undefined;
      limit?: number | undefined;
      createdSince?: string | undefined;
    } = {},
  ): Promise<JobResponse[]> {
    return this.request({
      method: "GET",
      path: "/jobs",
      query: {
        active: params.active,
        offset: params.offset,
        limit: params.limit,
        created_since: params.createdSince,
      },
      schema: JobListResponseSchema,
      retryable: true,
    });
  }

  cancelJob(jobId: string, body: CancelJobRequest): Promise<JobResponse> {
    return this.request({
      method: "POST",
      path: `/jobs/${encodeURIComponent(jobId)}/cancel`,
      body,
      schema: JobResponseSchema,
      retryable: false,
    });
  }

  unlockJob(jobId: string): Promise<JobResponse> {
    return this.request({
      method: "POST",
      path: `/jobs/${encodeURIComponent(jobId)}/unlock`,
      schema: JobResponseSchema,
      retryable: false,
    });
  }

  getJobRoute(jobId: string): Promise<JobRouteResponse> {
    return this.request({
      method: "GET",
      path: `/jobs/${encodeURIComponent(jobId)}/route`,
      schema: JobRouteResponseSchema,
      retryable: true,
    });
  }

  advanceSimulatedJob(jobId: string, body: AdvanceJobRequest): Promise<JobResponse> {
    return this.request({
      method: "POST",
      path: `/simulated_fleet/jobs/${encodeURIComponent(jobId)}/advance`,
      body,
      schema: JobResponseSchema,
      retryable: false,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildUrl(path: string, query?: Query): URL {
    const partner = encodeURIComponent(this.options.partnerId);
    const url = new URL(`${this.options.baseUrl}/v2/partners/${partner}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private headers(hasBody: boolean): Headers {
    const headers = new Headers({ accept: "application/json" });
    if (hasBody) headers.set("content-type", "application/json");
    if (this.options.apiKey) headers.set("x-api-key", this.options.apiKey);
    return headers;
  }

  private async request<T>(spec: RequestSpec<T>): Promise<T> {
    const attempts = spec.retryable ? this.maxAttempts : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.send(spec);
      } catch (error) {
        lastError = error;
        const delay = this.retryDelay(error, attempt);
        if (attempt >= attempts || delay === undefined) throw error;
        this.options.logger.warn("Retrying Serve request", {
          method: spec.method,
          path: spec.path,
          attempt,
          delayMs: delay,
        });
        await this.sleep(delay);
      }
    }
    // Unreachable: the loop either returns or throws.
    throw lastError;
  }

  /** Returns the delay before the next attempt, or undefined if the error isn't retryable. */
  private retryDelay(error: unknown, attempt: number): number | undefined {
    const backoff = Math.min(MAX_RETRY_DELAY_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
    if (error instanceof ServeTransportError) return backoff;
    if (error instanceof ServeApiError && RETRYABLE_STATUSES.has(error.status)) {
      if (error.retryAfterSeconds !== undefined) {
        return Math.min(MAX_RETRY_DELAY_MS, error.retryAfterSeconds * 1000);
      }
      return backoff;
    }
    return undefined;
  }

  private async send<T>(spec: RequestSpec<T>): Promise<T> {
    const url = this.buildUrl(spec.path, spec.query);
    const hasBody = spec.body !== undefined;
    const started = Date.now();

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: spec.method,
        headers: this.headers(hasBody),
        body: hasBody ? JSON.stringify(spec.body) : null,
        signal: AbortSignal.timeout(this.options.timeoutMs),
        redirect: "error",
      });
    } catch (cause) {
      const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
      throw new ServeTransportError(
        timedOut ? `request timed out after ${this.options.timeoutMs} ms` : "network error",
        true,
        { cause },
      );
    }

    this.options.logger.debug("Serve response", {
      method: spec.method,
      path: spec.path,
      status: response.status,
      ms: Date.now() - started,
    });

    const payload = await this.readJson(response);

    if (!response.ok) {
      const parsed = ErrorResponseSchema.safeParse(payload);
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new ServeApiError(
        response.status,
        parsed.success ? parsed.data.code : `http_${response.status}`,
        parsed.success ? parsed.data.detail : response.statusText || "Request failed",
        Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
      );
    }

    const parsed = spec.schema.safeParse(payload);
    if (!parsed.success) {
      throw new ServeTransportError("Serve returned a response in an unexpected format", true, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      if (!response.ok) return undefined;
      throw new ServeTransportError("Serve returned invalid JSON", true, { cause });
    }
  }
}
