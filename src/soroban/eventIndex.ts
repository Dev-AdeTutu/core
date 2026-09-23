/**
 * Event deduplication index for real-time contract event streaming (#541).
 *
 * The Soroban RPC `getEvents` cursor only advances per page — overlapping
 * ledger ranges can re-deliver events. `EventIndex` uses a hash of each event's
 * stable identifiers to suppress duplicates while bounding memory usage.
 */

import type { ContractEvent } from "./subscribeContractEvents";

/**
 * Hash a string into a 53-bit unsigned integer using FNV-1a.
 * Deterministic and dependency-free, so it runs identically in Node and
 * browsers. 53-bit (Number safe integer range) keeps collisions negligible
 * while avoiding BigInt overhead.
 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function topicPart(topic: string | null | undefined): string {
  if (topic == null) return "";
  // Accept either raw strings (Horizon records) or base64-encoded XDR topics.
  return String(topic);
}

/**
 * Build a stable hash for a contract event.
 *
 * Prefers the RPC-provided `id`/`pagingToken` when present — they are unique
 * per event on a given node. As a fallback, hashes the identity-bearing fields
 * (contract id, ledger, transaction hash, paging token, topic) so identical
 * events re-delivered across a cursor boundary still collide.
 */
export function hashEvent(event: ContractEvent): string {
  const id = String(event.id ?? "");
  if (id && id !== "undefined") {
    const pagingToken = String(event.pagingToken ?? event.txHash ?? "");
    return `id:${pagingToken}${id}`;
  }

  const contractId = String(event.contractId ?? event.contract_id ?? "");
  const ledger = String(event.ledger ?? "");
  const txHash = String(event.txHash ?? event.tx_hash ?? "");
  const pagingToken = String(event.pagingToken ?? event.paging_token ?? "");
  const topics = (event.topics ?? event.topic ?? [])
    .map(topicPart)
    .join("|");
  const value = String(event.value ?? "");

  const canonical = [
    contractId,
    ledger,
    txHash,
    pagingToken,
    topics,
    value,
  ].join("::");
  return `hash:${hashString(canonical).toString(36)}`;
}

/**
 * Bounded in-memory index of recently-seen events.
 *
 * Purely uses sampling of the insertion order (`Set` iteration order) to evict
 * the oldest entries once the capacity is reached, bounding memory use while
 * keeping the stream deduplicated.
 */
export class EventIndex {
  private readonly seen = new Set<string>();
  private readonly maxSize: number;

  /**
   * @param maxSize - Maximum number of event hashes to retain. Defaults to 10000.
   */
  constructor(maxSize = 10_000) {
    this.maxSize = maxSize > 0 ? Math.floor(maxSize) : 10_000;
  }

  /** Whether this event has already been seen (without marking it). */
  has(event: ContractEvent): boolean {
    return this.seen.has(hashEvent(event));
  }

  /**
   * Mark the event as seen. Returns `true` when it was a duplicate
   * (already present), `false` on first sight.
   */
  add(event: ContractEvent): boolean {
    const key = hashEvent(event);
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    this.evictIfNeeded();
    return false;
  }

  /** Order-independent clear — used for test isolation. */
  clear(): void {
    this.seen.clear();
  }

  /** Number of events currently retained. */
  get size(): number {
    return this.seen.size;
  }

  private evictIfNeeded(): void {
    while (this.seen.size > this.maxSize) {
      const oldest = this.seen.values().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
  }
}

/**
 * Convenience filter: `events.filter((event) => index.isNew(event))` marks
 * new events as seen and drops anything already indexed.
 */
export function filterNewEvents<T extends ContractEvent>(
  index: EventIndex,
  events: T[],
): T[] {
  const fresh: T[] = [];
  for (const event of events) {
    if (index.add(event)) continue;
    fresh.push(event);
  }
  return fresh;
}
