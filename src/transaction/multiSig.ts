import { TransactionBuilder } from "@stellar/stellar-sdk";
import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isXdrInvalidError, toMessage } from "../shared";
import type { MultiSigEnvelope, MultiSigEnvelopeParams, MultiSigSigner } from "./types";

/**
 * Build a MultiSigEnvelope from an existing unsigned transaction XDR.
 *
 * Validates that:
 * - The XDR is parseable
 * - At least one signer is provided
 * - All signer weights are >= 1
 * - The threshold is >= 1 and <= total declared weight
 *
 * Does NOT sign the envelope — use collectSignature() to add signatures.
 *
 * @param transactionXdr  - Unsigned transaction XDR produced by any buildXxx() function.
 * @param networkPassphrase - Network passphrase the transaction was built for.
 * @param params          - Signers list and threshold.
 * @returns `ok(MultiSigEnvelope)` ready for incremental signing, or an error.
 */
export function buildMultiSigEnvelope(
  transactionXdr: string,
  networkPassphrase: string,
  params: Pick<MultiSigEnvelopeParams, "signers" | "threshold">,
): SorokitResult<MultiSigEnvelope> {
  if (isXdrInvalidError(transactionXdr)) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "buildMultiSigEnvelope: the provided transaction XDR is malformed.",
      transactionXdr,
    );
  }

  if (!params.signers || params.signers.length === 0) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      "buildMultiSigEnvelope: at least one signer is required.",
    );
  }

  for (const signer of params.signers) {
    if (signer.weight < 1) {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        `buildMultiSigEnvelope: signer ${signer.publicKey} has invalid weight ${signer.weight} — must be >= 1.`,
      );
    }
  }

  const totalWeight = params.signers.reduce((sum, s) => sum + s.weight, 0);

  if (params.threshold < 1) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `buildMultiSigEnvelope: threshold must be >= 1 (got ${params.threshold}).`,
    );
  }

  if (params.threshold > totalWeight) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `buildMultiSigEnvelope: threshold (${params.threshold}) exceeds total declared signer weight (${totalWeight}).`,
    );
  }

  // Verify the XDR parses against the given network passphrase
  try {
    TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  } catch (cause) {
    return err(
      SorokitErrorCode.TX_BUILD_FAILED,
      `buildMultiSigEnvelope: XDR parse failed — ${toMessage(cause)}`,
      cause,
    );
  }

  return ok({
    envelopeXdr: transactionXdr,
    signers: params.signers,
    threshold: params.threshold,
    collectedSigners: [],
    collectedWeight: 0,
    thresholdMet: false,
  });
}

/**
 * Add a signature to a MultiSigEnvelope.
 *
 * The `signFn` receives the current envelope XDR and the signer's public key,
 * and must return the XDR with that signer's DecoratedSignature appended.
 * (Pass `adapter.signTransaction()` or any compatible signing function.)
 *
 * Validates that:
 * - The signer is declared in the envelope's signers list
 * - The signer has not already signed
 *
 * Returns an updated envelope with collectedWeight and thresholdMet recalculated.
 * Does NOT submit — call submitTransaction() once thresholdMet is true.
 *
 * @param envelope  - Current MultiSigEnvelope state.
 * @param signerKey - Public key of the signer adding their signature.
 * @param signFn    - Async function that signs the XDR and returns the signed XDR.
 * @returns `ok(MultiSigEnvelope)` with updated signature state, or an error.
 */
export async function collectSignature(
  envelope: MultiSigEnvelope,
  signerKey: string,
  signFn: (envelopeXdr: string, signerPublicKey: string) => Promise<SorokitResult<string>>,
): Promise<SorokitResult<MultiSigEnvelope>> {
  const signerEntry = envelope.signers.find((s) => s.publicKey === signerKey);

  if (!signerEntry) {
    return err(
      SorokitErrorCode.WALLET_SIGN_FAILED,
      `collectSignature: signer ${signerKey} is not declared in this envelope's signers list.`,
    );
  }

  if (envelope.collectedSigners.includes(signerKey)) {
    return err(
      SorokitErrorCode.WALLET_SIGN_FAILED,
      `collectSignature: signer ${signerKey} has already signed this envelope.`,
    );
  }

  const signResult = await signFn(envelope.envelopeXdr, signerKey);
  if (signResult.status === "error") return signResult;

  const newCollectedSigners = [...envelope.collectedSigners, signerKey];
  const newCollectedWeight = envelope.collectedWeight + signerEntry.weight;

  return ok({
    ...envelope,
    envelopeXdr: signResult.data,
    collectedSigners: newCollectedSigners,
    collectedWeight: newCollectedWeight,
    thresholdMet: newCollectedWeight >= envelope.threshold,
  });
}

/**
 * Validate that a MultiSigEnvelope has met its threshold before submission.
 *
 * Returns `ok(envelopeXdr)` — the fully-signed XDR ready to pass to submitTransaction() —
 * or an error listing the remaining weight needed.
 */
export function validateMultiSigThreshold(
  envelope: MultiSigEnvelope,
): SorokitResult<string> {
  if (!envelope.thresholdMet) {
    const remaining = envelope.threshold - envelope.collectedWeight;
    return err(
      SorokitErrorCode.TX_SUBMIT_FAILED,
      `validateMultiSigThreshold: threshold not met — ${remaining} more weight units required (collected ${envelope.collectedWeight}/${envelope.threshold}).`,
    );
  }
  return ok(envelope.envelopeXdr);
}
