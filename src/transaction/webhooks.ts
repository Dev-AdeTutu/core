/**
 * Webhook support for transaction lifecycle events.
 *
 * Allows external services to be notified when transactions are submitted,
 * confirmed, fail, or time out. Supports HMAC-SHA256 signature verification
 * for security, bounded exponential backoff on delivery failures, and a
 * fire-and-forget dispatch path so webhook delivery can never block or fail
 * the underlying transaction flow.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { sleep } from "../shared/utils";
import type { TransactionResult } from "./types";

export type { TransactionResult } from "./types";

/**
 * Canonical transaction lifecycle event types.
 */
export type TransactionWebhookEvent =
  | "tx_submitted"
  | "tx_confirmed"
  | "tx_failed"
  | "tx_timeout";

/**
 * Legacy event names accepted for backward compatibility and normalized to
 * their canonical `tx_*` equivalents.
 */
export type LegacyWebhookEventType = "submitted" | "confirmed" | "failed";

/**
 * Supported webhook event types (canonical or legacy).
 */
export type WebhookEventType = TransactionWebhookEvent | LegacyWebhookEventType;

const CANONICAL_EVENTS: readonly TransactionWebhookEvent[] = [
  "tx_submitted",
  "tx_confirmed",
  "tx_failed",
  "tx_timeout",
];

const LEGACY_EVENT_MAP: Record<LegacyWebhookEventType, TransactionWebhookEvent> = {
  submitted: "tx_submitted",
  confirmed: "tx_confirmed",
  failed: "tx_failed",
};

/**
 * Normalize a (possibly legacy) event name to its canonical form.
 * Returns `undefined` for unknown event names.
 */
function normalizeEvent(event: string): TransactionWebhookEvent | undefined {
  if ((CANONICAL_EVENTS as readonly string[]).includes(event)) {
    return event as TransactionWebhookEvent;
  }
  if (event in LEGACY_EVENT_MAP) {
    return LEGACY_EVENT_MAP[event as LegacyWebhookEventType];
  }
  return undefined;
}

/**
 * Webhook registration configuration.
 */
export interface WebhookRegistration {
  /** Canonical event type subscribed to */
  event: TransactionWebhookEvent;
  /** URL to send webhook payloads to */
  url: string;
  /** Secret key for HMAC signature verification (generate securely!) */
  secret: string;
}

/**
 * Additional transaction details included in webhook payloads when known.
 */
export interface WebhookEventDetails {
  /** Ledger close time of the transaction, when known */
  createdAt?: string;
  /** Fee charged, in stroops, when known */
  fee?: string;
}

/**
 * Webhook payload sent to registered URLs.
 */
export interface WebhookPayload {
  /** Canonical event type */
  event: TransactionWebhookEvent;
  /** Transaction hash */
  txHash: string;
  /** @deprecated Alias of `txHash`, kept for backward compatibility */
  hash: string;
  /** Transaction status */
  status: string;
  /** Ledger sequence (if confirmed) */
  ledger: number | undefined;
  /** ISO-8601 timestamp of when the event was emitted */
  timestamp: string;
  /** Additional transaction details, when known */
  details: WebhookEventDetails;
  /** HMAC-SHA256 signature (hex) */
  signature: string;
}

/**
 * In-memory webhook registry.
 * In production, this should be persisted to a database.
 */
const webhookRegistry = new Map<string, WebhookRegistration>();

/**
 * Generate a unique key for webhook registration. One entry exists per
 * (event, url) pair, so re-registering the same pair overwrites rather than
 * duplicating.
 */
function webhookKey(event: TransactionWebhookEvent, url: string): string {
  return `${event}:${url}`;
}

function validateUrl(url: string): SorokitResult<void> | undefined {
  if (!url || typeof url !== "string") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "URL must be a non-empty string",
    );
  }
  try {
    new URL(url);
  } catch {
    return err(SorokitErrorCode.INVALID_CONFIG, `Invalid URL: ${url}`);
  }
  return undefined;
}

