/**
 * Remembers quotes issued in this session.
 *
 * Binding the priced pickup/dropoff to the quote_id on the server side means
 * the assistant can only dispatch exactly what the user approved: it cannot
 * swap in a different address or claim a lower fee.
 */
import type { QuoteWaypointSchema } from "../serve/schemas.js";
import type { z } from "zod";

export type QuotedWaypoint = z.infer<typeof QuoteWaypointSchema>;

export interface CachedQuote {
  readonly quoteId: string;
  readonly pickup: QuotedWaypoint;
  readonly dropoff: QuotedWaypoint;
  readonly feeCents: number;
  readonly currency: string;
  readonly expiresAt: Date;
}

export type QuoteLookup =
  | { readonly status: "ok"; readonly quote: CachedQuote }
  | { readonly status: "unknown" }
  | { readonly status: "expired" }
  | { readonly status: "used" };

const MAX_ENTRIES = 200;

export class QuoteCache {
  private readonly quotes = new Map<string, CachedQuote>();
  private readonly used = new Set<string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  add(quote: CachedQuote): void {
    this.prune();
    this.quotes.set(quote.quoteId, quote);
  }

  lookup(quoteId: string): QuoteLookup {
    if (this.used.has(quoteId)) return { status: "used" };
    const quote = this.quotes.get(quoteId);
    if (!quote) return { status: "unknown" };
    if (quote.expiresAt.getTime() <= this.now().getTime()) return { status: "expired" };
    return { status: "ok", quote };
  }

  /** Mark a quote as spent so it can't be dispatched twice from this session. */
  markUsed(quoteId: string): void {
    this.quotes.delete(quoteId);
    this.used.add(quoteId);
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [id, quote] of this.quotes) {
      if (quote.expiresAt.getTime() <= now) this.quotes.delete(id);
    }
    // Hard bound on memory in long-running sessions.
    while (this.quotes.size >= MAX_ENTRIES) {
      const oldest = this.quotes.keys().next().value;
      if (oldest === undefined) break;
      this.quotes.delete(oldest);
    }
    if (this.used.size > MAX_ENTRIES * 5) this.used.clear();
  }
}
