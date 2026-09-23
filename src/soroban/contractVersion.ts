/**
 * Contract version detection and upgrade notifications (#393).
 *
 * Builds on the existing Soroban contract metadata retrieval flow
 * (`fetchContractWasm`) rather than introducing a separate RPC path.
 *
 * Version semantics:
 * - A contract without version metadata resolves to `version: null`.
 * - Missing metadata is NOT an upgrade — the last observed version is kept.
 * - Only a previously observed non-null version changing to a different
 *   non-null version fires `onContractUpgrade`, exactly once per change.
 */

import { cereal, xdr } from "@stellar/stellar-sdk";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SorokitCache } from "../shared/cache";
import { DEFAULT_CONTRACT_METADATA_TTL_MS } from "../shared/constants";
import { toMessage } from "../shared";
import {
  fetchContractWasm,
  readWasmCustomSections,
} from "./contractMetadata";

const CONTRACT_META_SECTION_NAME = "contractmetav0";
const VERSION_META_KEY = "version";

export interface ContractVersionInfo {
  /** Stellar contract address (C...). */
  contractId: string;
  /**
   * Version string extracted from contract metadata,
   * or `null` when the contract exposes no version metadata.
   */
  version: string | null;
}

export interface ContractUpgradeEvent {
  contractId: string;
  previousVersion: string;
  currentVersion: string;
}

/** A single entry in a contract's version history. */
export interface ContractVersionHistoryEntry {
  /** Version string observed. */
  version: string;
  /** ISO-8601 timestamp when this version was first observed. */
  observedAt: string;
  /** Whether this was an upgrade from a previous version, or the initial observation. */
  isUpgrade: boolean;
}

/** Application-defined migration hook fired on observed version changes. */
export type OnContractUpgrade = (event: ContractUpgradeEvent) => void;

export interface ContractVersionOptions {
  cache?: SorokitCache;
  /** Cache TTL for version lookups. Defaults to DEFAULT_CONTRACT_METADATA_TTL_MS (1h). */
  ttlMs?: number;
  now?: () => number;
  /** Invoked once whenever the observed version changes to a new non-null value. */
  onContractUpgrade?: OnContractUpgrade;
}

interface VersionCacheEntry {
  version: string | null;
  expiresAt: number;
}

interface ObservedVersionEntry {
  version: string | null;
}

// ─── Caches ───────────────────────────────────────────────────────────────────

const versionMemoryCache = new Map<string, VersionCacheEntry>();
const observedVersions = new Map<string, ObservedVersionEntry>();
const versionHistory = new Map<string, ContractVersionHistoryEntry[]>();
const MAX_MEMORY_CACHE_ENTRIES = 100;

function versionCacheKey(contractId: string): string {
  return `sorokit:contract-version:${contractId}`;
}

function observedCacheKey(contractId: string): string {
  return `sorokit:contract-version-observed:${contractId}`;
}

function enforceMemoryLimit(map: Map<string, unknown>, key: string): void {
  if (!map.has(key) && map.size >= MAX_MEMORY_CACHE_ENTRIES) {
    const oldestKey = map.keys().next().value as string | undefined;
    if (oldestKey) map.delete(oldestKey);
  }
}

function isVersionCacheEntry(value: unknown): value is VersionCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<VersionCacheEntry>;
  return (
    (entry.version === null || typeof entry.version === "string") &&
    typeof entry.expiresAt === "number"
  );
}

function getCachedVersion(
  contractId: string,
  options?: ContractVersionOptions,
): string | null | undefined {
  const now = options?.now?.() ?? Date.now();
  const key = versionCacheKey(contractId);

  const externalValue = options?.cache?.get(key);
  if (isVersionCacheEntry(externalValue)) {
    if (externalValue.expiresAt > now) return externalValue.version;
    options?.cache?.invalidate(key);
  }

  const memoryValue = versionMemoryCache.get(key);
  if (memoryValue) {
    if (memoryValue.expiresAt > now) return memoryValue.version;
    versionMemoryCache.delete(key);
  }

  return undefined;
}

function setCachedVersion(
  contractId: string,
  version: string | null,
  options?: ContractVersionOptions,
): void {
  const ttlMs = options?.ttlMs ?? DEFAULT_CONTRACT_METADATA_TTL_MS;
  const now = options?.now?.() ?? Date.now();
  const entry: VersionCacheEntry = { version, expiresAt: now + ttlMs };
  const key = versionCacheKey(contractId);

  options?.cache?.set(key, entry, ttlMs);
  enforceMemoryLimit(versionMemoryCache, key);
  versionMemoryCache.set(key, entry);
}

function getObservedVersion(
  contractId: string,
  cache?: SorokitCache,
): string | null | undefined {
  const external = cache?.get(observedCacheKey(contractId));
  if (
    external &&
    typeof external === "object" &&
    (external as ObservedVersionEntry).version !== undefined
  ) {
    return (external as ObservedVersionEntry).version;
  }

  return observedVersions.get(contractId)?.version;
}

