/**
 * Network module public types.
 * Re-exported from config.ts — consumers import from here, not from config.ts directly.
 * NETWORK_DEFAULTS is re-exported from network/index.ts directly, not from here —
 * see network/index.ts for the canonical value export chain.
 */
export type { NetworkType, NetworkConfig } from "./config";
