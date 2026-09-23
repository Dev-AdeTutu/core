import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  subscribeContractEvents,
  streamContractEvents,
  DEFAULT_RECOVERY_WINDOW_MS,
  type ContractEvent,
} from "../soroban/subscribeContractEvents";

/**
 * Helper to build a Horizon /ledgers list response.
 * The poll code reads `payload._embedded.records[0].sequence` and
 * `readRecords(payload)` which uses `payload._embedded.records`.
 *
 * Each record includes both ledger metadata (sequence) and event data
 * (id, contractId, name, topics, etc.) so both extraction paths work.
 */
function ledgerListResponse(
  sequence: number,
  events: ContractEvent[] = [],
) {
  // When there are no events, still include a ledger record so the
  // sequence can be extracted. readRecords will parse it but the
  // contractId filter will discard non-event records.
  const records =
    events.length > 0
      ? events.map((e) => ({
          sequence,
          id: e.id,
          contractId: e.contractId,
          name: e.name,
          topics: e.topics ?? [],
          value: e.value ?? {},
          ledger: e.ledger ?? sequence,
          ...e,
        }))
      : [{ sequence }];
  return { _embedded: { records } };
}

/**
 * Helper for individual ledger endpoint /ledgers/{seq} used by recovery.
 */
function ledgerDetailResponse(sequence: number, events: ContractEvent[] = []) {
  return {
    _embedded: {
      records: events.map((e) => ({
        sequence,
        id: e.id,
        contractId: e.contractId,
        name: e.name,
        topics: e.topics ?? [],
        value: e.value ?? {},
        ledger: e.ledger ?? sequence,
        ...e,
      })),
    },
  };
}

/**
 * Helper to build an event object for testing.
 */
function makeEvent(
  id: string,
  contractId: string,
  name: string,
  ledger: number,
): ContractEvent {
  return { id, contractId, name, topics: [], value: {}, ledger };
}

// ---------------------------------------------------------------------------
// subscribeContractEvents – recovery tests
// ---------------------------------------------------------------------------