function validateSecret(secret: string): SorokitResult<void> | undefined {
  if (!secret || typeof secret !== "string" || secret.length < 32) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Secret must be a non-empty string with at least 32 characters",
    );
  }
  return undefined;
}

/**
 * Register a webhook endpoint for one or more transaction lifecycle events.
 *
 * @param url - URL to send webhook payloads to
 * @param events - Event types to subscribe the URL to
 * @param secret - Secret key for HMAC signature verification (use secure random!)
 * @returns ok(void) on success, error on invalid input
 *
 * @example
 * const result = registerWebhook(
 *   "https://example.com/webhook",
 *   ["tx_confirmed", "tx_failed"],
 *   "secure-random-secret-key-32-chars-min",
 * );
 */
export function registerWebhook(
  url: string,
  events: WebhookEventType[],
  secret: string,
): SorokitResult<void>;
/**
 * Register a webhook for a single transaction event (legacy signature).
 *
 * @deprecated Prefer `registerWebhook(url, events, secret)`.
 */
export function registerWebhook(
  event: WebhookEventType,
  url: string,
  secret: string,
): SorokitResult<void>;
export function registerWebhook(
  first: string,
  second: WebhookEventType[] | string,
  secret: string,
): SorokitResult<void> {
  const url = Array.isArray(second) ? first : second;
  const rawEvents = Array.isArray(second) ? second : [first];

  if (Array.isArray(second) && second.length === 0) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "At least one event type must be provided",
    );
  }

  const normalized: TransactionWebhookEvent[] = [];
  for (const rawEvent of rawEvents) {
    const event = normalizeEvent(rawEvent);
    if (!event) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Invalid event type: ${rawEvent}. Must be one of: ${CANONICAL_EVENTS.join(", ")} (legacy: submitted, confirmed, failed)`,
      );
    }
    normalized.push(event);
  }

  const urlError = validateUrl(url);
  if (urlError) return urlError;

  const secretError = validateSecret(secret);
  if (secretError) return secretError;

  // De-duplicated by construction: repeated events in the list and repeated
  // registrations of the same (event, url) pair collapse to a single entry.
  for (const event of normalized) {
    webhookRegistry.set(webhookKey(event, url), { event, url, secret });
  }

  return ok(undefined);
}

/**
 * Unregister a webhook.
 */
export function unregisterWebhook(
  event: WebhookEventType,
  url: string,
): SorokitResult<void> {
  const normalized = normalizeEvent(event);
  if (!normalized) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `Invalid event type: ${event}`,
    );
  }

  const key = webhookKey(normalized, url);
  if (!webhookRegistry.has(key)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      `Webhook not found for event: ${event}, url: ${url}`,
    );
  }

  webhookRegistry.delete(key);
  return ok(undefined);
}

/**
 * List all registered webhooks for an event type.
 */
export function listWebhooks(event: WebhookEventType): WebhookRegistration[] {
  const normalized = normalizeEvent(event);
  if (!normalized) return [];

  const results: WebhookRegistration[] = [];
  for (const registration of webhookRegistry.values()) {
    if (registration.event === normalized) {
      results.push(registration);
    }
  }
  return results;
}

/**
 * Clear all registered webhooks.
 */
export function clearWebhooks(): void {
  webhookRegistry.clear();
}

/**
 * Copy encoded bytes into a plain ArrayBuffer so WebCrypto accepts them
 * regardless of whether the runtime backs Uint8Array with a SharedArrayBuffer.
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return copy;
}

/**
 * Generate HMAC-SHA256 signature for webhook payload.
 *
 * @param payload - JSON stringified payload (without signature field)
 * @param secret - Secret key for HMAC
 * @returns Hex-encoded signature
 */
async function generateSignature(
  payload: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = toArrayBuffer(encoder.encode(secret));
  const payloadData = toArrayBuffer(encoder.encode(payload));

  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    payloadData,
  );

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify HMAC-SHA256 signature for webhook payload.
 *
 * @param payload - JSON stringified payload (without signature field)
 * @param signature - Hex-encoded signature to verify
 * @param secret - Secret key for HMAC
 * @returns true if signature is valid
 */
export async function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const expectedSignature = await generateSignature(payload, secret);
  return signature === expectedSignature;
}

/** Maximum backoff delay between retry attempts. */
const MAX_BACKOFF_MS = 8000;

/**
 * Send webhook payload with bounded exponential backoff retry logic.
 *
 * @param registration - Webhook registration
 * @param payload - Payload to send
 * @param maxRetries - Maximum retry attempts (default: 3)
 * @returns ok(void) on success, error on final failure
 */
async function sendWebhookWithRetry(
  registration: WebhookRegistration,
  payload: WebhookPayload,
  maxRetries = 3,
): Promise<SorokitResult<void>> {
  const { url } = registration;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sorokit-Signature": payload.signature,
          "X-Sorokit-Event": payload.event,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000), // 10 second timeout per attempt
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return ok(undefined);
    } catch (error) {
      lastError = error;

      // Don't sleep after the last attempt
      if (attempt < maxRetries) {
        // Bounded exponential backoff: 1s, 2s, 4s, capped at MAX_BACKOFF_MS
        const delayMs = Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
        await sleep(delayMs);
      }
    }
  }

  return err(
    SorokitErrorCode.NETWORK_ERROR,
    `Webhook delivery failed after ${maxRetries + 1} attempts to ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    lastError,
  );
}

