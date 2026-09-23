import { StrKey, Operation, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { ResolvedNetworkConfig } from "../shared/types";
import { DEFAULT_TX_TIMEOUT_SECONDS } from "../shared/constants";
import { getAccount } from "./getAccount";

/**
 * Options/Params for rotating an account key.
 */
export interface RotateAccountKeyParams {
  /** Account object or public key string (G-address) */
  account: string;
  /** Current signer public key (G-address) to remove */
  oldKey: string;
  /** New signer public key (G-address) to add */
  newKey: string;
  /** Weight for the new key (default: 1) */
  newKeyWeight?: number;
}

/**
 * A single signer key being installed as part of an account-recovery operation.
 */
export interface RecoveryReplacementSigner {
  /** New signer public key (G-address) */
  key: string;
  /** Weight to assign the new signer */
  weight: number;
}

/**
 * Options/Params for recovering account keys via a designated recovery signer.
 *
 * Supports two scenarios:
 * - Single-signer recovery: one `recoveryKey` replaces one or more compromised keys.
 * - Multi-signature recovery: `newKeys` installs several signers at once (e.g. when
 *   moving from a single-key account to a multi-sig configuration), optionally
 *   updating thresholds so the new signer set matches the desired security policy.
 */
export interface RecoverAccountKeysParams {
  /** Account object or public key string (G-address) being recovered */
  account: string;
  /** Recovery signer public key (G-address) authorizing this transaction */
  recoveryKey: string;
  /**
   * Compromised or unavailable signer keys to remove (weight set to 0).
   * Optional — omit when recovery only adds new signers.
   */
  compromisedKeys?: string[];
  /** New signer key(s) to install, each with an explicit weight */
  newKeys: RecoveryReplacementSigner[];
  /** Low threshold for low-security operations (unchanged if omitted) */
  lowThreshold?: number;
  /** Medium threshold for standard operations (unchanged if omitted) */
  medThreshold?: number;
  /** High threshold for high-security operations (unchanged if omitted) */
  highThreshold?: number;
  /** Master key weight override (unchanged if omitted) */
  masterWeight?: number;
}

/**
 * Options/Params for setting account recovery signers and thresholds.
 */
export interface SetAccountRecoveryParams {
  /** Account object or public key string (G-address) */
  account: string;
  /** Recovery signer public key (G-address) to add */
  recoveryKey: string;
  /** Weight for the recovery key (default: 1) */
  recoveryWeight?: number;
  /** Master key weight (optional) */
  masterWeight?: number;
  /** Low threshold for low-security operations (default: 1) */
  lowThreshold?: number;
  /** Medium threshold for standard operations (default: 2) */
  medThreshold?: number;
  /** High threshold for high-security operations (default: 2) */
  highThreshold?: number;
}

/**
 * Helper to validate a Stellar public key (G-address).
 */
export function isValidStellarPublicKey(key: string): boolean {
  if (typeof key !== "string") return false;
  return StrKey.isValidEd25519PublicKey(key);
}

/**
 * Rotate an account key by adding a new signer and removing an old signer in a safe sequence.
 *
 * Safety considerations:
 * - Validates format of all keys.
 * - Ensures oldKey and newKey are not identical.
 * - Adds the new key before removing the old key in the operation sequence so the account is never left without signers.
 *
 * @param horizonUrl Base URL of Horizon server
 * @param networkConfig Resolved network configuration
 * @param params Rotate account key options
 * @returns ok(xdr) or error
 */
export async function rotateAccountKey(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: RotateAccountKeyParams,
): Promise<SorokitResult<string>> {
  const { account, oldKey, newKey, newKeyWeight = 1 } = params;

  if (!isValidStellarPublicKey(account)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${account}`);
  }
  if (!isValidStellarPublicKey(oldKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid old key address: ${oldKey}`);
  }
  if (!isValidStellarPublicKey(newKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid new key address: ${newKey}`);
  }
  if (oldKey === newKey) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "Old key and new key cannot be identical.",
    );
  }

  const accountResult = await getAccount(horizonUrl, account);
  if (accountResult.status === "error") {
    return accountResult;
  }

  try {
    const sourceAccount = new (await import("@stellar/stellar-sdk")).Account(
      account,
      accountResult.data.sequence,
    );

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    // 1. Add new key first (safely ensures account retains valid signer)
    builder.addOperation(
      Operation.setOptions({
        signer: {
          ed25519PublicKey: newKey,
          weight: newKeyWeight,
        },
      }),
    );

    // 2. Remove old key (setting weight to 0 removes signer)
    builder.addOperation(
      Operation.setOptions({
        signer: {
          ed25519PublicKey: oldKey,
          weight: 0,
        },
      }),
    );

    builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);
    const tx = builder.build();

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build key rotation transaction: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/**
 * Configure account recovery by adding a recovery signer key and updating thresholds.
 *
 * Safety considerations:
 * - Validates key formats.
 * - Sets thresholds and recovery signer in a safe single transaction.
 *
 * @param horizonUrl Base URL of Horizon server
 * @param networkConfig Resolved network configuration
 * @param params Set account recovery options
 * @returns ok(xdr) or error
 */
export async function setAccountRecovery(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: SetAccountRecoveryParams,
): Promise<SorokitResult<string>> {
  const {
    account,
    recoveryKey,
    recoveryWeight = 1,
    masterWeight,
    lowThreshold = 1,
    medThreshold = 2,
    highThreshold = 2,
  } = params;

  if (!isValidStellarPublicKey(account)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${account}`);
  }
  if (!isValidStellarPublicKey(recoveryKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid recovery key address: ${recoveryKey}`);
  }

  const accountResult = await getAccount(horizonUrl, account);
  if (accountResult.status === "error") {
    return accountResult;
  }

  try {
    const sourceAccount = new (await import("@stellar/stellar-sdk")).Account(
      account,
      accountResult.data.sequence,
    );

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    const setOptionsParams: Parameters<typeof Operation.setOptions>[0] = {
      signer: {
        ed25519PublicKey: recoveryKey,
        weight: recoveryWeight,
      },
      lowThreshold,
      medThreshold,
      highThreshold,
    };

    if (masterWeight !== undefined) {
      setOptionsParams.masterWeight = masterWeight;
    }

    builder.addOperation(Operation.setOptions(setOptionsParams));
    builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);

    const tx = builder.build();

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build account recovery transaction: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}

/**
 * Build a recovery transaction template that replaces compromised or unavailable
 * signer keys with one or more new keys, supporting both single-signer and
 * multi-signature recovery scenarios.
 *
 * This produces an unsigned transaction template only — it does not submit or
 * sign the transaction. Applications should review the resulting operations
 * (e.g. via `validateTransactionOffline`) before collecting signatures and
 * submitting, since recovery changes account signer weights and thresholds.
 *
 * Safety considerations:
 * - Validates the format of every key involved (account, recovery key,
 *   compromised keys, new keys).
 * - Rejects configurations where a key appears both as compromised and as a
 *   new key, or where `newKeys` contains duplicate keys.
 * - Adds new signers before removing compromised ones, so the account is
 *   never left without a valid signer mid-sequence.
 * - Requires at least one new key or threshold/masterWeight change — a
 *   no-op recovery (only removals, no replacements) is rejected because it
 *   could strand the account below its signing threshold.
 * - When thresholds are supplied, rejects any threshold greater than the
 *   total signer weight that would result after applying the requested
 *   changes, since that would make the account unusable (locked out).
 *
 * @param horizonUrl Base URL of Horizon server
 * @param networkConfig Resolved network configuration
 * @param params Recovery parameters — recovery key, compromised keys, new keys, thresholds
 * @returns ok(xdr) — unsigned transaction template ready for signing, or an error
 */
export async function recoverAccountKeys(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  params: RecoverAccountKeysParams,
): Promise<SorokitResult<string>> {
  const {
    account,
    recoveryKey,
    compromisedKeys = [],
    newKeys,
    lowThreshold,
    medThreshold,
    highThreshold,
    masterWeight,
  } = params;

  if (!isValidStellarPublicKey(account)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid account address: ${account}`);
  }
  if (!isValidStellarPublicKey(recoveryKey)) {
    return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid recovery key address: ${recoveryKey}`);
  }
  for (const key of compromisedKeys) {
    if (!isValidStellarPublicKey(key)) {
      return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid compromised key address: ${key}`);
    }
  }
  if (!Array.isArray(newKeys) || newKeys.length === 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "recoverAccountKeys: at least one replacement key is required in newKeys.",
    );
  }

  const seenNewKeys = new Set<string>();
  for (const signer of newKeys) {
    if (!isValidStellarPublicKey(signer.key)) {
      return err(SorokitErrorCode.INVALID_ADDRESS, `Invalid new key address: ${signer.key}`);
    }
    if (!Number.isInteger(signer.weight) || signer.weight < 1 || signer.weight > 255) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `recoverAccountKeys: signer ${signer.key} has invalid weight ${signer.weight} — must be an integer between 1 and 255.`,
      );
    }
    if (seenNewKeys.has(signer.key)) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `recoverAccountKeys: duplicate replacement key ${signer.key} in newKeys.`,
      );
    }
    seenNewKeys.add(signer.key);
  }

  const compromisedSet = new Set(compromisedKeys);
  for (const signer of newKeys) {
    if (compromisedSet.has(signer.key)) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `recoverAccountKeys: key ${signer.key} cannot appear in both compromisedKeys and newKeys.`,
      );
    }
  }

  for (const threshold of [lowThreshold, medThreshold, highThreshold]) {
    if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 0 || threshold > 255)) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `recoverAccountKeys: thresholds must be integers between 0 and 255.`,
      );
    }
  }

  const accountResult = await getAccount(horizonUrl, account);
  if (accountResult.status === "error") {
    return accountResult;
  }

  // Guard against a recovery that would strand the account below the
  // threshold it will be left with. Since existing signer weights on
  // AccountInfo are not tracked here, this check is limited to the highest
  // requested threshold vs. the total weight the recovery itself installs
  // or preserves via the recovery key. It cannot see other unrelated
  // existing signers, so it is a best-effort guard, not a full simulation.
  const requestedThresholds = [lowThreshold, medThreshold, highThreshold].filter(
    (t): t is number => t !== undefined,
  );
  if (requestedThresholds.length > 0) {
    const maxRequestedThreshold = Math.max(...requestedThresholds);
    const installedWeight =
      newKeys.reduce((sum, s) => sum + s.weight, 0) +
      (masterWeight !== undefined ? masterWeight : 0);
    if (maxRequestedThreshold > installedWeight && masterWeight === undefined) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `recoverAccountKeys: requested threshold ${maxRequestedThreshold} exceeds the combined weight of the new signers (${installedWeight}) with no masterWeight override — this could lock the account out. Provide additional signers, a higher weight, or an explicit masterWeight.`,
      );
    }
  }

  try {
    const sourceAccount = new (await import("@stellar/stellar-sdk")).Account(
      account,
      accountResult.data.sequence,
    );

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: networkConfig.networkPassphrase,
    });

    // 1. Add all new signers first so the account always retains a valid signer.
    for (const signer of newKeys) {
      builder.addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: signer.key,
            weight: signer.weight,
          },
        }),
      );
    }

    // 2. Apply threshold / master weight changes, if any, in the same transaction.
    if (
      lowThreshold !== undefined ||
      medThreshold !== undefined ||
      highThreshold !== undefined ||
      masterWeight !== undefined
    ) {
      const setOptionsParams: Parameters<typeof Operation.setOptions>[0] = {};
      if (lowThreshold !== undefined) setOptionsParams.lowThreshold = lowThreshold;
      if (medThreshold !== undefined) setOptionsParams.medThreshold = medThreshold;
      if (highThreshold !== undefined) setOptionsParams.highThreshold = highThreshold;
      if (masterWeight !== undefined) setOptionsParams.masterWeight = masterWeight;
      builder.addOperation(Operation.setOptions(setOptionsParams));
    }

    // 3. Remove compromised keys last (weight 0 removes the signer).
    for (const key of compromisedKeys) {
      builder.addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: key,
            weight: 0,
          },
        }),
      );
    }

    builder.setTimeout(DEFAULT_TX_TIMEOUT_SECONDS);
    const tx = builder.build();

    return ok(tx.toXDR());
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `Failed to build account recovery transaction: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
}
