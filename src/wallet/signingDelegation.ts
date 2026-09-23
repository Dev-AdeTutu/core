import { hash, xdr } from "@stellar/stellar-sdk";

export interface SigningDelegationSignature {
  signer: string;
  signature: string | xdr.DecoratedSignature;
}

export interface SigningChallenge {
  transactionXdr: string;
  transactionId: string;
  requiredSigners: readonly string[];
  expiresAt: string;
  signatures: readonly SigningDelegationSignature[];
}

export interface CreateSigningChallengeOptions {
  ttlMs?: number;
  expiresAt?: string | Date;
  now?: Date;
}

export interface MergeSignaturesResult {
  complete: boolean;
  transactionXdr: string;
  missingSigners: string[];
  challenge: SigningChallenge;
}

function transactionIdForXdr(transactionXdr: string): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(transactionXdr, "base64");
  return hash(envelope.toXDR()).toString("hex");
}

function normalizeExpiry(options?: CreateSigningChallengeOptions): string {
  if (options?.expiresAt instanceof Date) return options.expiresAt.toISOString();
  if (typeof options?.expiresAt === "string") return new Date(options.expiresAt).toISOString();
  const now = options?.now ?? new Date();
  return new Date(now.getTime() + (options?.ttlMs ?? 5 * 60 * 1000)).toISOString();
}

function assertNotExpired(challenge: SigningChallenge, now = new Date()): void {
  if (Date.parse(challenge.expiresAt) <= now.getTime()) {
    throw new Error("Signing challenge has expired.");
  }
}

function parseSignature(signature: string | xdr.DecoratedSignature): xdr.DecoratedSignature {
  return typeof signature === "string"
    ? xdr.DecoratedSignature.fromXDR(signature, "base64")
    : signature;
}

function getEnvelopeSignatures(envelope: xdr.TransactionEnvelope): xdr.DecoratedSignature[] {
  switch (envelope.switch()) {
    case xdr.EnvelopeType.envelopeTypeTxV0():
      return envelope.v0().signatures();
    case xdr.EnvelopeType.envelopeTypeTx():
      return envelope.v1().signatures();
    case xdr.EnvelopeType.envelopeTypeTxFeeBump():
      return envelope.feeBump().signatures();
    default:
      throw new Error("Unsupported transaction envelope type.");
  }
}

function setEnvelopeSignatures(
  envelope: xdr.TransactionEnvelope,
  signatures: xdr.DecoratedSignature[],
): void {
  switch (envelope.switch()) {
    case xdr.EnvelopeType.envelopeTypeTxV0():
      envelope.v0().signatures(signatures);
      return;
    case xdr.EnvelopeType.envelopeTypeTx():
      envelope.v1().signatures(signatures);
      return;
    case xdr.EnvelopeType.envelopeTypeTxFeeBump():
      envelope.feeBump().signatures(signatures);
      return;
    default:
      throw new Error("Unsupported transaction envelope type.");
  }
}

function addSignature(transactionXdr: string, signature: string | xdr.DecoratedSignature): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(transactionXdr, "base64");
  setEnvelopeSignatures(envelope, [...getEnvelopeSignatures(envelope), parseSignature(signature)]);
  return envelope.toXDR("base64");
}

export function createSigningChallenge(
  transactionXdr: string,
  requiredSigners: string[],
  options?: CreateSigningChallengeOptions,
): SigningChallenge {
  const uniqueSigners = Array.from(new Set(requiredSigners));
  if (uniqueSigners.length === 0) {
    throw new Error("At least one required signer is needed.");
  }
  return Object.freeze({
    transactionXdr,
    transactionId: transactionIdForXdr(transactionXdr),
    requiredSigners: Object.freeze(uniqueSigners),
    expiresAt: normalizeExpiry(options),
    signatures: Object.freeze([]),
  });
}

export function mergeSignatures(
  challenge: SigningChallenge,
  signatures: SigningDelegationSignature[],
  now = new Date(),
): MergeSignaturesResult {
  assertNotExpired(challenge, now);
  if (transactionIdForXdr(challenge.transactionXdr) !== challenge.transactionId) {
    throw new Error("Signing challenge transaction does not match its identifier.");
  }

  const required = new Set(challenge.requiredSigners);
  const collected = new Map<string, SigningDelegationSignature>();
  for (const existing of challenge.signatures) {
    collected.set(existing.signer, existing);
  }

  for (const signature of signatures) {
    if (!required.has(signature.signer)) {
      throw new Error(`Unexpected signer: ${signature.signer}`);
    }
    if (collected.has(signature.signer)) {
      throw new Error(`Duplicate signature for signer: ${signature.signer}`);
    }
    parseSignature(signature.signature);
    collected.set(signature.signer, signature);
  }

  let transactionXdr = challenge.transactionXdr;
  for (const signature of collected.values()) {
    transactionXdr = addSignature(transactionXdr, signature.signature);
  }

  const missingSigners = challenge.requiredSigners.filter((signer) => !collected.has(signer));
  return {
    complete: missingSigners.length === 0,
    transactionXdr,
    missingSigners,
    challenge: Object.freeze({
      ...challenge,
      signatures: Object.freeze(Array.from(collected.values())),
    }),
  };
}