/**
 * Trigger webhooks for a transaction event and wait for delivery results.
 *
 * Deliveries to multiple registered endpoints run concurrently; each result
 * is reported independently so one failing endpoint cannot mask another.
 *
 * @param event - Event type (canonical or legacy)
 * @param transaction - Transaction result
 * @returns Array of results for each webhook (ok or error)
 */
export async function triggerWebhooks(
  event: WebhookEventType,
  transaction: TransactionResult,
): Promise<SorokitResult<void>[]> {
  const normalized = normalizeEvent(event);
  if (!normalized) return [];

  const registrations = listWebhooks(normalized);
  if (registrations.length === 0) {
    return [];
  }

  const details: WebhookEventDetails = {
    ...(transaction.createdAt !== undefined
      ? { createdAt: transaction.createdAt }
      : {}),
    ...(transaction.fee !== undefined ? { fee: transaction.fee } : {}),
  };

  return Promise.all(
    registrations.map(async (registration) => {
      // Create payload without signature
      const payloadWithoutSignature = {
        event: normalized,
        txHash: transaction.hash,
        hash: transaction.hash,
        status: transaction.status,
        ledger: transaction.ledger,
        timestamp: new Date().toISOString(),
        details,
      };

      const payloadString = JSON.stringify(payloadWithoutSignature);
      const signature = await generateSignature(
        payloadString,
        registration.secret,
      );

      const payload: WebhookPayload = {
        ...payloadWithoutSignature,
        signature,
      };

      return sendWebhookWithRetry(registration, payload);
    }),
  );
}

/**
 * Fire-and-forget dispatch of a transaction lifecycle event to registered
 * webhooks.
 *
 * Unlike {@link triggerWebhooks}, this never throws, never rejects, and does
 * not block the caller on delivery or retries — transaction processing must
 * proceed regardless of webhook endpoint health. Delivery failures are
 * reported per-endpoint by `triggerWebhooks` and intentionally swallowed
 * here.
 *
 * @param event - Event type (canonical or legacy)
 * @param transaction - Transaction result
 */
export function dispatchTransactionEvent(
  event: WebhookEventType,
  transaction: TransactionResult,
): void {
  try {
    void triggerWebhooks(event, transaction).catch(() => {
      // Swallow: webhook delivery must never surface into transaction flow.
    });
  } catch {
    // Defensive: even synchronous failures must not propagate.
  }
}
