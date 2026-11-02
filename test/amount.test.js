import test from "node:test";
import assert from "node:assert/strict";
import { parseNear, isValidAccountId } from "../src/amount.js";

test("parseNear converts exactly", () => {
  assert.equal(parseNear("0.5"), 500000000000000000000000n);
  assert.equal(parseNear("1"), 10n ** 24n);
  assert.equal(parseNear("2.3"), 2300000000000000000000000n);
  assert.equal(parseNear(" 0.25 "), 250000000000000000000000n);
  assert.equal(parseNear("0.000000000000000000000001"), 1n);
});

test("parseNear rejects anything unclear", () => {
  for (const bad of ["", "abc", "-1", "1e3", "1.", ".5", "0", "0.0",
    "1,5", "5 NEAR", "1.1234567890123456789012345"]) {
    assert.throws(() => parseNear(bad), bad);
  }
});

test("isValidAccountId accepts real names", () => {
  for (const ok of ["shop.wavecapkey.testnet", "dave-agent2.testnet", "a1"]) {
    assert.equal(isValidAccountId(ok), true, ok);
  }
});

test("isValidAccountId rejects bad names", () => {
  const bad = ["", "a", "UPPER.testnet", "bad..name", "-x.testnet",
    "x".repeat(65), "has space.testnet", null, undefined, 42];
  for (const b of bad) assert.equal(isValidAccountId(b), false, String(b));
});
