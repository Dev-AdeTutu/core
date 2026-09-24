import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import type { SorokitLogger } from "../shared/logger";
import type {
  TransactionPage,
  TransactionStreamConfig,
} from "./streamTransactions";
import { applyTransactionFilters } from "./streamTransactions";
import type { TransactionResult } from "./types";

export interface TransactionSSEOptions {
  signal?: AbortSignal | undefined;
  logger?: SorokitLogger | undefined;
  /** Polling generator used when SSE is unavailable or closes before data arrives. */
  fallback: AsyncGenerator<SorokitResult<TransactionPage>>;
}

function mapTransaction(tx: Record<string, unknown>): TransactionResult {
  return {
    hash: String(tx.hash ?? ""),
    status: tx.successful === false ? "failed" : "success",
    ...(typeof tx.ledger_attr === "number" ? { ledger: tx.ledger_attr } : {}),
    ...(typeof tx.created_at === "string" ? { createdAt: tx.created_at } : {}),
    ...(tx.fee_charged !== undefined ? { fee: String(tx.fee_charged) } : {}),
    ...(typeof tx.envelope_xdr === "string" ? { envelopeXdr: tx.envelope_xdr } : {}),
    ...(typeof tx.result_xdr === "string" ? { resultXdr: tx.result_xdr } : {}),
  };
}

function buildUrl(horizonUrl: string, publicKey: string, config: TransactionStreamConfig): string {
  const base = horizonUrl.replace(/\/$/, "");
  const url = new URL(`${base}/accounts/${encodeURIComponent(publicKey)}/transactions`);
  url.searchParams.set("stream", "true");
  url.searchParams.set("limit", String(Math.min(config.limit ?? 10, 200)));
  url.searchParams.set("order", config.order ?? "desc");
  if (config.cursor) url.searchParams.set("cursor", config.cursor);
  return url.toString();
}

async function* readSSE(
  response: Response,
  config: TransactionStreamConfig,
  signal?: AbortSignal,
): AsyncGenerator<SorokitResult<TransactionPage>> {
  if (!response.body) throw new Error("Horizon SSE response did not include a body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let cursor = config.cursor ?? null;
  let emitted = false;

  try {
    while (!signal?.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(data) as Record<string, unknown>;
        } catch (cause) {
          yield err(SorokitErrorCode.TX_FETCH_FAILED, `Invalid Horizon SSE event: ${toMessage(cause)}`, cause);
          continue;
        }
        const transaction = mapTransaction(record);
        const nextCursor = typeof record.paging_token === "string" ? record.paging_token : cursor;
        cursor = nextCursor ?? null;
        emitted = true;
        yield ok({
          transactions: applyTransactionFilters([transaction], config),
          nextCursor: cursor,
        });
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (!signal?.aborted && !emitted) {
    throw new Error("Horizon SSE stream closed before emitting a transaction");
  }
}

/**
 * Stream account transactions from Horizon using Server-Sent Events.
 *
 * A transport failure, unsupported response, or clean close before the first
 * event is surfaced to the caller so the public stream can switch to polling.
 */
export async function* streamTransactionsSSE(
  horizonUrl: string,
  publicKey: string,
  config: TransactionStreamConfig,
  options: TransactionSSEOptions,
): AsyncGenerator<SorokitResult<TransactionPage>> {
  try {
    const response = await fetch(buildUrl(horizonUrl, publicKey, config), {
      headers: { Accept: "text/event-stream" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("text/event-stream")) {
      throw new Error(`Horizon SSE unavailable (${response.status})`);
    }
    yield* readSSE(response, config, options.signal);
  } catch (cause) {
    if (options.signal?.aborted) return;
    options.logger?.debug("transaction.stream.sse", {
      operation: "transaction.stream.sse",
      status: "fallback",
      errorMessage: toMessage(cause),
    });
    yield* options.fallback;
  }
}

export { buildUrl as buildTransactionSSEUrl };
