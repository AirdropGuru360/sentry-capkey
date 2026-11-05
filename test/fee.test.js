import test from "node:test";
import assert from "node:assert/strict";
import { computeFee, FEE_BPS } from "../src/fee.js";

test("FEE_BPS is 0.5%", () => {
  assert.equal(FEE_BPS, 50);
});

test("0.01 NEAR at 50 bps is 50000000000000000000 yocto", () => {
  const amount = 10n ** 22n; // 0.01 NEAR
  assert.equal(computeFee(amount, 50), 50000000000000000000n);
});

test("1 NEAR at 50 bps is 0.005 NEAR", () => {
  assert.equal(computeFee(10n ** 24n, 50), 5n * 10n ** 21n);
});

test("tiny amounts round down to zero", () => {
  assert.equal(computeFee(1n, 50), 0n);
  assert.equal(computeFee(199n, 50), 0n);
  assert.equal(computeFee(200n, 50), 1n);
});

test("bps boundaries 0 and 200 work", () => {
  assert.equal(computeFee(10n ** 24n, 0), 0n);
  assert.equal(computeFee(10n ** 24n, 200), 2n * 10n ** 22n);
});

test("rejects a non-bigint amount", () => {
  for (const amount of ["1000", 1000, 1.5, null, undefined, {}]) {
    assert.throws(() => computeFee(amount, 50), String(amount));
  }
});

test("rejects a non-positive amount", () => {
  assert.throws(() => computeFee(0n, 50));
  assert.throws(() => computeFee(-1n, 50));
});

test("rejects bps outside 0..200", () => {
  for (const bps of [-1, 201, 1000, 1.5, "50", NaN, null]) {
    assert.throws(() => computeFee(10n ** 24n, bps), String(bps));
  }
});
