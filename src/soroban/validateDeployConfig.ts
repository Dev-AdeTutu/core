/**
 * Deployment configuration validation (#356).
 *
 * Deployment used to fail late and vaguely: a missing RPC URL surfaced as an
 * opaque fetch error, an empty Horizon URL as an SDK constructor throw, and a
 * malformed deployer address only failed once Horizon had already been called.
 *
 * This module validates every required deployment value *before* any network
 * call happens, collects all problems in one pass, and reports each one with
 * the field name, what is wrong, and how to fix it. It is a pure pre-flight
 * check — it never performs I/O and never changes deployment behaviour.
 */

import { ok, err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isValidPublicKey } from "../shared/utils";
import type { ResolvedNetworkConfig } from "../shared/types";

/** Number of bytes a contract deployment salt must contain. */
export const DEPLOY_SALT_BYTES = 32;

/**
 * A single problem found in a deployment configuration.
 *
 * Issues are data, not strings, so deployment scripts can render them however
 * they like (table, JSON, exit code per field) instead of parsing a message.
 */
export interface DeployConfigIssue {
  /** Config field the problem belongs to, e.g. "rpcUrl" or "networkConfig.networkPassphrase" */
  field: string;
  /** What is wrong with the current value */
  reason: string;
  /** Concrete action that resolves the problem */
  hint: string;
}

/**
 * Deployment configuration as supplied by a caller.
 *
 * Every field is optional so that values missing at runtime — the exact case
 * this validation exists for — can be reported instead of crashing.
 */
export interface DeployConfigInput {
  /** Soroban RPC endpoint used for simulation */
  rpcUrl?: string | undefined;
  /** Horizon endpoint used to load the deployer account */
  horizonUrl?: string | undefined;
  /** Resolved network configuration (network name + passphrase) */
  networkConfig?: ResolvedNetworkConfig | undefined;
  /** Stellar public key (G...) of the account deploying the contract */
  deployer?: string | undefined;
  /** Optional 32-byte salt used to derive the contract address */
  salt?: Buffer | undefined;
}

/**
 * A deployment configuration that passed validation.
 * Required fields are guaranteed present and well-formed.
 */
export interface ValidatedDeployConfig {
  rpcUrl: string;
  horizonUrl: string;
  networkConfig: ResolvedNetworkConfig;
  deployer: string;
}

/** Check that a value is a non-empty string once trimmed. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Check that a string is an absolute http(s) URL. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate a required endpoint URL and push any problem onto `issues`.
 */
function checkEndpoint(
  issues: DeployConfigIssue[],
  field: string,
  value: unknown,
  purpose: string,
  example: string,
): void {
  if (value === undefined || value === null || value === "") {
    issues.push({
      field,
      reason: `${field} is missing`,
      hint: `Set ${field} to ${purpose} (e.g. "${example}"), or read it from NETWORK_DEFAULTS[network].`,
    });
    return;
  }
  if (!isNonEmptyString(value)) {
    issues.push({
      field,
      reason: `${field} must be a non-empty string, received ${typeof value}`,
      hint: `Set ${field} to ${purpose} (e.g. "${example}").`,
    });
    return;
  }
  if (!isHttpUrl(value.trim())) {
    issues.push({
      field,
      reason: `${field} is not a valid http(s) URL: "${value}"`,
      hint: `Use an absolute URL including the scheme (e.g. "${example}").`,
    });
  }
}

/**
 * Collect every problem in a deployment configuration.
 *
 * Returns an empty array when the configuration is usable. All fields are
 * checked on every call so a caller sees all problems at once instead of
 * fixing them one failed deployment at a time.
 *
 * @param config - Deployment configuration to inspect
 * @returns All issues found, in field order
 *
 * @example
 * const issues = collectDeployConfigIssues({ deployer: "not-a-key" });
 * // → [{ field: "rpcUrl", ... }, { field: "horizonUrl", ... }, ...]
 */
