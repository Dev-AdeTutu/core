import type { AssetBalanceFilter } from "./index";

// Type-level verification to assert that AssetBalanceFilter can be imported from
// the public entry point and that its structure is preserved.
const filter: AssetBalanceFilter = {
  assetCode: "USDC",
  assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQ75XABEE3XZNIXUAA",
  assetType: ["credit_alphanum4"],
  excludeZero: true,
};

// Exporting a dummy token to ensure the file is compiled and not flagged as empty.
export const typecheckPassed = filter !== undefined;
