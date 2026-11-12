/**
 * Error types raised by the Serve client, plus a mapping from Serve error
 * codes to guidance an assistant can act on.
 */

/** The Serve API answered with a non-success status. */
export class ServeApiError extends Error {
  override readonly name = "ServeApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Serve API error ${status} (${code}): ${detail}`);
  }
}

/** The request never produced a usable response (network failure, timeout, bad JSON). */
export class ServeTransportError extends Error {
  override readonly name = "ServeTransportError";

  constructor(
    message: string,
    /** True when the request may have reached Serve before failing. */
    readonly mayHaveReachedServer: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ErrorGuidance {
  /** Plain-English explanation suitable to relay to the user. */
  readonly message: string;
  /** Whether trying again later could reasonably succeed. */
  readonly retryable: boolean;
}

const CODE_GUIDANCE: Record<string, ErrorGuidance> = {
  couriers_busy: {
    message: "No robot is free near the pickup right now. Try again in a few minutes.",
    retryable: true,
  },
  outside_operating_hours: {
    message: "Serve isn't operating at that location at this time.",
    retryable: false,
  },
  pickup_untraversable: {
    message: "Robots can't reach the pickup location. Try a nearby address on a sidewalk.",
    retryable: false,
  },
  dropoff_untraversable: {
    message: "Robots can't reach the dropoff location. Try a nearby address on a sidewalk.",
    retryable: false,
  },
  delivery_distance_exceeds_limit: {
    message: "Pickup and dropoff are too far apart for a sidewalk robot.",
    retryable: false,
  },
  pickup_deadline_unreachable: {
    message: "A robot can't reach the pickup before the requested deadline.",
    retryable: false,
  },
  dropoff_deadline_unreachable: {
    message: "A robot can't reach the dropoff before the requested deadline.",
    retryable: false,
  },
  used_quote: {
    message: "That quote has already been used. Get a new quote.",
    retryable: false,
  },
  mismatched_quote: {
    message: "The delivery details don't match the quote. Get a new quote.",
    retryable: false,
  },
  noncancelable_delivery: {
    message: "That delivery has already finished and can't be canceled.",
    retryable: false,
  },
  not_arrived_at_dropoff: {
    message: "The robot hasn't arrived at the dropoff yet, so the bin can't be unlocked.",
    retryable: true,
  },
  no_courier_assigned: {
    message: "No robot has been assigned to this delivery yet.",
    retryable: true,
  },
  invalid_state_transition: {
    message: "The delivery can't move to that stage from its current status.",
    retryable: false,
  },
};

const STATUS_GUIDANCE: Record<number, ErrorGuidance> = {
  401: { message: "Serve rejected the credentials. Check SERVE_API_KEY.", retryable: false },
  403: { message: "This account isn't allowed to perform that action.", retryable: false },
  404: { message: "Serve couldn't find that delivery or resource.", retryable: false },
  429: { message: "Serve's rate limit was hit. Wait a moment and retry.", retryable: true },
  503: { message: "Serve has no robot capacity right now. Try again shortly.", retryable: true },
};

export function describeError(error: unknown): ErrorGuidance {
  if (error instanceof ServeApiError) {
    const byCode = CODE_GUIDANCE[error.code];
    if (byCode) return byCode;
    const byStatus = STATUS_GUIDANCE[error.status];
    if (byStatus) return byStatus;
    return {
      message: `Serve returned an error (${error.status} ${error.code}): ${error.detail}`,
      retryable: error.status >= 500,
    };
  }
  if (error instanceof ServeTransportError) {
    return { message: `Couldn't reach Serve: ${error.message}`, retryable: true };
  }
  if (error instanceof Error) return { message: error.message, retryable: false };
  return { message: "An unexpected error occurred.", retryable: false };
}
