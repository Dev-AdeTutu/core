import { Keypair, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { SorokitErrorCode } from "../shared/response";
import { buildContractDeploy } from "../soroban/deployContract";
import {
  DEPLOY_SALT_BYTES,
  collectDeployConfigIssues,
  formatDeployConfigIssues,
  validateDeployConfig,
} from "../soroban/validateDeployConfig";
import type { DeployConfigIssue } from "../soroban/validateDeployConfig";

const networkConfig = {
  network: "testnet" as const,
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
};

const deployer = Keypair.random().publicKey();

const validConfig = {
  rpcUrl: networkConfig.rpcUrl,
  horizonUrl: networkConfig.horizonUrl,
  networkConfig,
  deployer,
};

/** Field names of every issue, for order-independent assertions. */
function fields(issues: DeployConfigIssue[]): string[] {
  return issues.map((issue) => issue.field);
}

describe("validateDeployConfig", () => {
  it("accepts a complete configuration and returns the normalized values", () => {
    const result = validateDeployConfig(validConfig);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.rpcUrl).toBe(networkConfig.rpcUrl);
      expect(result.data.horizonUrl).toBe(networkConfig.horizonUrl);
      expect(result.data.deployer).toBe(deployer);
      expect(result.data.networkConfig.networkPassphrase).toBe(Networks.TESTNET);
    }
  });

  it("trims surrounding whitespace from string fields", () => {
    const result = validateDeployConfig({
      ...validConfig,
      rpcUrl: `  ${networkConfig.rpcUrl}  `,
      deployer: `  ${deployer}  `,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.rpcUrl).toBe(networkConfig.rpcUrl);
      expect(result.data.deployer).toBe(deployer);
    }
  });

  it("reports every missing value in a single pass", () => {
    const result = validateDeployConfig({});

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      expect(result.error.message).toContain("4 problems found");
      expect(result.error.message).toContain("rpcUrl");
      expect(result.error.message).toContain("horizonUrl");
      expect(result.error.message).toContain("networkConfig");
      expect(result.error.message).toContain("deployer");
    }
  });

  it("attaches the structured issues as the error cause", () => {
    const result = validateDeployConfig({});

    expect(result.status).toBe("error");
    if (result.status === "error") {
      const cause = result.error.cause as { issues: DeployConfigIssue[] };
      expect(fields(cause.issues)).toEqual([
        "rpcUrl",
        "horizonUrl",
        "networkConfig",
        "deployer",
      ]);
      for (const issue of cause.issues) {
        expect(issue.reason.length).toBeGreaterThan(0);
        expect(issue.hint.length).toBeGreaterThan(0);
      }
    }
  });

  it.each([
    ["rpcUrl", "the Soroban RPC endpoint"],
    ["horizonUrl", "the Horizon endpoint"],
  ])("explains how to fix a missing %s", (field, expectedHint) => {
    const issues = collectDeployConfigIssues({
      ...validConfig,
      [field]: undefined,
    });

    const issue = issues.find((candidate) => candidate.field === field);
    expect(issue).toBeDefined();
    expect(issue?.reason).toContain("missing");
    expect(issue?.hint).toContain(expectedHint);
  });

  it.each([
    ["not-a-url"],
    ["soroban-testnet.stellar.org"],
    ["ftp://soroban-testnet.stellar.org"],
  ])("rejects %s as an endpoint URL", (rpcUrl) => {
    const issues = collectDeployConfigIssues({ ...validConfig, rpcUrl });

    expect(fields(issues)).toEqual(["rpcUrl"]);
    expect(issues[0]?.reason).toContain("not a valid http(s) URL");
    expect(issues[0]?.hint).toContain("absolute URL");
  });

  it("rejects a deployer that is not a Stellar public key", () => {
    const issues = collectDeployConfigIssues({
      ...validConfig,
      deployer: "GNOT-A-REAL-KEY",
    });

    expect(fields(issues)).toEqual(["deployer"]);
    expect(issues[0]?.reason).toContain("not a valid Stellar public key");
    expect(issues[0]?.hint).toContain("56 characters");
  });

  it("reports a missing deployer separately from a malformed one", () => {
    const issues = collectDeployConfigIssues({ ...validConfig, deployer: "" });

    expect(fields(issues)).toEqual(["deployer"]);
    expect(issues[0]?.reason).toContain("missing");
  });

  it("reports a missing network passphrase", () => {
    const issues = collectDeployConfigIssues({
      ...validConfig,
      networkConfig: { ...networkConfig, networkPassphrase: "" },
    });

    expect(fields(issues)).toEqual(["networkConfig.networkPassphrase"]);
    expect(issues[0]?.hint).toContain("NETWORK_DEFAULTS");
  });

  it("reports a missing network name", () => {
    const issues = collectDeployConfigIssues({
      ...validConfig,
      networkConfig: {
        ...networkConfig,
        network: "" as unknown as typeof networkConfig.network,
      },
    });

    expect(fields(issues)).toEqual(["networkConfig.network"]);
    expect(issues[0]?.hint).toContain("testnet");
  });

  it("rejects a salt that is not exactly 32 bytes", () => {
    const issues = collectDeployConfigIssues({
      ...validConfig,
      salt: Buffer.alloc(8),
    });

    expect(fields(issues)).toEqual(["salt"]);
    expect(issues[0]?.reason).toContain(`${DEPLOY_SALT_BYTES} bytes`);
  });

  it("accepts a 32-byte salt", () => {
    const issues = collectDeployConfigIssues({
      ...validConfig,
      salt: Buffer.alloc(DEPLOY_SALT_BYTES),
    });

    expect(issues).toEqual([]);
  });

  it("ignores an omitted salt", () => {
    expect(collectDeployConfigIssues(validConfig)).toEqual([]);
  });
});

