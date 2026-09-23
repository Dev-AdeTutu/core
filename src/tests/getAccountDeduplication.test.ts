import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAccount } from "../account/getAccount";
import { getAccountsBatch } from "../account/getAccountsBatch";
import { clearInflightRequests, getInflightRequestCount } from "../shared/utils";
import { SorokitErrorCode } from "../shared/response";
import * as serverFactory from "../shared/serverFactory";

describe("account fetching with concurrent request deduplication (#390)", () => {
  const publicKeyA = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";
  const publicKeyB = "GBBD47UZQ5JAKVEWZNRPA7MKSTIRZU27I27ULMOWVNQZLBZZW7QTXN00";
  const horizonUrl = "https://horizon.test";

  const mockAccountA = {
    sequence: "12345",
    subentry_count: 2,
    balances: [{ asset_type: "native", balance: "100.0000000" }],
  };

  const mockAccountB = {
    sequence: "67890",
    subentry_count: 1,
    balances: [{ asset_type: "native", balance: "50.0000000" }],
  };

  beforeEach(() => {
    clearInflightRequests();
    vi.restoreAllMocks();
  });

  it("deduplicates N identical concurrent getAccount calls to a single Horizon request", async () => {
    const mockLoadAccount = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return mockAccountA;
    });

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const [res1, res2, res3, res4] = await Promise.all([
      getAccount(horizonUrl, publicKeyA),
      getAccount(horizonUrl, publicKeyA),
      getAccount(horizonUrl, publicKeyA),
      getAccount(horizonUrl, publicKeyA),
    ]);

    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(res1.status).toBe("ok");
    expect(res2.status).toBe("ok");
    expect(res3.status).toBe("ok");
    expect(res4.status).toBe("ok");
    if (res1.status === "ok" && res2.status === "ok") {
      expect(res1.data.sequence).toBe("12345");
      expect(res2.data).toEqual(res1.data);
    }
  });

  it("shares successful results across multiple concurrent callers", async () => {
    const mockLoadAccount = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return mockAccountA;
    });

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const promises = Array.from({ length: 10 }, () => getAccount(horizonUrl, publicKeyA));
    const results = await Promise.all(promises);

    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(10);
    for (const res of results) {
      expect(res.status).toBe("ok");
      if (res.status === "ok") {
        expect(res.data.sequence).toBe("12345");
        expect(res.data.publicKey).toBe(publicKeyA);
      }
    }
  });

  it("propagates shared failure correctly across all concurrent callers", async () => {
    const notFoundError = {
      response: { status: 404 },
      message: "Account not found",
    };

    const mockLoadAccount = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw notFoundError;
    });

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const [res1, res2, res3] = await Promise.all([
      getAccount(horizonUrl, publicKeyA),
      getAccount(horizonUrl, publicKeyA),
      getAccount(horizonUrl, publicKeyA),
    ]);

    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(res1.status).toBe("error");
    expect(res2.status).toBe("error");
    expect(res3.status).toBe("error");
    if (res1.status === "error" && res2.status === "error") {
      expect(res1.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
      expect(res2.error.code).toBe(SorokitErrorCode.ACCOUNT_NOT_FOUND);
    }
  });

  it("removes in-flight entries after completion and allows subsequent requests", async () => {
    const mockLoadAccount = vi.fn().mockResolvedValue(mockAccountA);
    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const first = await getAccount(horizonUrl, publicKeyA);
    expect(first.status).toBe("ok");
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(getInflightRequestCount()).toBe(0);

    const second = await getAccount(horizonUrl, publicKeyA);
    expect(second.status).toBe("ok");
    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    expect(getInflightRequestCount()).toBe(0);
  });

  it("allows subsequent requests after a failure", async () => {
    const notFoundError = {
      response: { status: 404 },
      message: "Account not found",
    };

    const mockLoadAccount = vi
      .fn()
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce(mockAccountA);

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const first = await getAccount(horizonUrl, publicKeyA);
    expect(first.status).toBe("error");
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    expect(getInflightRequestCount()).toBe(0);

    const second = await getAccount(horizonUrl, publicKeyA);
    expect(second.status).toBe("ok");
    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    expect(getInflightRequestCount()).toBe(0);
  });

  it("preserves concurrency for different accounts", async () => {
    const mockLoadAccount = vi.fn().mockImplementation(async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return key === publicKeyA ? mockAccountA : mockAccountB;
    });

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const [resA, resB] = await Promise.all([
      getAccount(horizonUrl, publicKeyA),
      getAccount(horizonUrl, publicKeyB),
    ]);

    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    expect(resA.status).toBe("ok");
    expect(resB.status).toBe("ok");
    if (resA.status === "ok" && resB.status === "ok") {
      expect(resA.data.sequence).toBe("12345");
      expect(resB.data.sequence).toBe("67890");
    }
  });

  it("deduplicates duplicate accounts in getAccountsBatch requests", async () => {
    const mockLoadAccount = vi.fn().mockImplementation(async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return key === publicKeyA ? mockAccountA : mockAccountB;
    });

    vi.spyOn(serverFactory, "createHorizonServer").mockReturnValue({
      loadAccount: mockLoadAccount,
    } as any);

    const batchResult = await getAccountsBatch(horizonUrl, [
      publicKeyA,
      publicKeyB,
      publicKeyA,
      publicKeyA,
      publicKeyB,
    ]);

    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    expect(batchResult.status).toBe("ok");
    if (batchResult.status === "ok") {
      expect(batchResult.data).toHaveLength(5);
      expect(batchResult.data[0].status).toBe("ok");
      expect(batchResult.data[1].status).toBe("ok");
      expect(batchResult.data[2].status).toBe("ok");
      expect(batchResult.data[3].status).toBe("ok");
      expect(batchResult.data[4].status).toBe("ok");
      expect((batchResult.data[0] as any).data.sequence).toBe("12345");
      expect((batchResult.data[1] as any).data.sequence).toBe("67890");
      expect((batchResult.data[2] as any).data.sequence).toBe("12345");
      expect((batchResult.data[3] as any).data.sequence).toBe("12345");
      expect((batchResult.data[4] as any).data.sequence).toBe("67890");
    }
  });
});
