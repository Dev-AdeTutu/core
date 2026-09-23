import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, isErrorCode, assertOk, SorokitErrorCode } from "../shared/response";

describe("shared/response", () => {
  describe("ok()", () => {
    it("returns status ok with data", () => {
      const result = ok({ value: 42 });
      expect(result.status).toBe("ok");
      expect(result.data).toEqual({ value: 42 });
      expect(result.error).toBeNull();
    });
  });

  describe("err()", () => {
    it("returns status error with error object", () => {
      const result = err(
        SorokitErrorCode.NETWORK_ERROR,
        "Something went wrong",
      );
      expect(result.status).toBe("error");
      expect(result.data).toBeNull();
      expect(result.error.code).toBe(SorokitErrorCode.NETWORK_ERROR);
      expect(result.error.message).toBe("Something went wrong");
    });

    it("includes cause when provided", () => {
      const cause = new Error("original");
      const result = err(SorokitErrorCode.UNKNOWN, "wrapped", cause);
      expect(result.status).toBe("error");
      expect(result.error.cause).toBe(cause);
    });

    it("cause is undefined when not provided", () => {
      const result = err(SorokitErrorCode.UNKNOWN, "no cause");
      expect(result.status).toBe("error");
      expect(result.error.cause).toBeUndefined();
    });

    it("CONTRACT_SIMULATE_FAILED error code exists", () => {
      const result = err(
        SorokitErrorCode.CONTRACT_SIMULATE_FAILED,
        "sim failed",
      );
      expect(result.status).toBe("error");
      expect(result.error.code).toBe("CONTRACT_SIMULATE_FAILED");
    });
  });

  describe("isOk() / isErr() type guards", () => {
    it("isOk() returns true for ok result", () => {
      expect(isOk(ok(42))).toBe(true);
    });

    it("isOk() returns false for err result", () => {
      expect(isOk(err(SorokitErrorCode.UNKNOWN, "x"))).toBe(false);
    });

    it("isErr() returns true for err result", () => {
      expect(isErr(err(SorokitErrorCode.UNKNOWN, "x"))).toBe(true);
    });

    it("isErr() returns false for ok result", () => {
      expect(isErr(ok(42))).toBe(false);
    });
  });
});

describe("isErrorCode()", () => {
  it("returns true when result is error with the matching code", () => {
    const result = err(SorokitErrorCode.ACCOUNT_NOT_FOUND, "not found");
    expect(isErrorCode(result, SorokitErrorCode.ACCOUNT_NOT_FOUND)).toBe(true);
  });

  it("returns false when result is ok", () => {
    const result = ok(42);
    expect(isErrorCode(result, SorokitErrorCode.ACCOUNT_NOT_FOUND)).toBe(false);
  });

  it("returns false when result is error with a different code", () => {
    const result = err(SorokitErrorCode.ACCOUNT_FETCH_FAILED, "fetch failed");
    expect(isErrorCode(result, SorokitErrorCode.ACCOUNT_NOT_FOUND)).toBe(false);
  });
});

describe("assertOk()", () => {
  it("does not throw when result is ok", () => {
    const result = ok({ value: 1 });
    expect(() => assertOk(result)).not.toThrow();
  });

  it("throws when result is error", () => {
    const result = err(SorokitErrorCode.TX_SUBMIT_FAILED, "submission failed");
    expect(() => assertOk(result)).toThrow();
  });

  it("thrown message includes the error code and message", () => {
    const result = err(SorokitErrorCode.TX_SUBMIT_FAILED, "submission failed");
    expect(() => assertOk(result)).toThrow(
      "[TX_SUBMIT_FAILED] submission failed",
    );
  });
});

describe("result wrapper immutability (#286)", () => {
  describe("ok() wrapper", () => {
    it("result.data is the same reference as the object passed in", () => {
      const payload = { value: 42 };
      const result = ok(payload);
      expect(result.data).toBe(payload);
    });

    it("mutating the original object after calling ok() is reflected in result.data (data is not cloned)", () => {
      const payload: { value: number } = { value: 1 };
      const result = ok(payload);
      payload.value = 99;
      if (result.status === "ok") {
        expect(result.data.value).toBe(99);
      }
    });

    it("the result wrapper is frozen — result.status cannot be reassigned", () => {
      const result = ok(1);
      expect(Object.isFrozen(result)).toBe(true);
      // Attempting to mutate a frozen object silently fails in non-strict mode
      // and throws a TypeError in strict mode. Either way, the value is unchanged.
      try { (result as { status: string }).status = "error"; } catch { /* strict mode */ }
      expect(result.status).toBe("ok");
    });

    it("result.error remains null on an ok result", () => {
      const result = ok("hello");
      expect(result.error).toBeNull();
    });
  });

  describe("err() wrapper", () => {
    it("the err() wrapper is frozen — result.status cannot be reassigned", () => {
      const result = err(SorokitErrorCode.UNKNOWN, "oops");
      expect(Object.isFrozen(result)).toBe(true);
      try { (result as { status: string }).status = "ok"; } catch { /* strict mode */ }
      expect(result.status).toBe("error");
    });

    it("result.data is null on an error result", () => {
      const result = err<string>(SorokitErrorCode.UNKNOWN, "oops");
      expect(result.data).toBeNull();
    });

    it("cause object is not frozen — err() does not take ownership of the cause", () => {
      const cause = { details: "original" };
      err(SorokitErrorCode.UNKNOWN, "oops", cause);
      cause.details = "mutated";
      expect(cause.details).toBe("mutated");
    });
  });
});

describe("SorokitErrorCode exhaustive membership (#268)", () => {
  it("every enum member has a string value that exactly matches its key name", () => {
    for (const [key, value] of Object.entries(SorokitErrorCode)) {
      expect(value).toBe(key);
    }
  });

  it("enum contains all expected wallet error codes", () => {
    const walletCodes = [
      "WALLET_NOT_FOUND",
      "WALLET_NOT_CONNECTED",
      "WALLET_CONNECT_FAILED",
      "WALLET_SIGN_REJECTED",
      "WALLET_SIGN_FAILED",
      "WALLET_BROWSER_ONLY",
    ];
    for (const code of walletCodes) {
      expect(SorokitErrorCode[code as keyof typeof SorokitErrorCode]).toBe(code);
    }
  });

  it("enum contains all expected contract error codes", () => {
    const contractCodes = [
      "CONTRACT_INVOKE_FAILED",
      "CONTRACT_READ_FAILED",
      "CONTRACT_PREPARE_FAILED",
      "CONTRACT_SIMULATE_FAILED",
    ];
    for (const code of contractCodes) {
      expect(SorokitErrorCode[code as keyof typeof SorokitErrorCode]).toBe(code);
    }
  });

  it("enum contains all expected transaction error codes", () => {
    const txCodes = ["TX_BUILD_FAILED", "TX_SIMULATE_FAILED", "TX_SUBMIT_FAILED", "TX_NOT_FOUND"];
    for (const code of txCodes) {
      expect(SorokitErrorCode[code as keyof typeof SorokitErrorCode]).toBe(code);
    }
  });

  it("UNKNOWN is the generic fallback code", () => {
    expect(SorokitErrorCode.UNKNOWN).toBe("UNKNOWN");
  });
});