export function collectDeployConfigIssues(
  config: DeployConfigInput,
): DeployConfigIssue[] {
  const issues: DeployConfigIssue[] = [];

  checkEndpoint(
    issues,
    "rpcUrl",
    config.rpcUrl,
    "the Soroban RPC endpoint used to simulate the deployment",
    "https://soroban-testnet.stellar.org",
  );

  checkEndpoint(
    issues,
    "horizonUrl",
    config.horizonUrl,
    "the Horizon endpoint used to load the deployer account",
    "https://horizon-testnet.stellar.org",
  );

  const networkConfig = config.networkConfig;
  if (networkConfig === undefined || networkConfig === null) {
    issues.push({
      field: "networkConfig",
      reason: "networkConfig is missing",
      hint:
        "Pass the resolved network config — `client.networkConfig`, " +
        "`resolveNetwork(network)`, or `NETWORK_DEFAULTS[network]`.",
    });
  } else if (typeof networkConfig !== "object") {
    issues.push({
      field: "networkConfig",
      reason: `networkConfig must be an object, received ${typeof networkConfig}`,
      hint: "Pass the object returned by `resolveNetwork(network)`.",
    });
  } else {
    if (!isNonEmptyString(networkConfig.networkPassphrase)) {
      issues.push({
        field: "networkConfig.networkPassphrase",
        reason: "networkConfig.networkPassphrase is missing or empty",
        hint:
          "Every Stellar transaction must be signed against a passphrase — " +
          'use `NETWORK_DEFAULTS[network].networkPassphrase` (e.g. "Test SDF Network ; September 2015").',
      });
    }
    if (!isNonEmptyString(networkConfig.network)) {
      issues.push({
        field: "networkConfig.network",
        reason: "networkConfig.network is missing or empty",
        hint: 'Set networkConfig.network to "mainnet", "testnet", or "futurenet".',
      });
    }
  }

  const deployer = config.deployer;
  if (deployer === undefined || deployer === null || deployer === "") {
    issues.push({
      field: "deployer",
      reason: "deployer account is missing",
      hint:
        "Pass the Stellar public key (G...) of the account that funds and owns " +
        "the deployment — usually the connected wallet's public key.",
    });
  } else if (!isNonEmptyString(deployer) || !isValidPublicKey(deployer.trim())) {
    issues.push({
      field: "deployer",
      reason: `deployer is not a valid Stellar public key: "${String(deployer)}"`,
      hint: "Stellar public keys start with `G` and are 56 characters long.",
    });
  }

  if (config.salt !== undefined && config.salt !== null) {
    if (!Buffer.isBuffer(config.salt)) {
      issues.push({
        field: "salt",
        reason: `salt must be a Buffer, received ${typeof config.salt}`,
        hint: `Omit salt to generate one, or pass a ${DEPLOY_SALT_BYTES}-byte Buffer (e.g. crypto.randomBytes(${DEPLOY_SALT_BYTES})).`,
      });
    } else if (config.salt.length !== DEPLOY_SALT_BYTES) {
      issues.push({
        field: "salt",
        reason: `salt must be exactly ${DEPLOY_SALT_BYTES} bytes, received ${config.salt.length}`,
        hint: `Omit salt to generate one, or pass crypto.randomBytes(${DEPLOY_SALT_BYTES}).`,
      });
    }
  }

  return issues;
}

/**
 * Render deployment configuration issues as a numbered, actionable message.
 *
 * @param issues - Issues returned by {@link collectDeployConfigIssues}
 * @returns Human-readable message, safe to print straight from a script
 */
export function formatDeployConfigIssues(issues: DeployConfigIssue[]): string {
  const header = `Deployment configuration is invalid — ${issues.length} problem${
    issues.length === 1 ? "" : "s"
  } found:`;
  const lines = issues.map(
    (issue, index) =>
      `  ${index + 1}. ${issue.field} — ${issue.reason}. Fix: ${issue.hint}`,
  );
  return [header, ...lines].join("\n");
}

/**
 * Validate a deployment configuration before running a deployment.
 *
 * Call this from deployment scripts to fail fast with an actionable message
 * instead of a network-level error. `buildContractDeploy` already calls it, so
 * the deployment flow itself is unchanged for valid configurations.
 *
 * @param config - Deployment configuration to validate
 * @returns The validated configuration, or an INVALID_CONFIG error whose
 *   message lists every problem and whose `cause` holds the structured issues
 *
 * @example
 * const check = validateDeployConfig({ rpcUrl, horizonUrl, networkConfig, deployer });
 * if (check.status === "error") {
 *   console.error(check.error.message);
 *   process.exit(1);
 * }
 */
export function validateDeployConfig(
  config: DeployConfigInput,
): SorokitResult<ValidatedDeployConfig> {
  const issues = collectDeployConfigIssues(config);

  if (issues.length > 0) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      formatDeployConfigIssues(issues),
      { issues },
    );
  }

  // Safe: an empty issue list means every required field is present and valid.
  return ok({
    rpcUrl: (config.rpcUrl as string).trim(),
    horizonUrl: (config.horizonUrl as string).trim(),
    networkConfig: config.networkConfig as ResolvedNetworkConfig,
    deployer: (config.deployer as string).trim(),
  });
}
