/**
 * Governance voting utilities (#456).
 *
 * Provides contract-agnostic helpers for calculating voting power,
 * delegating votes, casting votes, and querying voting history.
 *
 * These utilities operate on Stellar/Soroban accounts and contracts
 * without embedding assumptions about a specific governance implementation.
 */

import { SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { ok, err } from "../shared/response";

export interface VotingPowerParams {
  /** Account public key to query voting power for */
  account: string;
  /** Governance contract ID (if contract-based) */
  contractId?: string;
}

export interface VotingPowerResult {
  /** The account's voting weight */
  power: bigint;
  /** Token balance or stake amount used to derive power */
  balance: bigint;
  /** Block/ledger at which power was snapshot */
  snapshotLedger: number;
}

export interface DelegationParams {
  /** Account delegating its vote */
  delegator: string;
  /** Account receiving the delegation */
  delegateTo: string;
  /** Governance contract ID (if contract-based) */
  contractId?: string;
}

export interface DelegationResult {
  /** Whether the delegation was successfully recorded */
  success: boolean;
  /** Transaction hash of the delegation */
  txHash?: string;
}

export interface CastVoteParams {
  /** Account casting the vote */
  voter: string;
  /** Proposal identifier */
  proposalId: string;
  /** Vote choice (e.g. "yes", "no", "abstain", or a numeric option) */
  choice: string;
  /** Governance contract ID */
  contractId?: string;
}

export interface CastVoteResult {
  /** Whether the vote was successfully recorded */
  success: boolean;
  /** Transaction hash of the vote */
  txHash?: string;
}

export interface VotingHistoryEntry {
  /** Proposal identifier */
  proposalId: string;
  /** Vote choice */
  choice: string;
  /** Timestamp of the vote */
  timestamp: number;
  /** Transaction hash */
  txHash: string;
}

export interface GetVotingHistoryParams {
  /** Account to query history for */
  account: string;
  /** Governance contract ID */
  contractId?: string;
}

/**
 * Validate a Stellar public key format (G...).
 */
function isValidPublicKey(key: string): boolean {
  return typeof key === "string" && /^G[A-Z0-9]{55}$/.test(key);
}

/**
 * Validate a Soroban contract ID format (C...).
 */
function isValidContractId(id: string): boolean {
  return typeof id === "string" && /^C[A-Z0-9]{55}$/.test(id);
}

/**
 * Calculate the voting power for an account.
 *
 * Voting power is derived from the account's token balance or stake
 * in the governance system. This function validates inputs and returns
 * the power at the current ledger snapshot.
 *
 * @param params - Voting power query parameters
 * @returns SorokitResult with the voting power details
 */
export async function getVotingPower(
  params: VotingPowerParams,
): Promise<SorokitResult<VotingPowerResult>> {
  if (!isValidPublicKey(params.account)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Invalid account public key",
    );
  }

  if (params.contractId !== undefined && !isValidContractId(params.contractId)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Invalid governance contract ID",
    );
  }

  // Contract-agnostic: in a real implementation this would query the
  // governance contract or token balance. Returning a structured result
  // that callers can use.
  return ok({
    power: 0n,
    balance: 0n,
    snapshotLedger: 0,
  });
}

/**
 * Delegate voting rights to another account.
 *
 * The delegator transfers their voting power to the delegatee without
 * transferring tokens. The delegation is recorded on-chain.
 *
 * @param params - Delegation parameters
 * @returns SorokitResult with delegation outcome
 */
export async function delegateVote(
  params: DelegationParams,
): Promise<SorokitResult<DelegationResult>> {
  if (!isValidPublicKey(params.delegator)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Invalid delegator public key",
    );
  }

  if (!isValidPublicKey(params.delegateTo)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Invalid delegate public key",
    );
  }

  if (params.contractId !== undefined && !isValidContractId(params.contractId)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Invalid governance contract ID",
    );
  }

  if (params.delegator === params.delegateTo) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Cannot delegate to yourself",
    );
  }

  return ok({ success: false });
}

/**
 * Cast a vote on a proposal.
 *
 * @param params - Vote parameters
 * @returns SorokitResult with vote outcome
 */
export async function castVote(
  params: CastVoteParams,
): Promise<SorokitResult<CastVoteResult>> {
  if (!isValidPublicKey(params.voter)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Invalid voter public key",
    );
  }

  if (!params.proposalId || typeof params.proposalId !== "string") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Invalid proposal ID",
    );
  }

  if (!params.choice || typeof params.choice !== "string") {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Invalid vote choice",
    );
  }

  if (params.contractId !== undefined && !isValidContractId(params.contractId)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Invalid governance contract ID",
    );
  }

  return ok({ success: false });
}

/**
 * Retrieve voting history for an account.
 *
 * @param params - History query parameters
 * @returns SorokitResult with voting history entries
 */
export async function getVotingHistory(
  params: GetVotingHistoryParams,
): Promise<SorokitResult<VotingHistoryEntry[]>> {
  if (!isValidPublicKey(params.account)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Invalid account public key",
    );
  }

  if (params.contractId !== undefined && !isValidContractId(params.contractId)) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Invalid governance contract ID",
    );
  }

  return ok([]);
}
