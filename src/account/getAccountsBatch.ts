import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { toMessage } from "../shared";
import { getAccount } from "./getAccount";
import type { SorokitCache } from "../shared/cache";
import type { AccountInfo, AccountMetadata } from "./types";

export interface GetAccountsBatchOptions {
  signal?: AbortSignal | undefined;
  cache?: SorokitCache;
  ttlMs?: number;
  includeMetadata?: false;
}

export interface GetAccountsBatchWithMetadataOptions
  extends Omit<GetAccountsBatchOptions, "includeMetadata"> {
  includeMetadata: true;
}

export interface AccountBatchEntry {
  account: SorokitResult<AccountInfo>;
  metadata?: SorokitResult<AccountMetadata>;
}

export type AccountBatchResult = SorokitResult<AccountInfo>[] | AccountBatchEntry[];

const inFlightAccounts = new Map<string, Promise<SorokitResult<AccountInfo>>>();

function createAccountCacheKey(horizonUrl: string, publicKey: string): string {
  return `account:get:${horizonUrl}:${publicKey}`;
}

function createAccountMetadataCacheKey(horizonUrl: string, publicKey: string): string {
  return `account:metadata:${horizonUrl}:${publicKey}`;
}

function accountInfoToMetadata(account: AccountInfo): AccountMetadata {
  return {
    publicKey: account.publicKey,
    sequence: account.sequence,
    subentryCount: account.subentryCount,
  };
}

function getCachedAccount(
  cache: SorokitCache | undefined,
  horizonUrl: string,
  publicKey: string,
): SorokitResult<AccountInfo> | undefined {
  const cached = cache?.get(createAccountCacheKey(horizonUrl, publicKey));
  return cached ? ok(cached as AccountInfo) : undefined;
}

async function fetchDedupedAccount(
  horizonUrl: string,
  publicKey: string,
  options?: GetAccountsBatchOptions | GetAccountsBatchWithMetadataOptions,
): Promise<SorokitResult<AccountInfo>> {
  const cached = getCachedAccount(options?.cache, horizonUrl, publicKey);
  if (cached) return cached;

  const key = createAccountCacheKey(horizonUrl, publicKey);
  const existing = inFlightAccounts.get(key);
  if (existing) return existing;

  const pending = getAccount(horizonUrl, publicKey, { signal: options?.signal })
    .then((result) => {
      if (result.status === "ok") {
        options?.cache?.set(key, result.data, options?.ttlMs);
        options?.cache?.set(
          createAccountMetadataCacheKey(horizonUrl, publicKey),
          accountInfoToMetadata(result.data),
          options?.ttlMs,
        );
      }
      return result;
    })
    .finally(() => {
      inFlightAccounts.delete(key);
    });

  inFlightAccounts.set(key, pending);
  return pending;
}

function getMetadataResult(
  cache: SorokitCache | undefined,
  horizonUrl: string,
  publicKey: string,
  account: SorokitResult<AccountInfo>,
): SorokitResult<AccountMetadata> {
  const cached = cache?.get(createAccountMetadataCacheKey(horizonUrl, publicKey));
  if (cached) return ok(cached as AccountMetadata);
  if (account.status === "ok") return ok(accountInfoToMetadata(account.data));
  return account;
}

/**
 * Fetch full account details for multiple accounts in parallel from Horizon.
 * Uses Promise.allSettled so a single account failure never blocks the rest.
 * Returns an array of individual results, each carrying its own ok/error status.
 */
export function getAccountsBatch(
  horizonUrl: string,
  publicKeys: string[],
  options?: GetAccountsBatchOptions,
): Promise<SorokitResult<SorokitResult<AccountInfo>[]>>;
export function getAccountsBatch(
  horizonUrl: string,
  publicKeys: string[],
  options: GetAccountsBatchWithMetadataOptions,
): Promise<SorokitResult<AccountBatchEntry[]>>;
export async function getAccountsBatch(
  horizonUrl: string,
  publicKeys: string[],
  options?: GetAccountsBatchOptions | GetAccountsBatchWithMetadataOptions,
): Promise<SorokitResult<AccountBatchResult>> {
  try {
    if (!Array.isArray(publicKeys) || publicKeys.length === 0) {
      return ok([]);
    }

    const uniqueKeys = Array.from(new Set(publicKeys));
    const settled = await Promise.allSettled(
      uniqueKeys.map((publicKey) => fetchDedupedAccount(horizonUrl, publicKey, options)),
    );

    const resultMap = new Map<string, SorokitResult<AccountInfo>>();
    uniqueKeys.forEach((key, index) => {
      const r = settled[index]!;
      resultMap.set(
        key,
        r.status === "fulfilled"
          ? r.value
          : err(
              SorokitErrorCode.ACCOUNT_FETCH_FAILED,
              `Failed to fetch account: ${toMessage(r.reason)}`,
              r.reason,
            ),
      );
    });

    if (options?.includeMetadata) {
      const results: AccountBatchEntry[] = publicKeys.map((key) => {
        const account = resultMap.get(key)!;
        return {
          account,
          metadata: getMetadataResult(options.cache, horizonUrl, key, account),
        };
      });
      return ok(results);
    }

    const results: SorokitResult<AccountInfo>[] = publicKeys.map((key) => resultMap.get(key)!);
    return ok(results);
  } catch (cause) {
    return err(
      SorokitErrorCode.UNKNOWN,
      `Failed to execute batch accounts fetch: ${toMessage(cause)}`,
      cause,
    );
  }
}
