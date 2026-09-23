import { NETWORK_DEFAULTS } from "./config";
import type { NetworkConfig, NetworkType } from "./config";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface NetworkOverrides {
  /** Override the default Horizon URL */
  horizonUrl?: string | undefined;
  /** Override the default Soroban RPC URL */
  rpcUrl?: string | undefined;
}

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Resolve a NetworkConfig from a network type and optional overrides.
 *
 * This is the single config-driven entry point for the network layer.
 * It replaces the previous getNetwork() + setNetwork() split.
 *
 * - With no overrides: returns the canonical defaults for the network
 * - With overrides: merges them on top of the defaults
 *
 * @example
 * resolveNetwork('testnet')
 * resolveNetwork('testnet', { horizonUrl: 'https://my-horizon.example.com' })
 */
export function resolveNetwork(
  network: NetworkType,
  overrides?: NetworkOverrides,
): SorokitResult<NetworkConfig> {
  const base = NETWORK_DEFAULTS[network];
  if (!base) {
    return err(
      SorokitErrorCode.INVALID_NETWORK,
      `Unknown network: "${network}". Valid options are mainnet, testnet, futurenet.`,
    );
  }
  if (!overrides) return ok(base);

  if (
    overrides.horizonUrl !== undefined &&
    !isValidUrl(overrides.horizonUrl)
  ) {
    return err(
      SorokitErrorCode.INVALID_NETWORK,
      `Invalid horizonUrl: "${overrides.horizonUrl}". Must be a non-empty URL starting with http:// or https://.`,
    );
  }

  if (overrides.rpcUrl !== undefined && !isValidUrl(overrides.rpcUrl)) {
    return err(
      SorokitErrorCode.INVALID_NETWORK,
      `Invalid rpcUrl: "${overrides.rpcUrl}". Must be a non-empty URL starting with http:// or https://.`,
    );
  }

  return ok({
    ...base,
    ...(overrides.horizonUrl !== undefined && {
      horizonUrl: overrides.horizonUrl,
    }),
    ...(overrides.rpcUrl !== undefined && { rpcUrl: overrides.rpcUrl }),
  });
}
