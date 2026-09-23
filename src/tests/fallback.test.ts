import { describe, it, expect } from "vitest";
import { EndpointFallbackManager } from "../network/fallback";
import { err, ok, SorokitErrorCode } from "../shared/response";

describe("EndpointFallbackManager", () => {
  it("executes successfully on primary endpoint without attempting fallbacks", async () => {
    const manager = new EndpointFallbackManager({
      primaryEndpoint: "https://rpc-1.stellar.org",
      fallbackEndpoints: ["https://rpc-2.stellar.org"],
    });

    const calls: string[] = [];
    const result = await manager.execute(async (endpoint) => {
      calls.push(endpoint);
      return ok({ data: "success" });
    });

    expect(result.status).toBe("ok");
    expect(result.data).toEqual({ data: "success" });
    expect(calls).toEqual(["https://rpc-1.stellar.org"]);
  });

  it("falls back to secondary endpoint on transient failure", async () => {
    const manager = new EndpointFallbackManager({
      primaryEndpoint: "https://rpc-1.stellar.org",
      fallbackEndpoints: ["https://rpc-2.stellar.org"],
    });

    const calls: string[] = [];
    const result = await manager.execute(async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === "https://rpc-1.stellar.org") {
        return err(
          SorokitErrorCode.NETWORK_ERROR,
          "Connection timeout",
          new Error("ETIMEDOUT"),
        );
      }
      return ok({ data: "fallback_ok" });
    });

    expect(result.status).toBe("ok");
    expect(result.data).toEqual({ data: "fallback_ok" });
    expect(calls).toEqual([
      "https://rpc-1.stellar.org",
      "https://rpc-2.stellar.org",
    ]);
  });

  it("records recovery attempts and original cause upon exhaustion", async () => {
    const manager = new EndpointFallbackManager({
      primaryEndpoint: "https://rpc-1.stellar.org",
      fallbackEndpoints: ["https://rpc-2.stellar.org"],
    });

    const primaryError = new Error("ECONNREFUSED");
    const result = await manager.execute(async (endpoint) => {
      return err(
        SorokitErrorCode.NETWORK_ERROR,
        `Failed on ${endpoint}`,
        primaryError,
      );
    });

    expect(result.status).toBe("error");
    expect(result.error.recoveryAttempts).toBeDefined();
    expect(result.error.recoveryAttempts?.length).toBe(2);
    expect(result.error.recoveryAttempts?.[0].endpoint).toBe(
      "https://rpc-1.stellar.org",
    );
    expect(result.error.recoveryAttempts?.[1].endpoint).toBe(
      "https://rpc-2.stellar.org",
    );
  });

  it("supports degraded mode when enabled and non-transient error occurs", async () => {
    const manager = new EndpointFallbackManager({
      primaryEndpoint: "https://rpc-1.stellar.org",
      allowDegradedMode: true,
    });

    const result = await manager.execute(async () => {
      return err(
        SorokitErrorCode.CONTRACT_SIMULATE_FAILED,
        "Simulation resource degraded",
      );
    });

    expect(result.status).toBe("error");
    expect(result.error.degradedMode).toBe(true);
  });
});
