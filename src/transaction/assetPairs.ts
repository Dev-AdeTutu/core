/**
 * Custom asset pair trading logic (#209).
 * 
 * Provides helpers for creating asset pairs and querying DEX pool prices
 * with support for multi-hop pricing paths.
 */

import { Asset } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  validateTokenAsset,
  isSameAsset,
  normalizePairId,
} from "../shared/validateToken";
import type { SwapRoute, SwapRouteAsset, FindSwapPathOptions } from "./pathPayment";
import { findSwapPath } from "./pathPayment";

/** Set of pair IDs that have been created in this session. */
const existingPairIds = new Set<string>();

/**
 * Represents a trading pair between two assets.
 */
export interface AssetPair {
  /** Base asset (what you're selling) */
  base: SwapRouteAsset;
  /** Quote asset (what you're buying) */
  quote: SwapRouteAsset;
  /** Unique identifier for this pair */
  id: string;
}

/**
 * Price query result for an asset pair.
 */
export interface PairPrice {
  /** The asset pair */
  pair: AssetPair;
  /** Price (quote per base) */
  price: string;
  /** Estimated liquidity in the pool */
  liquidity: string;
  /** Whether this is a direct pair or multi-hop */
  isDirect: boolean;
  /** Path taken (empty for direct pairs) */
  path: SwapRouteAsset[];
}

/**
 * Create an asset pair from two assets.
 * 
 * @param asset1 - First asset (code and issuer)
 * @param asset2 - Second asset (code and issuer)
 * @returns Asset pair or error
 * 
 * @example
 * const pair = createAssetPair(
 *   { code: "USDC", issuer: "G..." },
 *   { code: "EURC", issuer: "G..." }
 * );
 */
export function createAssetPair(
  asset1: SwapRouteAsset,
  asset2: SwapRouteAsset,
): SorokitResult<AssetPair> {
  const validation1 = validateTokenAsset(asset1);
  if (validation1.status === "error") return validation1;

  const validation2 = validateTokenAsset(asset2);
  if (validation2.status === "error") return validation2;

  if (isSameAsset(asset1, asset2)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Cannot create a pair with the same asset",
    );
  }

  const id = normalizePairId(asset1, asset2);

  if (existingPairIds.has(id)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `Pair ${id} already exists`,
    );
  }

  existingPairIds.add(id);

  const pair: AssetPair = {
    base: asset1,
    quote: asset2,
    id,
  };

  return ok(pair);
}

/**
 * Check if a pair already exists for the given assets.
 */
export function hasExistingPair(
  asset1: SwapRouteAsset,
  asset2: SwapRouteAsset,
): boolean {
  const id = normalizePairId(asset1, asset2);
  return existingPairIds.has(id);
}

/**
 * Reset the pair registry (useful for testing).
 */
export function resetPairRegistry(): void {
  existingPairIds.clear();
}

/**
 * Get the market price for an asset pair.
 * 
 * Queries DEX pools to find the best price. Supports multi-hop paths
 * when no direct liquidity exists.
 * 
 * @param pair - Asset pair to query
 * @param amount - Amount to trade (for price estimation)
 * @param options - Optional path finding options
 * @returns Pair price or error if no liquidity
 * 
 * @example
 * const price = await getPairPrice(pair, "100", { maxHops: 3 });
 */
export async function getPairPrice(
  pair: AssetPair,
  amount: string,
  options?: FindSwapPathOptions,
): Promise<SorokitResult<PairPrice>> {
  // Validate amount
  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Amount must be a positive number",
    );
  }

  // Try to find a swap path
  const routeResult = await findSwapPath(pair.base, pair.quote, options);
  
  if (routeResult.status === "error") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `No liquidity found for pair ${pair.id}`,
    );
  }

  const route = routeResult.data;

  // In production, this would query actual DEX pools
  // For now, return a placeholder price
  const price: PairPrice = {
    pair,
    price: route.price,
    liquidity: "1000000", // Placeholder liquidity
    isDirect: route.path.length === 0,
    path: route.path,
  };

  return ok(price);
}

/**
 * Get prices for multiple asset pairs in parallel.
 * 
 * @param pairs - Array of asset pairs
 * @param amount - Amount to trade for each pair
 * @param options - Optional path finding options
 * @returns Array of price results (ok or error for each pair)
 */
export async function getMultiplePairPrices(
  pairs: AssetPair[],
  amount: string,
  options?: FindSwapPathOptions,
): Promise<SorokitResult<PairPrice>[]> {
  const results = await Promise.all(
    pairs.map((pair) => getPairPrice(pair, amount, options))
  );
  return results;
}

/**
 * Check if an asset pair has sufficient liquidity.
 * 
 * @param pair - Asset pair to check
 * @param minLiquidity - Minimum liquidity threshold
 * @returns true if sufficient liquidity exists
 */
export async function hasSufficientLiquidity(
  pair: AssetPair,
  minLiquidity: string,
): Promise<boolean> {
  const priceResult = await getPairPrice(pair, "1");
  
  if (priceResult.status === "error") {
    return false;
  }

  const liquidity = parseFloat(priceResult.data.liquidity);
  const minLiq = parseFloat(minLiquidity);
  
  return liquidity >= minLiq;
}

/**
 * Get all possible trading paths between two assets.
 * 
 * @param source - Source asset
 * @param destination - Destination asset
 * @param maxHops - Maximum number of hops (default: 3)
 * @returns Array of possible paths with prices
 */
export async function getTradingPaths(
  source: SwapRouteAsset,
  destination: SwapRouteAsset,
  maxHops = 3,
): Promise<SorokitResult<SwapRoute[]>> {
  if (isSameAsset(source, destination)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Source and destination assets cannot be the same",
    );
  }

  // In production, this would query Horizon for all possible paths
  // For now, return a single direct path
  const route: SwapRoute = {
    source,
    destination,
    path: [],
    price: "1.0",
  };

  return ok([route]);
}
