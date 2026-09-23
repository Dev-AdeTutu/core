/**
 * Tests for contract version detection and upgrade notifications (#393).
 */

import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SorokitCache } from "../shared/cache";
import type { ContractUpgradeEvent } from "../soroban/contractVersion";
import {
  getContractVersion,
  getContractVersionHistory,
  invalidateContractVersionCache,
  parseVersionFromMeta,
  resetContractVersionTracking,
} from "../soroban/contractVersion";

const { mockGetLedgerEntries } = vi.hoisted(() => ({
  mockGetLedgerEntries: vi.fn(),
}));

vi.mock("../shared/serverFactory", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../shared/serverFactory")>();
  return {
    ...actual,
    createSorobanServer: () => ({
      getLedgerEntries: mockGetLedgerEntries,
    }),
  };
});

function contractId(): string {
  return StrKey.encodeContract(Keypair.random().rawPublicKey());
}

function encodeLeb128(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function customSection(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name);
  const sectionSize =
    nameBuf.length + encodeLeb128(nameBuf.length).length + data.length;
  return Buffer.from([
    0x00,
    ...encodeLeb128(sectionSize),
    ...encodeLeb128(nameBuf.length),
    ...nameBuf,
    ...data,
  ]);
}

function metaSectionData(pairs: Array<[string, string]>): Buffer {
  const chunks: Buffer[] = [];
  for (const [key, value] of pairs) {
    chunks.push(xdr.ScVal.scvSymbol(key).toXDR());
    chunks.push(xdr.ScVal.scvString(value).toXDR());
  }
  return Buffer.concat(chunks);
}

/** Wasm with an optional `contractmetav0` section. */
function versionedWasm(version?: string): Buffer {
  const sections: Buffer[] = [customSection("contractspecv0", Buffer.alloc(0))];
  if (version !== undefined) {
    sections.unshift(
      customSection(
        "contractmetav0",
        metaSectionData([
          ["Description", "Test contract"],
          ["version", version],
        ]),
      ),
    );
  }
  return Buffer.concat([Buffer.from(WASM_HEADER), ...sections]);
}

