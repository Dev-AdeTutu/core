import type { SorokitCache } from "../shared/cache";
import { getTracedFetch } from "../shared/serverFactory";
import {
  type ContractEvent,
  queryContractEvents,
} from "./subscribeContractEvents";

export interface ContractStateEntry {
  revision: number;
  lastEventId?: string;
  lastCheckedAt?: number;
  lastLocalMutationAt?: number;
}

export interface ContractStateTrackerOptions {
  eventCheckIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface ContractStateTracker {
  getRevision(contractId: string): Promise<number>;
  markContractModified(contractId: string): Promise<number>;
}

const DEFAULT_EVENT_CHECK_INTERVAL_MS = 5_000;

function stateCacheKey(contractId: string): string {
  return `sorokit:contract-state:${contractId}`;
}

function normalizeEventId(event: ContractEvent | undefined): string | undefined {
  if (!event) return undefined;
  if (typeof event.id === "string" && event.id.length > 0) return event.id;
  const pagingToken = event.paging_token;
  return typeof pagingToken === "string" && pagingToken.length > 0
    ? pagingToken
    : undefined;
}

function readState(cache: SorokitCache, contractId: string): ContractStateEntry {
  const value = cache.get(stateCacheKey(contractId));
  if (!value || typeof value !== "object") {
    return { revision: 0 };
  }

  const state = value as Partial<ContractStateEntry>;
  return {
    revision: typeof state.revision === "number" ? state.revision : 0,
    ...(typeof state.lastEventId === "string" && state.lastEventId.length > 0
      ? { lastEventId: state.lastEventId }
      : {}),
    ...(typeof state.lastCheckedAt === "number"
      ? { lastCheckedAt: state.lastCheckedAt }
      : {}),
    ...(typeof state.lastLocalMutationAt === "number"
      ? { lastLocalMutationAt: state.lastLocalMutationAt }
      : {}),
  };
}

function writeState(
  cache: SorokitCache,
  contractId: string,
  state: ContractStateEntry,
): void {
  cache.set(stateCacheKey(contractId), state);
}

async function loadLatestContractEvent(
  horizonUrl: string,
  contractId: string,
  fetchOverride?: typeof globalThis.fetch,
): Promise<ContractEvent | undefined> {
  const events = await queryContractEvents(contractId, undefined, {
    horizonUrl,
    fetch: fetchOverride ?? getTracedFetch() ?? globalThis.fetch,
    limit: 1,
  });
  return events[0];
}

export function createContractStateTracker(
  cache: SorokitCache,
  horizonUrl: string,
  options?: ContractStateTrackerOptions,
): ContractStateTracker {
  const eventCheckIntervalMs =
    options?.eventCheckIntervalMs ?? DEFAULT_EVENT_CHECK_INTERVAL_MS;

  return {
    async getRevision(contractId: string): Promise<number> {
      const currentState = readState(cache, contractId);
      const now = Date.now();
      if (
        currentState.lastCheckedAt !== undefined &&
        now - currentState.lastCheckedAt < eventCheckIntervalMs
      ) {
        return currentState.revision;
      }

      try {
        const latestEvent = await loadLatestContractEvent(
          horizonUrl,
          contractId,
          options?.fetch,
        );
        const latestEventId = normalizeEventId(latestEvent);
        const nextState: ContractStateEntry = {
          ...currentState,
          lastCheckedAt: now,
        };

        if (
          latestEventId &&
          currentState.lastEventId !== undefined &&
          currentState.lastEventId !== latestEventId
        ) {
          nextState.revision = currentState.revision + 1;
        }

        if (latestEventId) {
          nextState.lastEventId = latestEventId;
        }

        writeState(cache, contractId, nextState);
        return nextState.revision;
      } catch {
        writeState(cache, contractId, {
          ...currentState,
          lastCheckedAt: now,
        });
        return currentState.revision;
      }
    },

    async markContractModified(contractId: string): Promise<number> {
      const currentState = readState(cache, contractId);
      const nextState: ContractStateEntry = {
        ...currentState,
        revision: currentState.revision + 1,
        lastLocalMutationAt: Date.now(),
        lastCheckedAt: Date.now(),
      };
      writeState(cache, contractId, nextState);
      return nextState.revision;
    },
  };
}
