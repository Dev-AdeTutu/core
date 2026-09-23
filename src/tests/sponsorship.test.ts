import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { setSponsor, removeSponsor } from "../account/sponsorship";
import { SorokitErrorCode } from "../shared/response";
import { createSorokitClient } from "../client/createSorokitClient";

describe("Account Sponsorship Utilities (#213)", () => {
  const accountKp = Keypair.random();
  const sponsorKp = Keypair.random();
  const accountAddress = accountKp.publicKey();
  const sponsorAddress = sponsorKp.publicKey();

  describe("setSponsor", () => {
    it("successfully builds sponsorship operations for valid account and sponsor", () => {
      const result = setSponsor(accountAddress, sponsorAddress);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.account).toBe(accountAddress);
        expect(result.data.sponsor).toBe(sponsorAddress);
        expect(result.data.operations).toHaveLength(2);
        expect(result.data.requiredSigners).toEqual([sponsorAddress, accountAddress]);

        // Check operation types
        const [beginOp, endOp] = result.data.operations;
        expect(beginOp.body().switch().name).toBe("beginSponsoringFutureReserves");
        expect(endOp.body().switch().name).toBe("endSponsoringFutureReserves");
      }
    });

    it("returns error for invalid account address", () => {
      const result = setSponsor("INVALID_ACCOUNT_KEY", sponsorAddress);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
        expect(result.error.message).toContain("Invalid account address");
      }
    });

    it("returns error for invalid sponsor address", () => {
      const result = setSponsor(accountAddress, "INVALID_SPONSOR_KEY");

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
        expect(result.error.message).toContain("Invalid sponsor address");
      }
    });

    it("returns error when account and sponsor are identical", () => {
      const result = setSponsor(accountAddress, accountAddress);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
        expect(result.error.message).toContain("cannot be the same address");
      }
    });
  });

  describe("removeSponsor", () => {
    it("successfully builds remove sponsorship operation for valid account", () => {
      const result = removeSponsor(accountAddress);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.data.account).toBe(accountAddress);
        expect(result.data.operations).toHaveLength(1);
        expect(result.data.requiredSigners).toEqual([accountAddress]);

        const [revokeOp] = result.data.operations;
        expect(revokeOp.body().switch().name).toBe("revokeSponsorship");
      }
    });

    it("returns error for invalid account address", () => {
      const result = removeSponsor("BAD_KEY");

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error.code).toBe(SorokitErrorCode.INVALID_ADDRESS);
        expect(result.error.message).toContain("Invalid account address");
      }
    });
  });

  describe("client.account integration", () => {
    it("exposes setSponsor and removeSponsor on SorokitClient", () => {
      const clientResult = createSorokitClient({ network: "testnet" });
      expect(clientResult.status).toBe("ok");
      if (clientResult.status === "ok") {
        const client = clientResult.data;

        const setRes = client.account.setSponsor(accountAddress, sponsorAddress);
        expect(setRes.status).toBe("ok");

        const removeRes = client.account.removeSponsor(accountAddress);
        expect(removeRes.status).toBe("ok");
      }
    });
  });
});
