/**
 * Address → coordinates.
 *
 * Serve requires both a postal address and lat/lng for every waypoint, and
 * language models are unreliable at producing coordinates, so the server
 * resolves them itself unless the caller supplies them.
 */
import type { Logger } from "../logger.js";
import type { Address, LatLng } from "../serve/schemas.js";

export interface GeocodeResult {
  readonly location: LatLng;
  /** Human-readable description of what the geocoder matched. */
  readonly displayName: string;
}

export interface Geocoder {
  geocode(address: Address): Promise<GeocodeResult>;
}

export class GeocodingError extends Error {
  override readonly name = "GeocodingError";
}

/** Used when GEOCODER=none: callers must provide coordinates. */
export class DisabledGeocoder implements Geocoder {
  geocode(): Promise<GeocodeResult> {
    return Promise.reject(
      new GeocodingError(
        "Geocoding is disabled (GEOCODER=none). Provide lat/lng for each address.",
      ),
    );
  }
}

export interface NominatimOptions {
  userAgent: string;
  logger: Logger;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Nominatim's usage policy allows at most one request per second. */
const NOMINATIM_MIN_INTERVAL_MS = 1100;

/**
 * OpenStreetMap Nominatim geocoder.
 * Respects the public usage policy: identifying User-Agent and ≤1 req/s.
 */
export class NominatimGeocoder implements Geocoder {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: NominatimOptions) {
    this.endpoint = options.endpoint ?? "https://nominatim.openstreetmap.org/search";
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  geocode(address: Address): Promise<GeocodeResult> {
    // Serialise requests so the rate limit holds under concurrent tool calls.
    const run = this.queue.then(() => this.lookup(address));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async lookup(address: Address): Promise<GeocodeResult> {
    const wait = this.lastRequestAt + NOMINATIM_MIN_INTERVAL_MS - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();

    const url = new URL(this.endpoint);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("street", address.street_address_1);
    url.searchParams.set("city", address.city);
    url.searchParams.set("state", address.state);
    url.searchParams.set("postalcode", address.zip_code);
    url.searchParams.set("country", address.country);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { "user-agent": this.options.userAgent, accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (cause) {
      throw new GeocodingError("Couldn't reach the geocoding service.", { cause });
    }
    if (!response.ok) {
      throw new GeocodingError(`Geocoding service returned HTTP ${response.status}.`);
    }

    const results: unknown = await response.json();
    const first: unknown = Array.isArray(results) ? results[0] : undefined;
    const match = parseNominatimResult(first);
    if (!match) {
      throw new GeocodingError(
        "Couldn't find that address. Check it, or provide lat/lng explicitly.",
      );
    }
    this.options.logger.debug("Geocoded address", { city: address.city });
    return match;
  }
}

function parseNominatimResult(value: unknown): GeocodeResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const lat = Number(record.lat);
  const lng = Number(record.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  const displayName = typeof record.display_name === "string" ? record.display_name : "";
  return { location: { lat, lng }, displayName };
}
