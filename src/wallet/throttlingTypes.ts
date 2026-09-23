/**
 * Wallet connection throttling and abuse detection types.
 */

/**
 * Rate limiting rule type.
 */
export enum RateLimitRuleType {
  ALLOWLIST = "allowlist",
  BLOCKLIST = "blocklist",
}

/**
 * Rate limit rule for an origin.
 */
export interface RateLimitRule {
  /** Origin to apply rule to */
  origin: string;
  /** Type of rule */
  type: RateLimitRuleType;
  /** Optional expiration timestamp */
  expiresAt?: number | undefined;
  /** Reason for the rule */
  reason?: string | undefined;
}

/**
 * Connection attempt record.
 */
export interface ConnectionAttempt {
  /** Origin of the connection attempt */
  origin: string;
  /** Timestamp of the attempt */
  timestamp: number;
  /** Whether the attempt succeeded */
  success: boolean;
  /** Reason if failed (e.g., "SIGNATURE_REJECTED", "TIMEOUT") */
  failureReason?: string | undefined;
}

/**
 * Rate limit state for a specific origin.
 */
export interface OriginRateLimitState {
  /** Origin identifier */
  origin: string;
  /** Total connection attempts */
  totalAttempts: number;
  /** Successful connections */
  successfulAttempts: number;
  /** Failed attempts */
  failedAttempts: number;
  /** Failed authentication attempts */
  authenticationFailures: number;
  /** Whether this origin is currently blocked */
  blocked: boolean;
  /** When the block expires (if applicable) */
  blockExpiresAt?: number | undefined;
  /** Reason for blocking */
  blockReason?: string | undefined;
  /** Timestamp of last attempt */
  lastAttemptAt?: number | undefined;
  /** Timestamp of last successful connection */
  lastSuccessAt?: number | undefined;
}

/**
 * Throttling configuration.
 */
export interface ThrottlingConfig {
  /** Maximum connection attempts per time window */
  maxAttemptsPerWindow?: number | undefined;
  /** Time window in milliseconds */
  timeWindowMs?: number | undefined;
  /** Maximum authentication failures before temporary block */
  maxAuthFailures?: number | undefined;
  /** Temporary block duration in milliseconds */
  blockDurationMs?: number | undefined;
  /** Enable origin-based rate limiting */
  enableOriginTracking?: boolean | undefined;
  /** Enable authentication failure tracking */
  enableAuthFailureTracking?: boolean | undefined;
  /** Grace period for legitimate reconnects (ms) */
  reconnectGraceMs?: number | undefined;
  /** Whether throttling is enabled */
  enabled?: boolean | undefined;
}

/**
 * Throttle check result.
 */
export interface ThrottleCheckResult {
  /** Whether the connection should be allowed */
  allowed: boolean;
  /** Reason if denied */
  reason?: string | undefined;
  /** Time until block expires (if applicable) */
  blockExpiresIn?: number | undefined;
  /** Recommended retry time in milliseconds */
  retryAfterMs?: number | undefined;
  /** Current state for the origin */
  state?: OriginRateLimitState | undefined;
}

/**
 * Abuse detection result.
 */
export interface AbuseDetectionResult {
  /** Whether abuse is suspected */
  isSuspicious: boolean;
  /** Confidence score (0-1) */
  confidence: number;
  /** Detected abuse patterns */
  patterns: string[];
  /** Recommendations */
  recommendations: string[];
}

/**
 * Connection statistics.
 */
export interface ConnectionStats {
  /** Total origins tracked */
  totalOrigins: number;
  /** Currently blocked origins */
  blockedOrigins: number;
  /** Allowlisted origins */
  allowlistedOrigins: number;
  /** Blocklisted origins */
  blocklistedOrigins: number;
  /** Total connection attempts */
  totalAttempts: number;
  /** Successful connections */
  successfulConnections: number;
  /** Failed connections */
  failedConnections: number;
}
