import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

import { loadPayees, addPayee, removePayee, appendReceipt, readReceipts } from "../src/store.js";

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

const TMP_DIR = join(tmpdir(), "sentry-test-store-" + Date.now());

function cleanup() {
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// loadPayees
// ---------------------------------------------------------------------------

test("loadPayees: missing file returns {}", () => {
  cleanup();
  const result = loadPayees(TMP_DIR);
  assert.deepStrictEqual(result, {});
});

test("loadPayees: valid file loads correctly", () => {
  cleanup();
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(join(TMP_DIR, "payees.json"), JSON.stringify({ bob: "bob.wavecapkey.testnet" }), "utf8");
  const result = loadPayees(TMP_DIR);
  assert.deepStrictEqual(result, { bob: "bob.wavecapkey.testnet" });
});

test("loadPayees: bad JSON returns {}", () => {
  cleanup();
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(join(TMP_DIR, "payees.json"), "{bad", "utf8");
  const result = loadPayees(TMP_DIR);
  assert.deepStrictEqual(result, {});
});

test("loadPayees: malformed entry (non-object) returns {}", () => {
  cleanup();
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(join(TMP_DIR, "payees.json"), JSON.stringify(["not", "an", "object"]), "utf8");
  const result = loadPayees(TMP_DIR);
  assert.deepStrictEqual(result, {});
});

test("loadPayees: malformed entry (non-string values) returns {}", () => {
  cleanup();
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(join(TMP_DIR, "payees.json"), JSON.stringify({ "": 123 }), "utf8");
  const result = loadPayees(TMP_DIR);
  assert.deepStrictEqual(result, {});
});

test("loadPayees: reserved word in entry makes whole load {}", () => {
  cleanup();
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(join(TMP_DIR, "payees.json"), JSON.stringify({ pay: "payer.testnet" }), "utf8");
  const result = loadPayees(TMP_DIR);
  assert.deepStrictEqual(result, {});
});

test("loadPayees: built-in alias name makes whole load {}", () => {
  cleanup();
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(join(TMP_DIR, "payees.json"), JSON.stringify({ shop: "shop.wavecapkey.testnet" }), "utf8");
  const result = loadPayees(TMP_DIR);
  assert.deepStrictEqual(result, {});
});

test("loadPayees: invalid account name makes whole load {}", () => {
  cleanup();
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(join(TMP_DIR, "payees.json"), JSON.stringify({ alice: "not-an-account" }), "utf8");
  const result = loadPayees(TMP_DIR);
  assert.deepStrictEqual(result, {});
});

test("loadPayees: invalid account format makes whole load {}", () => {
  cleanup();
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(join(TMP_DIR, "payees.json"), JSON.stringify({ alice: "a" }), "utf8");
  const result = loadPayees(TMP_DIR);
  assert.deepStrictEqual(result, {});
});

// ---------------------------------------------------------------------------
// addPayee
// ---------------------------------------------------------------------------

test("addPayee: valid add succeeds", () => {
  cleanup();
  const result = addPayee(TMP_DIR, "alice", "alice.wavecapkey.testnet", {});
  assert.ok(result.ok, result.reason);
  assert.strictEqual(existsSync(join(TMP_DIR, "payees.json")), true);
});
test("addPayee: uppercase name stored as lowercase", () => {
  cleanup();
  const result = addPayee(TMP_DIR, "Alice", "alice.wavecapkey.testnet", {});
  assert.ok(result.ok, result.reason);
  // Verify the name was lowercased in the file
  const payees = loadPayees(TMP_DIR);
  assert.ok(payees, "payees file should exist");
  assert.strictEqual(payees.alice, "alice.wavecapkey.testnet");
});

test("addPayee: invalid name format rejected - special char", () => {
  cleanup();
  const result = addPayee(TMP_DIR, "al@ice", "a.testnet", {});
  assert.ok(!result.ok, result.reason);
});

test("addPayee: invalid name format rejected - too long", () => {
  cleanup();
  // 21 chars lowercase: exceeds 1-19 range
  const longName = "a".repeat(21);
  const result = addPayee(TMP_DIR, longName, "a.testnet", {});
  assert.ok(!result.ok, result.reason);
});

test("addPayee: reserved word pay rejected", () => {
  cleanup();
  const result = addPayee(TMP_DIR, "pay", "payer.testnet", {});
  assert.ok(!result.ok, result.reason);
  assert.match(result.reason, /reserved/);
});

test("addPayee: reserved word send rejected", () => {
  cleanup();
  const result = addPayee(TMP_DIR, "send", "s.testnet", {});
  assert.ok(!result.ok, result.reason);
});

test("addPayee: reserved word near rejected", () => {
  cleanup();
  const result = addPayee(TMP_DIR, "near", "n.testnet", {});
  assert.ok(!result.ok, result.reason);
});

test("addPayee: reserved word treasury rejected", () => {
  cleanup();
  const result = addPayee(TMP_DIR, "treasury", "t.testnet", {});
  assert.ok(!result.ok, result.reason);
});

test("addPayee: built-in alias shop rejected", () => {
  cleanup();
  const result = addPayee(TMP_DIR, "shop", "other.testnet", {});
  assert.ok(!result.ok, result.reason);
  assert.match(result.reason, /built-in/ || /conflicts/ || /alias/);
});

test("addPayee: invalid account rejected", () => {
  cleanup();
  const result = addPayee(TMP_DIR, "alice", "UPPERCASE", {});
  assert.ok(!result.ok, result.reason);
  assert.match(result.reason, /account is not a valid/);
});

test("addPayee: blocklisted account rejected", () => {
  cleanup();
  const result = addPayee(TMP_DIR, "alice", "blocklisted.wallet.testnet", {
    blocklist: ["blocklisted.wallet.testnet"],
  });
  assert.ok(!result.ok, result.reason);
  assert.match(result.reason, /blocklist/);
});

test("addPayee: own account rejected via selfIds", () => {
  cleanup();
  const result = addPayee(TMP_DIR, "alice", "dave-owner.testnet", {
    selfIds: ["dave-owner.testnet"],
  });
  assert.ok(!result.ok, result.reason);
  assert.match(result.reason, /own account/);
});

test("addPayee: duplicate name rejected", () => {
  cleanup();
  addPayee(TMP_DIR, "alice", "alice.wavecapkey.testnet", {});
  const result = addPayee(TMP_DIR, "alice", "alice2.wavecapkey.testnet", {});
  assert.ok(!result.ok, result.reason);
  assert.match(result.reason, /already exists/);
});

test("addPayee: max 20 payees reached", () => {
  cleanup();
  for (let i = 0; i < 20; i++) {
    addPayee(TMP_DIR, `payee${i}`, `payee${i}.testnet`, {});
  }
  const result = addPayee(TMP_DIR, "extra", "extra.testnet", {});
  assert.ok(!result.ok, result.reason);
  assert.match(result.reason, /maximum/ || /20/);
});

test("addPayee: atomic write leaves no temp file", () => {
  cleanup();
  addPayee(TMP_DIR, "alice", "alice.wavecapkey.testnet", {});
  const tmpPath = join(TMP_DIR, "payees.json.tmp");
  assert.ok(!existsSync(tmpPath), "temp file should have been cleaned up");
});

// ---------------------------------------------------------------------------
// removePayee
// ---------------------------------------------------------------------------

test("removePayee: valid remove succeeds", () => {
  cleanup();
  addPayee(TMP_DIR, "alice", "alice.wavecapkey.testnet", {});
  const result = removePayee(TMP_DIR, "alice");
  assert.ok(result.ok, result.reason);
  const payees = loadPayees(TMP_DIR);
  assert.ok(!("alice" in payees));
});

test("removePayee: name not found rejected", () => {
  cleanup();
  const result = removePayee(TMP_DIR, "nonexistent");
  assert.ok(!result.ok, result.reason);
  assert.match(result.reason, /not found/);
});

test("removePayee: constructor not found", () => {
  cleanup();
  // First add a different payee so the dir exists
  addPayee(TMP_DIR, "payee1", "payee1.testnet", {});
  // "constructor" is not a registered payee
  const result = removePayee(TMP_DIR, "constructor");
  assert.ok(!result.ok, result.reason);
  assert.match(result.reason, /name not found/);
});

// appendReceipt
// ---------------------------------------------------------------------------

test("appendReceipt: valid append succeeds", () => {
  cleanup();
  mkdirSync(TMP_DIR, { recursive: true });
  const result = appendReceipt(TMP_DIR, {
    t: new Date().toISOString(),
    recipient: "shop.wavecapkey.testnet",
    amountYocto: "100000000000000000000000",
    txHash: "abc123",
  });
  assert.ok(result.ok, result.reason);
});

test("appendReceipt: file created if missing", () => {
  cleanup();
  const result = appendReceipt(TMP_DIR, {
    t: new Date().toISOString(),
    recipient: "shop.wavecapkey.testnet",
    amountYocto: "1n",
    txHash: "abc",
  });
  assert.ok(result.ok, result.reason);
  assert.ok(existsSync(join(TMP_DIR, "receipts.jsonl")));
});

// ---------------------------------------------------------------------------
// readReceipts
// ---------------------------------------------------------------------------

test("readReceipts: returns last n", () => {
  cleanup();
  mkdirSync(TMP_DIR, { recursive: true });
  for (let i = 0; i < 7; i++) {
    appendReceipt(TMP_DIR, {
      t: new Date(Date.now() - i * 60_000).toISOString(),
      recipient: "shop.wavecapkey.testnet",
      amountYocto: "1n",
      txHash: `tx-${i}`,
    });
  }
  const last3 = readReceipts(TMP_DIR, 3);
  assert.equal(last3.length, 3);
  // Newest first: last3[0] is the most recent (tx-6), last3[2] is the oldest of the last 3 (tx-4)
  assert.equal(last3[0].txHash, "tx-6");
  assert.equal(last3[2].txHash, "tx-4");
});

test("readReceipts: bad lines are skipped", () => {
  cleanup();
  mkdirSync(TMP_DIR, { recursive: true });
  const p = join(TMP_DIR, "receipts.jsonl");
  writeFileSync(p, [
    JSON.stringify({ t: "2024-01-01", recipient: "a", amountYocto: "1", txHash: "h1" }) + "\n",
    "this is not json\n",
    JSON.stringify({ t: "2024-01-02", recipient: "b", amountYocto: "2", txHash: "h2" }) + "\n",
    "also bad\n",
    JSON.stringify({ t: "2024-01-03", recipient: "c", amountYocto: "3", txHash: "h3" }) + "\n",
  ].join(""), "utf8");
  const result = readReceipts(TMP_DIR, 10);
  assert.equal(result.length, 3);
  assert.equal(result[0].txHash, "h3");
  assert.equal(result[2].txHash, "h1");
});

test("readReceipts: missing file returns empty array", () => {
  cleanup();
  const result = readReceipts(TMP_DIR, 10);
  assert.deepStrictEqual(result, []);
});

test("readReceipts: n larger than total returns all", () => {
  cleanup();
  mkdirSync(TMP_DIR, { recursive: true });
  appendReceipt(TMP_DIR, {
    t: new Date().toISOString(),
    recipient: "shop.wavecapkey.testnet",
    amountYocto: "1n",
    txHash: "h1",
  });
  const result = readReceipts(TMP_DIR, 100);
  assert.equal(result.length, 1);
});