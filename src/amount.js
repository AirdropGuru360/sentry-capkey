const YOCTO = 10n ** 24n;

// "0.5" -> 500000000000000000000000n. BigInt only. Throws on anything unclear.
export function parseNear(text) {
  const s = String(text).trim();
if (!/^\d+(\.\d{1,24})?$/.test(s)) {
    throw new Error("Invalid amount");
  }
  const [whole, frac = ""] = s.split(".");
  const yocto = BigInt(whole) * YOCTO + BigInt(frac.padEnd(24, "0"));
  if (yocto <= 0n) throw new Error("Amount must be above zero");
  return yocto;
}

// NEAR account id rule: 2-64 chars, lowercase letters, digits, separators - _ .
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export function isValidAccountId(id) {
  return (
    typeof id === "string" &&
    id.length >= 2 &&
    id.length <= 64 &&
    ACCOUNT_ID.test(id)
  );
}