describe("formatDeployConfigIssues", () => {
  it("numbers each issue and includes the fix", () => {
    const message = formatDeployConfigIssues([
      { field: "rpcUrl", reason: "rpcUrl is missing", hint: "Set rpcUrl." },
      { field: "deployer", reason: "deployer is missing", hint: "Pass a G... key." },
    ]);

    expect(message).toContain("2 problems found");
    expect(message).toContain("1. rpcUrl — rpcUrl is missing. Fix: Set rpcUrl.");
    expect(message).toContain("2. deployer — deployer is missing. Fix: Pass a G... key.");
  });

  it("uses the singular form for one issue", () => {
    const message = formatDeployConfigIssues([
      { field: "deployer", reason: "deployer is missing", hint: "Pass a G... key." },
    ]);

    expect(message).toContain("1 problem found");
  });
});

describe("buildContractDeploy configuration pre-flight", () => {
  const validWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  it("fails with INVALID_CONFIG before contacting the network", async () => {
    const result = await buildContractDeploy(validWasm, deployer, {
      rpcUrl: "",
      horizonUrl: networkConfig.horizonUrl,
      networkConfig,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      expect(result.error.message).toContain("rpcUrl is missing");
    }
  });

  it("reports an invalid deployer address without loading the account", async () => {
    const result = await buildContractDeploy(validWasm, "not-a-key", {
      rpcUrl: networkConfig.rpcUrl,
      horizonUrl: networkConfig.horizonUrl,
      networkConfig,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.INVALID_CONFIG);
      expect(result.error.message).toContain("deployer");
    }
  });

  it("reports an empty WASM buffer with an actionable message", async () => {
    const result = await buildContractDeploy(Buffer.alloc(0), deployer, {
      rpcUrl: networkConfig.rpcUrl,
      horizonUrl: networkConfig.horizonUrl,
      networkConfig,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe(SorokitErrorCode.TX_BUILD_FAILED);
      expect(result.error.message).toContain("missing or empty");
    }
  });
});
