import test from "node:test";
import assert from "node:assert/strict";
import { assessRecipient, levenshtein } from "../src/risk.js";

const base = {
  recipient: "shop.wavecapkey.testnet",
  amountYocto: 10n,
  approved: ["shop.wavecapkey.testnet"],
  perTxCap: 1000n,
  selfIds: ["vault2.wavecapkey.testnet", "dave-agent2.testnet", "dave-owner.testnet"],
  blocklist: ["scam-wallet.testnet", "free-near-giveaway.testnet"],
  paidBefore: new Set(["shop.wavecapkey.testnet"]),
};

const run = (over = {}) => assessRecipient({ ...base, ...over });

test("levenshtein counts edits", () => {
  assert.equal(levenshtein("", ""), 0);
  assert.equal(levenshtein("", "abc"), 3);
  assert.equal(levenshtein("abc", ""), 3);
  assert.equal(levenshtein("abc", "abc"), 0);
  assert.equal(levenshtein("abc", "abd"), 1);
  assert.equal(levenshtein("abc", "ab"), 1);
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("shop", "shopp"), levenshtein("shopp", "shop"));
});

test("a normal approved recipient is ok", () => {
  const r = run();
  assert.equal(r.level, "ok");
  assert.deepEqual(r.reasons, []);
});

test("blocks an invalid account id", () => {
  const r = run({ recipient: "BAD NAME" });
  assert.equal(r.level, "block");
  assert.match(r.reasons.join(" "), /Invalid recipient/);
});

test("blocks a recipient on the blocklist", () => {
  const r = run({ recipient: "scam-wallet.testnet" });
  assert.equal(r.level, "block");
  assert.match(r.reasons.join(" "), /blocklist/);
});

test("blocks one of our own accounts", () => {
  for (const id of ["vault2.wavecapkey.testnet", "dave-agent2.testnet", "dave-owner.testnet"]) {
    const r = run({ recipient: id });
    assert.equal(r.level, "block", id);
    assert.match(r.reasons.join(" "), /own accounts/, id);
  }
});

test("blocks a lookalike one edit away", () => {
  const r = run({ recipient: "shop.wavecapkey.testne" });
  assert.equal(r.level, "block");
  assert.match(r.reasons.join(" "), /lookalike/);
});

test("blocks a lookalike two edits away", () => {
  const r = run({ recipient: "shop.wavecapkey.testn" });
  assert.equal(r.level, "block");
  assert.match(r.reasons.join(" "), /lookalike/);
});

test("an exact match is not a lookalike", () => {
  const r = run({ recipient: "shop.wavecapkey.testnet" });
  assert.equal(r.level, "ok");
});

test("two similar approved accounts do not block each other", () => {
  const r = run({
    approved: ["shop1.testnet", "shop2.testnet"],
    recipient: "shop2.testnet",
    paidBefore: new Set(["shop2.testnet"]),
  });
  assert.notEqual(r.level, "block");
});

test("a non-approved near-miss is still blocked", () => {
  const r = run({ approved: ["shop1.testnet"], recipient: "shop3.testnet" });
  assert.equal(r.level, "block");
  assert.match(r.reasons.join(" "), /lookalike/);
});

test("a one-character lookalike is still blocked", () => {
  const r = run({
    approved: ["shop.wavecapkey.testnet"],
    recipient: "shop.wavecapkey.testnef",
  });
  assert.equal(r.level, "block");
  assert.match(r.reasons.join(" "), /lookalike/);
});

test("a name three edits away is not a lookalike", () => {
  const r = run({ recipient: "shop.wavecapkey.test", paidBefore: new Set(["shop.wavecapkey.test"]) });
  assert.notEqual(r.level, "block");
});

test("warns on a first payment", () => {
  const r = run({ paidBefore: new Set() });
  assert.equal(r.level, "warn");
  assert.match(r.reasons.join(" "), /first payment/);
});

test("warns above half the per-payment cap", () => {
  assert.equal(run({ amountYocto: 501n }).level, "warn");
  assert.match(run({ amountYocto: 501n }).reasons.join(" "), /half the per-payment limit/);
  assert.equal(run({ amountYocto: 500n }).level, "ok"); // exactly half is not above half
});

test("warns on a 64-character hex recipient", () => {
  const r = run({ recipient: "a".repeat(64), paidBefore: new Set(["a".repeat(64)]) });
  assert.equal(r.level, "warn");
  assert.match(r.reasons.join(" "), /raw key/);
});

test("a block wins over warnings", () => {
  const r = run({ recipient: "scam-wallet.testnet", paidBefore: new Set(), amountYocto: 900n });
  assert.equal(r.level, "block");
  assert.doesNotMatch(r.reasons.join(" "), /first payment/);
});

test("fails closed on missing or wrong inputs", () => {
  const cases = [
    {},
    { ...base, paidBefore: undefined },
    { ...base, paidBefore: ["shop.wavecapkey.testnet"] },
    { ...base, approved: undefined },
    { ...base, approved: "shop.wavecapkey.testnet" },
    { ...base, amountYocto: 10 },
    { ...base, perTxCap: "1000" },
    { ...base, selfIds: [1, 2] },
  ];
  cases.forEach((bad, i) => {
    const r = assessRecipient(bad);
    assert.equal(r.level, "block", `case ${i}`);
    assert.deepEqual(r.reasons, ["risk check failed"], `case ${i}`);
  });
});

test("fails closed when the check itself throws", () => {
  class Boom extends Set {
    has() {
      throw new Error("boom");
    }
  }
  const r = run({ paidBefore: new Boom() });
  assert.equal(r.level, "block");
  assert.deepEqual(r.reasons, ["risk check failed"]);
});
