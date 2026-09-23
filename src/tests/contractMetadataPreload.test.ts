import { describe, it, expect, beforeEach } from "vitest";
import {
  preloadContractMetadata,
  setMetadataCacheCapacity,
  getContractMethods,
  contractMetadataInternals,
  invalidateContractCache,
  resetMetadataCache,
} from "../soroban/contractMetadata";
import { ok, err, SorokitErrorCode } from "../shared/response";

describe("Soroban Contract Metadata Preloading & LRU Cache", () => {
  const mockRpcUrl = "https://soroban-testnet.stellar.org";
  const dummyWasmBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

  beforeEach(() => {
    resetMetadataCache();
    setMetadataCacheCapacity(1000);
  });

  it("preloads multiple contract metadata records concurrently", async () => {
    const originalFetch = contractMetadataInternals.fetchContractWasm;
    const originalParse = contractMetadataInternals.parseContractMethodsFromWasm;
    const fetchedIds: string[] = [];

    contractMetadataInternals.fetchContractWasm = async (_, contractId) => {
      fetchedIds.push(contractId);
      return ok(dummyWasmBytes);
    };
    contractMetadataInternals.parseContractMethodsFromWasm = () => [];

    try {
      const contractIds = [
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      ];

      const results = await preloadContractMetadata(mockRpcUrl, contractIds);

      expect(Object.keys(results)).toHaveLength(2);
      expect(results[contractIds[0]].status).toBe("ok");
      expect(results[contractIds[1]].status).toBe("ok");
      expect(fetchedIds).toContain(contractIds[0]);
      expect(fetchedIds).toContain(contractIds[1]);
    } finally {
      contractMetadataInternals.fetchContractWasm = originalFetch;
      contractMetadataInternals.parseContractMethodsFromWasm = originalParse;
    }
  });

  it("handles individual contract preload failures without invalidating successful entries", async () => {
    const originalFetch = contractMetadataInternals.fetchContractWasm;
    const originalParse = contractMetadataInternals.parseContractMethodsFromWasm;

    contractMetadataInternals.fetchContractWasm = async (_, contractId) => {
      if (contractId.startsWith("CFAIL")) {
        return err(
          SorokitErrorCode.CONTRACT_READ_FAILED,
          "Contract not found",
        );
      }
      return ok(dummyWasmBytes);
    };
    contractMetadataInternals.parseContractMethodsFromWasm = () => [];

    try {
      const contractIds = [
        "CGOODAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "CFAILBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      ];

      const results = await preloadContractMetadata(mockRpcUrl, contractIds);

      expect(results[contractIds[0]].status).toBe("ok");
      expect(results[contractIds[1]].status).toBe("error");
    } finally {
      contractMetadataInternals.fetchContractWasm = originalFetch;
      contractMetadataInternals.parseContractMethodsFromWasm = originalParse;
    }
  });

  it("evicts least-recently-used entries when capacity is exceeded", async () => {
    const originalFetch = contractMetadataInternals.fetchContractWasm;
    const originalParse = contractMetadataInternals.parseContractMethodsFromWasm;
    let fetchCount = 0;

    contractMetadataInternals.fetchContractWasm = async () => {
      fetchCount++;
      return ok(dummyWasmBytes);
    };
    contractMetadataInternals.parseContractMethodsFromWasm = () => [];

    setMetadataCacheCapacity(2);

    try {
      const id1 = "C1111111111111111111111111111111111111111111111111111111";
      const id2 = "C2222222222222222222222222222222222222222222222222222222";
      const id3 = "C3333333333333333333333333333333333333333333333333333333";

      invalidateContractCache(id1);
      invalidateContractCache(id2);
      invalidateContractCache(id3);

      await getContractMethods(mockRpcUrl, id1);
      await getContractMethods(mockRpcUrl, id2);
      expect(fetchCount).toBe(2);

      // Accessing id1 again updates its LRU order (cache hit)
      await getContractMethods(mockRpcUrl, id1);
      expect(fetchCount).toBe(2);

      // Adding id3 causes id2 (least recently used) to be evicted
      await getContractMethods(mockRpcUrl, id3);
      expect(fetchCount).toBe(3);

      // id2 was evicted, fetching it again triggers a network call
      await getContractMethods(mockRpcUrl, id2);
      expect(fetchCount).toBe(4);
    } finally {
      contractMetadataInternals.fetchContractWasm = originalFetch;
      contractMetadataInternals.parseContractMethodsFromWasm = originalParse;
      setMetadataCacheCapacity(1000);
    }
  });
});
