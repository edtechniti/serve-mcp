import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DROPOFF, PICKUP, details, startHarness, text, type Harness } from "./helpers.js";

interface QuoteDetails {
  quote_id: string;
  fee_cents: number;
}
interface JobDetails {
  delivery_id: string;
  status: string;
}

describe("MCP server against the mock Serve API", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  async function quote(): Promise<QuoteDetails> {
    const result = await h.call("get_delivery_quote", { pickup: PICKUP, dropoff: DROPOFF });
    expect(result.isError).toBeFalsy();
    return details<QuoteDetails>(result);
  }

  async function dispatch(quoteId: string): Promise<JobDetails> {
    const result = await h.call("dispatch_robot", {
      quote_id: quoteId,
      confirmed: true,
      items: [{ name: "Coffee", quantity: 2 }],
      recipient_name: "Alex",
      recipient_phone: "+1 555 010 0000",
    });
    expect(result.isError, text(result)).toBeFalsy();
    return details<JobDetails>(result);
  }

  it("lists every tool, including the simulator in mock mode", async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancel_delivery",
      "check_robot_availability",
      "dispatch_robot",
      "get_delivery_quote",
      "get_delivery_route",
      "list_deliveries",
      "simulate_delivery_progress",
      "track_delivery",
      "unlock_robot_bin",
    ]);
    const dispatchTool = tools.find((t) => t.name === "dispatch_robot");
    expect(dispatchTool?.annotations?.readOnlyHint).toBe(false);
  });

  it("runs the full lifecycle: quote → dispatch → track → unlock → complete", async () => {
    const q = await quote();
    expect(q.fee_cents).toBeGreaterThan(0);

    const job = await dispatch(q.quote_id);
    expect(job.status).toBe("pickup_en_route");

    for (const stage of ["pickup_arrived", "dropoff_en_route", "dropoff_arrived"]) {
      const r = await h.call("simulate_delivery_progress", {
        delivery_id: job.delivery_id,
        target_stage: stage,
      });
      expect(r.isError, text(r)).toBeFalsy();
    }

    const tracked = await h.call("track_delivery", { delivery_id: job.delivery_id });
    expect(text(tracked)).toContain("ready to unlock");
    expect(text(tracked)).not.toContain("courier_unlock_code");

    const unlocked = await h.call("unlock_robot_bin", { delivery_id: job.delivery_id });
    expect(unlocked.isError).toBeFalsy();

    const done = await h.call("simulate_delivery_progress", {
      delivery_id: job.delivery_id,
      target_stage: "dropoff_complete",
    });
    expect(details<JobDetails>(done).status).toBe("dropoff_complete");

    const active = await h.call("list_deliveries", {});
    expect(text(active)).toBe("No active deliveries.");
  });

  it("refuses to dispatch without explicit confirmation", async () => {
    const q = await quote();
    const result = await h.call("dispatch_robot", {
      quote_id: q.quote_id,
      confirmed: false,
      items: [{ name: "Coffee", quantity: 1 }],
      recipient_name: "Alex",
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/explicit yes/);
    expect(h.mock.state.jobs.size).toBe(0);
  });

  it("refuses unknown and reused quotes", async () => {
    const unknown = await h.call("dispatch_robot", {
      quote_id: "qte_made_up",
      confirmed: true,
      items: [{ name: "Coffee", quantity: 1 }],
      recipient_name: "Alex",
    });
    expect(text(unknown)).toMatch(/Unknown quote_id/);

    const q = await quote();
    await dispatch(q.quote_id);
    const again = await h.call("dispatch_robot", {
      quote_id: q.quote_id,
      confirmed: true,
      items: [{ name: "Coffee", quantity: 1 }],
      recipient_name: "Alex",
    });
    expect(text(again)).toMatch(/already dispatched/);
    expect(h.mock.state.jobs.size).toBe(1);
  });

  it("enforces the fee cap", async () => {
    await h.close();
    h = await startHarness({ SERVE_MAX_FEE_CENTS: "100" });
    const result = await h.call("get_delivery_quote", { pickup: PICKUP, dropoff: DROPOFF });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/exceeds this server's limit/);
  });

  it("turns Serve rejections into actionable messages", async () => {
    const busy = await h.call("get_delivery_quote", {
      pickup: PICKUP,
      dropoff: DROPOFF,
      simulate_rejection: "couriers_busy",
    });
    expect(busy.isError).toBe(true);
    expect(text(busy)).toMatch(/No robot is free/);
    expect(text(busy)).toMatch(/retried later/);

    const far = await h.call("get_delivery_quote", {
      pickup: PICKUP,
      dropoff: { ...DROPOFF, street_address_1: "1 Far Away Rd" },
    });
    expect(text(far)).toMatch(/too far apart/);
  });

  it("uses provided coordinates without geocoding", async () => {
    const result = await h.call("get_delivery_quote", {
      pickup: { ...PICKUP, lat: 34.05, lng: -118.24 },
      dropoff: { ...DROPOFF, lat: 34.051, lng: -118.241 },
    });
    expect(result.isError).toBeFalsy();
    expect(h.geocoder.calls).toBe(0);
  });

  it("recovers from a lost dispatch response without creating a duplicate", async () => {
    const q = await quote();
    h.mock.state.dropNextJobResponses = 1;
    const job = await dispatch(q.quote_id);
    expect(job.delivery_id).toMatch(/^del_/);
    expect(h.mock.state.jobs.size).toBe(1);
  });

  it("explains why the bin can't be unlocked yet", async () => {
    const job = await dispatch((await quote()).quote_id);
    const result = await h.call("unlock_robot_bin", { delivery_id: job.delivery_id });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/hasn't arrived/);
  });

  it("cancels an active delivery, and not a finished one", async () => {
    const job = await dispatch((await quote()).quote_id);
    const canceled = await h.call("cancel_delivery", { delivery_id: job.delivery_id });
    expect(details<JobDetails>(canceled).status).toBe("canceled");

    const again = await h.call("cancel_delivery", { delivery_id: job.delivery_id });
    expect(text(again)).toMatch(/already finished/);
  });

  it("returns route summaries, with geometry on request", async () => {
    const job = await dispatch((await quote()).quote_id);
    const plain = await h.call("get_delivery_route", { delivery_id: job.delivery_id });
    expect(text(plain)).toMatch(/2 leg\(s\)/);
    expect(text(plain)).not.toContain("LineString");

    const withGeometry = await h.call("get_delivery_route", {
      delivery_id: job.delivery_id,
      include_geometry: true,
    });
    expect(text(withGeometry)).toContain("LineString");
  });

  it("reports robot availability", async () => {
    const result = await h.call("check_robot_availability", { location: PICKUP });
    expect(text(result)).toMatch(/robot\(s\) on duty/);
  });

  it("reports unknown deliveries clearly", async () => {
    const result = await h.call("track_delivery", { delivery_id: "del_missing" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/couldn't find/);
  });
});