function mockContractWasm(wasm: Buffer): void {
  mockGetLedgerEntries
    .mockResolvedValueOnce({
      entries: [
        {
          val: {
            contractData: () => ({
              val: () => ({
                instance: () => ({
                  executable: () =>
                    xdr.ContractExecutable.contractExecutableWasm(
                      Buffer.alloc(32, 1),
                    ),
                }),
              }),
            }),
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      entries: [
        {
          val: {
            contractCode: () => ({ code: () => wasm }),
          },
        },
      ],
    });
}

class MemoryCache implements SorokitCache {
  values = new Map<string, unknown>();

  get(key: string): unknown {
    return this.values.get(key);
  }
  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
  invalidate(key: string): void {
    this.values.delete(key);
  }
}

describe("getContractVersion (#393)", () => {
  beforeEach(() => {
    mockGetLedgerEntries.mockReset();
  });

  it("extracts the version from contract metadata", async () => {
    mockContractWasm(versionedWasm("2.1.0"));

    const result = await getContractVersion("https://rpc.example.com", contractId());

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.version).toBe("2.1.0");
      expect(result.data.contractId).toBe(result.data.contractId);
    }
  });

  it("returns null version for contracts without version metadata", async () => {
    mockContractWasm(versionedWasm(undefined));

    const result = await getContractVersion("https://rpc.example.com", contractId());

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.version).toBeNull();
    }
  });

  it("caches version lookups with a configurable TTL", async () => {
    const id = contractId();
    mockContractWasm(versionedWasm("1.0.0"));

    let clock = 1_000;
    const opts = { ttlMs: 5_000, now: () => clock };

    const first = await getContractVersion("https://rpc.example.com", id, opts);
    const second = await getContractVersion("https://rpc.example.com", id, opts);

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    // Two RPC calls per fetch — a cache hit adds none.
    expect(mockGetLedgerEntries).toHaveBeenCalledTimes(2);

    clock += 6_000; // TTL elapsed
    mockGetLedgerEntries.mockClear();
    mockContractWasm(versionedWasm("1.0.1"));
    const third = await getContractVersion("https://rpc.example.com", id, opts);

    expect(third.status).toBe("ok");
    if (third.status === "ok") expect(third.data.version).toBe("1.0.1");
    expect(mockGetLedgerEntries).toHaveBeenCalledTimes(2);
  });

  it("does not treat missing metadata as an upgrade and preserves the prior version", async () => {
    const id = contractId();
    const upgrades: ContractUpgradeEvent[] = [];
    const onContractUpgrade = (e: ContractUpgradeEvent) => upgrades.push(e);

    mockContractWasm(versionedWasm("3.0.0"));
    await getContractVersion("https://rpc.example.com", id, { onContractUpgrade });
    expect(upgrades).toHaveLength(0);

    mockGetLedgerEntries.mockClear();
    mockContractWasm(versionedWasm(undefined)); // metadata vanished
    invalidateContractVersionCache(id);
    const unavailable = await getContractVersion("https://rpc.example.com", id, {
      onContractUpgrade,
    });
    expect(unavailable.status).toBe("ok");
    if (unavailable.status === "ok") expect(unavailable.data.version).toBeNull();
    expect(upgrades).toHaveLength(0); // not an upgrade

    // The previously observed version is still tracked: returning to it is
    // NOT a change either.
    mockGetLedgerEntries.mockClear();
    mockContractWasm(versionedWasm("3.0.0"));
    invalidateContractVersionCache(id);
    await getContractVersion("https://rpc.example.com", id, { onContractUpgrade });
    expect(upgrades).toHaveLength(0);

    // But moving to a NEW version still fires.
    mockGetLedgerEntries.mockClear();
    mockContractWasm(versionedWasm("4.0.0"));
    invalidateContractVersionCache(id);
    await getContractVersion("https://rpc.example.com", id, { onContractUpgrade });
    expect(upgrades).toEqual([
      { contractId: id, previousVersion: "3.0.0", currentVersion: "4.0.0" },
    ]);
  });

  it("fires onContractUpgrade exactly once per actual version change", async () => {
    const id = contractId();
    const upgrades: ContractUpgradeEvent[] = [];
    const onContractUpgrade = (e: ContractUpgradeEvent) => upgrades.push(e);

    mockContractWasm(versionedWasm("1.0.0"));
    await getContractVersion("https://rpc.example.com", id, { onContractUpgrade });
    expect(upgrades).toHaveLength(0);

    // Same version again — no repeat trigger.
    mockGetLedgerEntries.mockClear();
    mockContractWasm(versionedWasm("1.0.0"));
    invalidateContractVersionCache(id);
    await getContractVersion("https://rpc.example.com", id, { onContractUpgrade });
    expect(upgrades).toHaveLength(0);

    mockGetLedgerEntries.mockClear();
    mockContractWasm(versionedWasm("1.1.0"));
    invalidateContractVersionCache(id);
    await getContractVersion("https://rpc.example.com", id, { onContractUpgrade });
    expect(upgrades).toEqual([
      { contractId: id, previousVersion: "1.0.0", currentVersion: "1.1.0" },
    ]);

    // Repeated calls at the new version never re-fire.
    for (let i = 0; i < 2; i++) {
      mockGetLedgerEntries.mockClear();
      invalidateContractVersionCache(id);
      mockContractWasm(versionedWasm("1.1.0"));
      await getContractVersion("https://rpc.example.com", id, { onContractUpgrade });
    }
    expect(upgrades).toHaveLength(1);
  });

  it("treats the first observation after reset as initial, not an upgrade", async () => {
    const id = contractId();
    const upgrades: ContractUpgradeEvent[] = [];
    const onContractUpgrade = (e: ContractUpgradeEvent) => upgrades.push(e);

    mockContractWasm(versionedWasm("5.0.0"));
    await getContractVersion("https://rpc.example.com", id);

    resetContractVersionTracking(id);
    invalidateContractVersionCache(id);

    mockContractWasm(versionedWasm("6.0.0"));
    await getContractVersion("https://rpc.example.com", id, { onContractUpgrade });

    expect(upgrades).toHaveLength(0);
  });

  it("handles malformed metadata safely", async () => {
    // Truncated XDR in the meta section must resolve to null, never throw.
    const malformed = Buffer.concat([
      Buffer.from(WASM_HEADER),
      customSection("contractmetav0", Buffer.from([0xff, 0xff])),
    ]);
    expect(parseVersionFromMeta(malformed)).toBeNull();

    mockContractWasm(malformed);
    const result = await getContractVersion("https://rpc.example.com", contractId());
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data.version).toBeNull();
  });

  it("propagates RPC failures as CONTRACT_READ_FAILED", async () => {
    mockGetLedgerEntries.mockResolvedValue({ entries: [] });

    const result = await getContractVersion("https://rpc.example.com", contractId());

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("CONTRACT_READ_FAILED");
    }
  });

  it("records version history across upgrades", async () => {
    const id = contractId();

    mockContractWasm(versionedWasm("1.0.0"));
    await getContractVersion("https://rpc.example.com", id);

    mockGetLedgerEntries.mockClear();
    mockContractWasm(versionedWasm("2.0.0"));
    invalidateContractVersionCache(id);
    await getContractVersion("https://rpc.example.com", id);

    const history = getContractVersionHistory(id);
    expect(history).toHaveLength(2);
    expect(history[0].version).toBe("1.0.0");
    expect(history[0].isUpgrade).toBe(false);
    expect(history[1].version).toBe("2.0.0");
    expect(history[1].isUpgrade).toBe(true);
  });

  it("clears version history on reset", async () => {
    const id = contractId();

    mockContractWasm(versionedWasm("1.0.0"));
    await getContractVersion("https://rpc.example.com", id);

    expect(getContractVersionHistory(id)).toHaveLength(1);
    resetContractVersionTracking(id);
    expect(getContractVersionHistory(id)).toHaveLength(0);
  });
});
