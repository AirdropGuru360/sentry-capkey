import test from "node:test";
import assert from "node:assert/strict";
import { formatNear } from "../src/format.js";

test("formats whole and fractional amounts", () => {
  assert.equal(formatNear("1000000000000000000000000"), "1 NEAR");
  assert.equal(formatNear("2300000000000000000000000"), "2.3 NEAR");
  assert.equal(formatNear("500000000000000000000000"), "0.5 NEAR");
  assert.equal(formatNear("0"), "0 NEAR");
});

test("tiny amounts are cut to 4 decimals", () => {
  assert.equal(formatNear("123456000000000000000"), "0.0001 NEAR");
});

test("bad input throws instead of guessing", () => {
  assert.throws(() => formatNear("abc"));
  assert.throws(() => formatNear("1.5"));
});
