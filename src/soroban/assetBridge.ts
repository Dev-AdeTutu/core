import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

/** A bridge-independent identifier for an asset. */
export type AssetIdentifier = string;

/** Adapter implemented by a specific asset bridge protocol. */
export interface AssetBridgeAdapter {
  readonly id: string;
  wrapAsset(asset: AssetIdentifier): Promise<SorokitResult<AssetIdentifier>>;
  unwrapAsset(asset: AssetIdentifier): Promise<SorokitResult<AssetIdentifier>>;
}

export interface AssetMapping {
  bridgeId: string;
  originalAsset: AssetIdentifier;
  wrappedAsset: AssetIdentifier;
}

function validateIdentifier(value: unknown, field: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `${field} must be a non-empty string`;
  }
  return null;
}

function validateAdapter(adapter: AssetBridgeAdapter): string | null {
  if (adapter === null || typeof adapter !== "object") {
    return "bridge adapter is required";
  }
  return validateIdentifier(adapter.id, "bridge adapter id");
}

function invalid<T>(message: string): SorokitResult<T> {
  return err(SorokitErrorCode.INVALID_CONFIG, message);
}

/** Stores one-to-one original and wrapped asset mappings per bridge. */
export class AssetMappingRegistry {
  private readonly mappings = new Map<string, AssetMapping>();

  register(mapping: AssetMapping): SorokitResult<AssetMapping> {
    const bridgeError = validateIdentifier(mapping.bridgeId, "bridge id");
    const originalError = validateIdentifier(mapping.originalAsset, "original asset");
    const wrappedError = validateIdentifier(mapping.wrappedAsset, "wrapped asset");
    if (bridgeError || originalError || wrappedError) {
      return invalid(bridgeError ?? originalError ?? wrappedError ?? "invalid asset mapping");
    }

    const key = this.key(mapping.bridgeId, mapping.originalAsset);
    const reverseKey = this.key(mapping.bridgeId, mapping.wrappedAsset);
    if (this.mappings.has(key)) {
      return invalid(`mapping for ${mapping.originalAsset} already exists on bridge ${mapping.bridgeId}`);
    }
    for (const candidate of this.mappings.values()) {
      if (this.key(candidate.bridgeId, candidate.wrappedAsset) === reverseKey) {
        return invalid(`wrapped asset ${mapping.wrappedAsset} is already mapped on bridge ${mapping.bridgeId}`);
      }
    }

    this.mappings.set(key, mapping);
    return ok(mapping);
  }

  getWrappedAsset(bridgeId: string, originalAsset: AssetIdentifier): SorokitResult<AssetIdentifier | null> {
    const validation = this.validateLookup(bridgeId, originalAsset, "original asset");
    if (validation) return invalid(validation);
    return ok(this.mappings.get(this.key(bridgeId, originalAsset))?.wrappedAsset ?? null);
  }

  getOriginalAsset(bridgeId: string, wrappedAsset: AssetIdentifier): SorokitResult<AssetIdentifier | null> {
    const validation = this.validateLookup(bridgeId, wrappedAsset, "wrapped asset");
    if (validation) return invalid(validation);
    for (const mapping of this.mappings.values()) {
      if (mapping.bridgeId === bridgeId && mapping.wrappedAsset === wrappedAsset) {
        return ok(mapping.originalAsset);
      }
    }
    return ok(null);
  }

  listMappings(bridgeId?: string): SorokitResult<AssetMapping[]> {
    if (bridgeId !== undefined) {
      const validation = validateIdentifier(bridgeId, "bridge id");
      if (validation) return invalid(validation);
    }
    return ok([...this.mappings.values()].filter((mapping) => bridgeId === undefined || mapping.bridgeId === bridgeId));
  }

  clear(): void {
    this.mappings.clear();
  }

  private validateLookup(bridgeId: string, asset: string, field: string): string | null {
    return validateIdentifier(bridgeId, "bridge id") ?? validateIdentifier(asset, field);
  }

  private key(bridgeId: string, asset: string): string {
    return `${bridgeId}\u0000${asset}`;
  }
}

export const assetMappingRegistry = new AssetMappingRegistry();

export interface AssetBridgeOperationOptions {
  asset: AssetIdentifier;
  adapter: AssetBridgeAdapter;
  registry?: AssetMappingRegistry;
}

export async function wrapAssetForSoroban(
  options: AssetBridgeOperationOptions,
): Promise<SorokitResult<AssetIdentifier>> {
  const validation = validateIdentifier(options?.asset, "asset") ?? validateAdapter(options?.adapter);
  if (validation) return invalid(validation);

  try {
    const result = await options.adapter.wrapAsset(options.asset);
    if (result.status === "error") return result;
    const mapping = (options.registry ?? assetMappingRegistry).register({
      bridgeId: options.adapter.id,
      originalAsset: options.asset,
      wrappedAsset: result.data,
    });
    return mapping.status === "error" ? mapping : ok(result.data);
  } catch (cause) {
    return err(SorokitErrorCode.UNKNOWN, "asset wrapping failed", cause);
  }
}

export async function unwrapAssetFromSoroban(
  options: AssetBridgeOperationOptions,
): Promise<SorokitResult<AssetIdentifier>> {
  const validation = validateIdentifier(options?.asset, "asset") ?? validateAdapter(options?.adapter);
  if (validation) return invalid(validation);

  try {
    const result = await options.adapter.unwrapAsset(options.asset);
    if (result.status === "error") return result;
    const mapping = (options.registry ?? assetMappingRegistry).getOriginalAsset(options.adapter.id, options.asset);
    if (mapping.status === "error") return mapping;
    if (mapping.data !== null && mapping.data !== result.data) {
      return invalid(`bridge returned ${result.data}, expected ${mapping.data}`);
    }
    return ok(result.data);
  } catch (cause) {
    return err(SorokitErrorCode.UNKNOWN, "asset unwrapping failed", cause);
  }
}