describe("subscribeContractEvents – event recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not trigger recovery when ledgers are consecutive", async () => {
    const callback = vi.fn();
    const fetchMock = vi.fn()
      // First poll: ledger 100
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ledgerListResponse(100, [makeEvent("e1", "C1", "transfer", 100)]),
      })
      // Second poll: ledger 101 (consecutive – no gap)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ledgerListResponse(101, [makeEvent("e2", "C1", "transfer", 101)]),
      })
      .mockResolvedValue({ ok: true, json: async () => ledgerListResponse(102) });

    const unsub = subscribeContractEvents("C1", undefined, callback, {
      horizonUrl: "http://localhost",
      intervalMs: 1,
      fetch: fetchMock,
    });

    // First poll
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith([
      expect.objectContaining({ id: "e1" }),
    ]);

    // Second poll – no gap, no recovery fetches expected
    await vi.advanceTimersByTimeAsync(1);

    // Should not have fetched individual ledger recovery URLs
    const recoveryCalls = fetchMock.mock.calls.filter(
      (call: [string, ...unknown[]]) =>
        typeof call[0] === "string" && /\/ledgers\/\d+/.test(call[0]),
    );
    expect(recoveryCalls.length).toBe(0);

    unsub();
  });

  it("recovers missed events when a ledger gap is detected", async () => {
    const callback = vi.fn();
    let pollCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      // Recovery: individual ledger endpoints
      if (/\/ledgers\/\d+$/.test(url)) {
        if (url.includes("/101")) {
          return {
            ok: true,
            json: async () => ledgerDetailResponse(101, [makeEvent("e-missed-1", "C1", "transfer", 101)]),
          };
        }
        if (url.includes("/102")) {
          return {
            ok: true,
            json: async () => ledgerDetailResponse(102, [makeEvent("e-missed-2", "C1", "transfer", 102)]),
          };
        }
        // Any other individual ledger (e.g. 103) returns empty
        return { ok: true, json: async () => ledgerDetailResponse(0) };
      }
      // List endpoint: /ledgers?order=desc&limit=1
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, json: async () => ledgerListResponse(100, [makeEvent("e1", "C1", "transfer", 100)]) };
      }
      // After reconnection: ledger jumped from 100 to 103
      return { ok: true, json: async () => ledgerListResponse(103, [makeEvent("e3", "C1", "transfer", 103)]) };
    });

    const unsub = subscribeContractEvents("C1", undefined, callback, {
      horizonUrl: "http://localhost",
      intervalMs: 1,
      fetch: fetchMock,
    });

    // First poll – ledger 100
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith([
      expect.objectContaining({ id: "e1" }),
    ]);

    // Second poll – ledger 103 (gap: 101, 102 missed)
    await vi.advanceTimersByTimeAsync(1);

    // Collect all events from all callback invocations
    const allCalls = callback.mock.calls;
    const allEvents = allCalls
      .flat(2)
      .filter((e: unknown) => e && typeof e === "object" && "id" in (e as Record<string, unknown>)) as ContractEvent[];
    const eventIds = allEvents.map((e) => e.id);

    // Should include recovered events and current event
    expect(eventIds).toContain("e-missed-1");
    expect(eventIds).toContain("e-missed-2");
    expect(eventIds).toContain("e3");

    unsub();
  });

  it("preserves ordering of recovered events", async () => {
    const callback = vi.fn();
    let pollCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (/\/ledgers\/\d+$/.test(url)) {
        if (url.includes("/101")) {
          return {
            ok: true,
            json: async () => ledgerDetailResponse(101, [makeEvent("e-b", "C1", "transfer", 101)]),
          };
        }
        if (url.includes("/102")) {
          return {
            ok: true,
            json: async () => ledgerDetailResponse(102, [makeEvent("e-c", "C1", "transfer", 102)]),
          };
        }
        return { ok: true, json: async () => ledgerDetailResponse(0) };
      }
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, json: async () => ledgerListResponse(100, [makeEvent("e-a", "C1", "transfer", 100)]) };
      }
      return { ok: true, json: async () => ledgerListResponse(103, [makeEvent("e-d", "C1", "transfer", 103)]) };
    });

    const unsub = subscribeContractEvents("C1", undefined, callback, {
      horizonUrl: "http://localhost",
      intervalMs: 1,
      fetch: fetchMock,
    });

    // First poll – ledger 100
    await vi.advanceTimersByTimeAsync(1);

    // Second poll – gap detected
    await vi.advanceTimersByTimeAsync(1);

    // Collect all events in order
    const allEvents = callback.mock.calls
      .flat(2)
      .filter((e: unknown) => e && typeof e === "object" && "id" in (e as Record<string, unknown>)) as ContractEvent[];
    const eventIds = allEvents.map((e) => e.id);

    // Recovery events should appear in ledger order, then current events
    expect(eventIds).toEqual(["e-a", "e-b", "e-c", "e-d"]);

    unsub();
  });

  it("suppresses duplicate events during recovery replay", async () => {
    const callback = vi.fn();
    let pollCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (/\/ledgers\/\d+$/.test(url)) {
        if (url.includes("/101")) {
          // Ledger 101 has event that was already seen
          return {
            ok: true,
            json: async () => ledgerDetailResponse(101, [makeEvent("e-dup", "C1", "transfer", 101)]),
          };
        }
        return { ok: true, json: async () => ledgerDetailResponse(0) };
      }
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, json: async () => ledgerListResponse(100, [makeEvent("e-dup", "C1", "transfer", 100)]) };
      }
      return { ok: true, json: async () => ledgerListResponse(102, [makeEvent("e-new", "C1", "transfer", 102)]) };
    });

    const unsub = subscribeContractEvents("C1", undefined, callback, {
      horizonUrl: "http://localhost",
      intervalMs: 1,
      fetch: fetchMock,
    });

    // First poll – sees e-dup at ledger 100
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledWith([expect.objectContaining({ id: "e-dup" })]);

    // Second poll – gap, recovery finds e-dup again at ledger 101
    await vi.advanceTimersByTimeAsync(1);

    // Count how many times e-dup appeared across all callback calls
    const allEvents = callback.mock.calls
      .flat(2)
      .filter((e: unknown) => e && typeof e === "object" && "id" in (e as Record<string, unknown>)) as ContractEvent[];
    const dupCount = allEvents.filter((e) => e.id === "e-dup").length;

    // e-dup should only appear once (deduplicated)
    expect(dupCount).toBe(1);

    unsub();
  });

  it("respects configurable recoveryWindowMs", async () => {
    const callback = vi.fn();
    let pollCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (/\/ledgers\/\d+$/.test(url)) {
        // Recovery: return empty for any individual ledger
        return { ok: true, json: async () => ledgerDetailResponse(0) };
      }
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, json: async () => ledgerListResponse(100) };
      }
      // Large gap: from 100 to 120
      return { ok: true, json: async () => ledgerListResponse(120) };
    });

    const unsub = subscribeContractEvents("C1", undefined, callback, {
      horizonUrl: "http://localhost",
      intervalMs: 1,
      fetch: fetchMock,
      // Small recovery window: only ~5.5s per ledger, so 11000ms ≈ 2 ledgers
      recoveryWindowMs: 11000,
    });

    // First poll – ledger 100
    await vi.advanceTimersByTimeAsync(1);

    // Second poll – gap from 100 to 120
    await vi.advanceTimersByTimeAsync(1);

    // The recovery should not fetch all 20 missed ledgers, only ~2
    const ledgerFetchCalls = fetchMock.mock.calls.filter(
      (call: [string, ...unknown[]]) =>
        typeof call[0] === "string" && /\/ledgers\/\d+$/.test(call[0]),
    );

    // maxRecoveryLedgers = ceil(11000 / 5500) = 2
    // fromLedger = max(100, 120-2) = 118
    // Recovery fetches ledgers 119, 120 (fromLedger+1 to latestSequence)
    expect(ledgerFetchCalls.length).toBeLessThanOrEqual(3);

    unsub();
  });

  it("handles recovery failure gracefully", async () => {
    const callback = vi.fn();
    let pollCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (/\/ledgers\/\d+$/.test(url)) {
        // Recovery fetch fails
        throw new Error("Network error");
      }
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, json: async () => ledgerListResponse(100, [makeEvent("e1", "C1", "transfer", 100)]) };
      }
      return { ok: true, json: async () => ledgerListResponse(103, [makeEvent("e3", "C1", "transfer", 103)]) };
    });

    const unsub = subscribeContractEvents("C1", undefined, callback, {
      horizonUrl: "http://localhost",
      intervalMs: 1,
      fetch: fetchMock,
    });

    // First poll – ledger 100
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);

    // Second poll – gap, recovery fails but poll continues
    await vi.advanceTimersByTimeAsync(1);

    // Should still process current ledger events even though recovery failed
    const allEvents = callback.mock.calls
      .flat(2)
      .filter((e: unknown) => e && typeof e === "object" && "id" in (e as Record<string, unknown>)) as ContractEvent[];
    expect(allEvents.some((e) => e.id === "e3")).toBe(true);

    unsub();
  });

  it("recovers events when gap is within recovery window boundary", async () => {
    const callback = vi.fn();
    let pollCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (/\/ledgers\/\d+$/.test(url)) {
        if (url.includes("/101")) {
          return {
            ok: true,
            json: async () => ledgerDetailResponse(101, [makeEvent("e-gap", "C1", "transfer", 101)]),
          };
        }
        return { ok: true, json: async () => ledgerDetailResponse(0) };
      }
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, json: async () => ledgerListResponse(100) };
      }
      // Small gap: only 1 ledger skipped
      return { ok: true, json: async () => ledgerListResponse(102, [makeEvent("e2", "C1", "transfer", 102)]) };
    });

    const unsub = subscribeContractEvents("C1", undefined, callback, {
      horizonUrl: "http://localhost",
      intervalMs: 1,
      fetch: fetchMock,
    });

    // First poll – ledger 100
    await vi.advanceTimersByTimeAsync(1);

    // Second poll – ledger 102 (gap includes 101)
    await vi.advanceTimersByTimeAsync(1);

    // Recovery should fetch the missed ledger 101
    const ledgerFetchCalls = fetchMock.mock.calls.filter(
      (call: [string, ...unknown[]]) =>
        typeof call[0] === "string" && /\/ledgers\/\d+$/.test(call[0]),
    );

    expect(ledgerFetchCalls.length).toBeGreaterThanOrEqual(1);

    // Should have the recovered event
    const allEvents = callback.mock.calls
      .flat(2)
      .filter((e: unknown) => e && typeof e === "object" && "id" in (e as Record<string, unknown>)) as ContractEvent[];
    const eventIds = allEvents.map((e) => e.id);
    expect(eventIds).toContain("e-gap");
    expect(eventIds).toContain("e2");

    unsub();
  });

  it("does not recover when no gap is detected after first poll", async () => {
    const callback = vi.fn();
    let pollCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (/\/ledgers\/\d+$/.test(url)) {
        return { ok: true, json: async () => ledgerDetailResponse(0) };
      }
      pollCount++;
      return { ok: true, json: async () => ledgerListResponse(100 + pollCount - 1) };
    });

    const unsub = subscribeContractEvents("C1", undefined, callback, {
      horizonUrl: "http://localhost",
      intervalMs: 1,
      fetch: fetchMock,
    });

    // First three polls – consecutive ledgers, no gaps
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);

    // No recovery fetches should be made
    const ledgerFetchCalls = fetchMock.mock.calls.filter(
      (call: [string, ...unknown[]]) =>
        typeof call[0] === "string" && /\/ledgers\/\d+$/.test(call[0]),
    );
    expect(ledgerFetchCalls.length).toBe(0);

    unsub();
  });

  it("filters recovered events through the provided filter", async () => {
    const callback = vi.fn();
    let pollCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (/\/ledgers\/\d+$/.test(url)) {
        if (url.includes("/101")) {
          return {
            ok: true,
            json: async () => ledgerDetailResponse(101, [
              makeEvent("e-transfer", "C1", "transfer", 101),
              makeEvent("e-mint", "C1", "mint", 101),
            ]),
          };
        }
        return { ok: true, json: async () => ledgerDetailResponse(0) };
      }
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, json: async () => ledgerListResponse(100, [makeEvent("e1", "C1", "transfer", 100)]) };
      }
      return { ok: true, json: async () => ledgerListResponse(102) };
    });

    const unsub = subscribeContractEvents(
      "C1",
      { name: "transfer" },
      callback,
      {
        horizonUrl: "http://localhost",
        intervalMs: 1,
        fetch: fetchMock,
      },
    );

    // First poll – ledger 100
    await vi.advanceTimersByTimeAsync(1);

    // Second poll – gap, recovery
    await vi.advanceTimersByTimeAsync(1);

    const allEvents = callback.mock.calls
      .flat(2)
      .filter((e: unknown) => e && typeof e === "object" && "id" in (e as Record<string, unknown>)) as ContractEvent[];

    // Only transfer events should be recovered, not mint
    expect(allEvents.some((e) => e.id === "e-transfer")).toBe(true);
    expect(allEvents.some((e) => e.id === "e-mint")).toBe(false);

    unsub();
  });

  it("DEFAULT_RECOVERY_WINDOW_MS is exported and has expected value", () => {
    expect(DEFAULT_RECOVERY_WINDOW_MS).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// streamContractEvents – recovery tests
// ---------------------------------------------------------------------------

describe("streamContractEvents – event recovery", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("recovers missed events in the stream after a gap", async () => {
    let pollCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (/\/ledgers\/\d+$/.test(url)) {
        if (url.includes("/101")) {
          return {
            ok: true,
            json: async () => ledgerDetailResponse(101, [makeEvent("e-missed", "C1", "transfer", 101)]),
          };
        }
        return { ok: true, json: async () => ledgerDetailResponse(0) };
      }
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, json: async () => ledgerListResponse(100, [makeEvent("e1", "C1", "transfer", 100)]) };
      }
      return { ok: true, json: async () => ledgerListResponse(102, [makeEvent("e2", "C1", "transfer", 102)]) };
    });

    const ac = new AbortController();
    const gen = streamContractEvents(
      "C1",
      undefined,
      { horizonUrl: "http://localhost", intervalMs: 10, fetch: fetchMock },
      ac.signal,
    );

    // First iteration – ledger 100
    const r1 = await gen.next();
    expect(r1.done).toBe(false);
    expect(r1.value).toHaveLength(1);
    expect(r1.value[0].id).toBe("e1");

    // Second iteration – gap detected, recovery + current ledger
    const r2 = await gen.next();
    expect(r2.done).toBe(false);

    // Should have recovered event + current event
    const eventIds = r2.value.map((e: ContractEvent) => e.id);
    expect(eventIds).toContain("e-missed");
    expect(eventIds).toContain("e2");

    ac.abort();
  });

  it("preserves ordering in stream recovery", async () => {
    let pollCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (/\/ledgers\/\d+$/.test(url)) {
        if (url.includes("/101")) {
          return {
            ok: true,
            json: async () => ledgerDetailResponse(101, [makeEvent("e-b", "C1", "transfer", 101)]),
          };
        }
        return { ok: true, json: async () => ledgerDetailResponse(0) };
      }
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, json: async () => ledgerListResponse(100, [makeEvent("e-a", "C1", "transfer", 100)]) };
      }
      return { ok: true, json: async () => ledgerListResponse(102, [makeEvent("e-c", "C1", "transfer", 102)]) };
    });

    const ac = new AbortController();
    const gen = streamContractEvents(
      "C1",
      undefined,
      { horizonUrl: "http://localhost", intervalMs: 10, fetch: fetchMock },
      ac.signal,
    );

    // First iteration
    const r1 = await gen.next();
    expect(r1.value[0].id).toBe("e-a");

    // Second iteration – recovery + current
    const r2 = await gen.next();
    const ids = r2.value.map((e: ContractEvent) => e.id);

    // Recovery events should come before current events
    expect(ids).toEqual(["e-b", "e-c"]);

    ac.abort();
  });

  it("suppresses duplicates in stream recovery", async () => {
    let pollCount = 0;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (/\/ledgers\/\d+$/.test(url)) {
        if (url.includes("/101")) {
          return {
            ok: true,
            json: async () => ledgerDetailResponse(101, [makeEvent("e-dup", "C1", "transfer", 101)]),
          };
        }
        return { ok: true, json: async () => ledgerDetailResponse(0) };
      }
      pollCount++;
      if (pollCount === 1) {
        return { ok: true, json: async () => ledgerListResponse(100, [makeEvent("e-dup", "C1", "transfer", 100)]) };
      }
      return { ok: true, json: async () => ledgerListResponse(102, [makeEvent("e-new", "C1", "transfer", 102)]) };
    });

    const ac = new AbortController();
    const gen = streamContractEvents(
      "C1",
      undefined,
      { horizonUrl: "http://localhost", intervalMs: 10, fetch: fetchMock },
      ac.signal,
    );

    // First iteration – sees e-dup
    const r1 = await gen.next();
    expect(r1.value).toHaveLength(1);
    expect(r1.value[0].id).toBe("e-dup");

    // Second iteration – recovery has e-dup again but should be deduped
    const r2 = await gen.next();

    const allEvents = [...r1.value, ...r2.value];
    const dupCount = allEvents.filter((e: ContractEvent) => e.id === "e-dup").length;
    expect(dupCount).toBe(1);

    ac.abort();
  });
});
