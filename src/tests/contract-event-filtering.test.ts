import { describe, expect, it } from "vitest";
import {
  andEventFilters,
  calculateRate,
  countByType,
  filterContractEvents,
  groupByTime,
  orEventFilters,
  type ContractEvent,
} from "../soroban/subscribeContractEvents";

const events: ContractEvent[] = [
  { id: "1", eventType: "transfer", name: "transfer", emitter: "alice", topics: ["x"], timestamp: "2026-01-01T00:00:00.000Z" },
  { id: "2", eventType: "mint", name: "mint", emitter: "bob", topics: ["y"], timestamp: "2026-01-01T00:00:01.000Z" },
  { id: "3", eventType: "transfer", name: "transfer", emitter: "bob", topics: ["x", "y"], timestamp: "2026-01-01T00:00:02.000Z" },
];

describe("contract event filtering and aggregation", () => {
  it("filters by event type, emitter, and topic while preserving order and references", () => {
    const result = filterContractEvents(events, {
      eventType: "transfer",
      emitter: "bob",
      topics: ["x"],
    });

    expect(result.map((event) => event.id)).toEqual(["3"]);
    expect(result[0]).toBe(events[2]);
  });

  it("combines filters with AND and OR semantics", () => {
    const transferByAliceOrMint = orEventFilters(
      { eventType: "mint" },
      andEventFilters({ eventType: "transfer" }, { emitter: "alice" }),
    );

    expect(filterContractEvents(events, transferByAliceOrMint).map((event) => event.id)).toEqual(["1", "2"]);
  });

  it("aggregates counts and time buckets without copying events", () => {
    expect(countByType(events)).toEqual({ transfer: 2, mint: 1 });
    const grouped = groupByTime(events, 2_000);
    expect([...grouped.values()].map((group) => group.map((event) => event.id))).toEqual([["1", "2"], ["3"]]);
    expect(grouped.get(Date.parse("2026-01-01T00:00:00.000Z"))?.[0]).toBe(events[0]);
    expect(calculateRate(events, 2_000)).toBe(1.5);
    expect(calculateRate(events)).toBe(1.5);
  });
});