import { describe, expect, it } from "vitest";
import { createSorokitClient } from "../client/createSorokitClient";
import type { SorokitLogger, StructuredLogMeta } from "../shared/logger";

function createCapturingLogger(): {
  logger: SorokitLogger;
  calls: Array<{ message: string; meta?: StructuredLogMeta }>;
} {
  const calls: Array<{ message: string; meta?: StructuredLogMeta }> = [];
  const capture = (message: string, meta?: StructuredLogMeta) => {
    calls.push({ message, meta });
  };

  return {
    calls,
    logger: {
      debug: capture,
      info: capture,
      warn: capture,
      error: capture,
    },
  };
}

describe("createSorokitClient URL logging", () => {
  it("strips query parameters from logged URLs without changing network URLs", () => {
    const { logger, calls } = createCapturingLogger();
    const horizonUrl = "https://horizon.example.com/api/v1?apiKey=secret";
    const rpcUrl = "https://rpc.example.com/soroban?apiKey=secret";

    const result = createSorokitClient({
      network: "testnet",
      horizonUrl,
      rpcUrl,
      debug: true,
      logger,
    });

    expect(result.status).toBe("ok");
    expect(calls.length).toBeGreaterThan(0);

    const serializedLogs = JSON.stringify(calls);
    expect(serializedLogs).not.toContain("apiKey=secret");
    expect(serializedLogs).toContain("https://horizon.example.com/api/v1");
    expect(serializedLogs).toContain("https://rpc.example.com/soroban");

    if (result.status === "ok") {
      expect(result.data.networkConfig.horizonUrl).toBe(horizonUrl);
      expect(result.data.networkConfig.rpcUrl).toBe(rpcUrl);
    }
  });
});
