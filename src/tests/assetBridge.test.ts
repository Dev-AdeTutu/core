import { beforeEach, describe, expect, it } from "vitest";
import { ok } from "../shared/response";
import {
  AssetMappingRegistry,
  unwrapAssetFromSoroban,
  wrapAssetForSoroban,
} from "../soroban/assetBridge";

describe("asset bridge utilities", () => {
  let registry: AssetMappingRegistry;
  const adapter = {
    id: "demo-bridge",
    wrapAsset: async (asset: string) => ok(`wrapped:${asset}`),
    unwrapAsset: async (asset: string) => ok(asset.replace("wrapped:", "")),
  };

  beforeEach(() => {
    registry = new AssetMappingRegistry();
  });

  it("wraps an asset and records its mapping", async () => {
    const result = await wrapAssetForSoroban({ asset: "USDC", adapter, registry });
    expect(result).toEqual({ status: "ok", data: "wrapped:USDC", error: null });
    expect(registry.getWrappedAsset("demo-bridge", "USDC").data).toBe("wrapped:USDC");
  });

  it("unwraps a mapped asset", async () => {
    await wrapAssetForSoroban({ asset: "USDC", adapter, registry });
    const result = await unwrapAssetFromSoroban({ asset: "wrapped:USDC", adapter, registry });
    expect(result.status).toBe("ok");
    expect(result.data).toBe("USDC");
  });

  it("rejects conflicting mappings", () => {
    expect(registry.register({ bridgeId: "demo-bridge", originalAsset: "A", wrappedAsset: "W" }).status).toBe("ok");
    expect(registry.register({ bridgeId: "demo-bridge", originalAsset: "A", wrappedAsset: "W2" }).status).toBe("error");
    expect(registry.register({ bridgeId: "demo-bridge", originalAsset: "B", wrappedAsset: "W" }).status).toBe("error");
  });

  it("validates identifiers before calling the adapter", async () => {
    let called = false;
    const invalidAdapter = { ...adapter, wrapAsset: async () => { called = true; return ok("wrapped"); } };
    const result = await wrapAssetForSoroban({ asset: " ", adapter: invalidAdapter, registry });
    expect(result.status).toBe("error");
    expect(called).toBe(false);
  });
});