function setObservedVersion(
  contractId: string,
  version: string | null,
  cache?: SorokitCache,
): void {
  const entry: ObservedVersionEntry = { version };
  enforceMemoryLimit(observedVersions, contractId);
  observedVersions.set(contractId, entry);
  cache?.set(observedCacheKey(contractId), entry);
}

// ─── Metadata parsing ─────────────────────────────────────────────────────────

/**
 * Extract the version from XDR-encoded `(Symbol, String)` meta pairs stored in
 * the `contractmetav0` Wasm custom section. Returns `null` when absent or
 * malformed — never throws.
 */
export function parseVersionFromMeta(wasm: Uint8Array): string | null {
  try {
    const metaSection = readWasmCustomSections(wasm).find(
      (section) => section.name === CONTRACT_META_SECTION_NAME,
    );
    if (!metaSection) return null;

    const reader = new cereal.XdrReader(Buffer.from(metaSection.data));
    while (!reader.eof) {
      const key = xdr.ScVal.read(reader as unknown as Buffer);
      if (reader.eof) break;
      const value = xdr.ScVal.read(reader as unknown as Buffer);

      const isSymbolKey = key.switch().name === "scvSymbol";
      const keyValue = isSymbolKey ? String(key.sym()).toLowerCase() : "";
      if (keyValue !== VERSION_META_KEY) continue;

      if (value.switch().name === "scvString") {
        const str = String(value.str());
        return str.length > 0 ? str : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Retrieve the version of a deployed contract from its specification metadata.
 *
 * Results are cached per contract ID with a configurable TTL. Contracts that
 * do not expose version metadata resolve to `version: null` — an explicit
 * "unavailable" state, distinct from an actual version change.
 *
 * @param rpcUrl     - Base URL of the Soroban RPC server.
 * @param contractId - Stellar contract address (C...).
 * @param options    - Optional cache, TTL, clock override, upgrade hook.
 *
 * (issue #393)
 */
export async function getContractVersion(
  rpcUrl: string,
  contractId: string,
  options?: ContractVersionOptions,
): Promise<SorokitResult<ContractVersionInfo>> {
  const cached = getCachedVersion(contractId, options);
  if (cached !== undefined) {
    recordObservation(contractId, cached, options);
    return ok({ contractId, version: cached });
  }

  try {
    const wasmResult = await fetchContractWasm(rpcUrl, contractId);
    if (wasmResult.status === "error") return wasmResult;

    const version = parseVersionFromMeta(wasmResult.data);
    setCachedVersion(contractId, version, options);
    recordObservation(contractId, version, options);

    return ok({ contractId, version });
  } catch (cause) {
    return err(
      SorokitErrorCode.CONTRACT_READ_FAILED,
      `Failed to read contract version: ${toMessage(cause)}`,
      cause,
    );
  }
}

/**
 * Compare the freshly observed version against the last recorded one and fire
 * `onContractUpgrade` exactly once per actual change. Missing metadata never
 * overwrites or erases a previously observed version.
 */
function recordObservation(
  contractId: string,
  currentVersion: string | null,
  options?: ContractVersionOptions,
): void {
  const previous = getObservedVersion(contractId, options?.cache);

  if (currentVersion === null || currentVersion === previous) {
    // Unavailable or unchanged — keep any prior observation intact.
    return;
  }

  setObservedVersion(contractId, currentVersion, options?.cache);

  // Record version history
  const history = versionHistory.get(contractId) ?? [];
  history.push({
    version: currentVersion,
    observedAt: new Date().toISOString(),
    isUpgrade: previous !== undefined && previous !== null,
  });
  versionHistory.set(contractId, history);

  if (
    previous !== undefined &&
    previous !== null &&
    options?.onContractUpgrade
  ) {
    options.onContractUpgrade({
      contractId,
      previousVersion: previous,
      currentVersion,
    });
  }
}

/**
 * Clear the TTL-cached version lookup for a contract so the next call
 * re-fetches from the network.
 */
export function invalidateContractVersionCache(
  contractId: string,
  cache?: SorokitCache,
): void {
  versionMemoryCache.delete(versionCacheKey(contractId));
  cache?.invalidate(versionCacheKey(contractId));
}

/**
 * Forget the last observed version for a contract (memory + optional external
 * cache). The next observation is treated as initial, not an upgrade.
 */
export function resetContractVersionTracking(
  contractId: string,
  cache?: SorokitCache,
): void {
  observedVersions.delete(contractId);
  versionHistory.delete(contractId);
  cache?.invalidate(observedCacheKey(contractId));
}

/**
 * Return the full version history for a contract, ordered chronologically
 * (oldest first). Each entry records when a version was first observed and
 * whether it was an upgrade from a prior version.
 */
export function getContractVersionHistory(
  contractId: string,
): ContractVersionHistoryEntry[] {
  return versionHistory.get(contractId) ?? [];
}
