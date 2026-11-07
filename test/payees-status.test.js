import test from "node:test";
import assert from "node:assert/strict";
import { formatPayeesLines } from "../src/payees-status.js";

const SHOP = "shop.wavecapkey.testnet";
const BOB  = "bob.wavecapkey.testnet";
const ONCE = "once.wavecapkey.testnet";

function makeVault({ allowed = [], once = [] } = {}) {
  return {
    policy: { allowed_recipients: allowed, per_tx_cap: "0", daily_limit: "0" },
    one_time_recipients: once,
  };
}

test("approved account is marked 'approved'", () => {
  const vault = makeVault({ allowed: [SHOP] });
  const lines = formatPayeesLines({ shop: SHOP }, vault);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /approved/);
  assert.doesNotMatch(lines[0], /not approved/);
  assert.doesNotMatch(lines[0], /unknown/);
});

test("unapproved account is marked 'not approved by vault'", () => {
  const vault = makeVault({ allowed: [SHOP] });
  const lines = formatPayeesLines({ bob: BOB }, vault);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /not approved by vault/);
});

test("one-time approved account is marked 'approved'", () => {
  const vault = makeVault({ once: [ONCE] });
  const lines = formatPayeesLines({ once: ONCE }, vault);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /approved/);
  assert.doesNotMatch(lines[0], /not approved/);
});

test("getVault failing marks every payee 'status unknown'", () => {
  // null vault simulates getVault throwing or missing policy
  const lines = formatPayeesLines({ shop: SHOP, bob: BOB }, null);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /status unknown/);
  }
});

test("vault with missing policy marks every payee 'status unknown'", () => {
  const lines = formatPayeesLines({ shop: SHOP }, { policy: null });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /status unknown/);
});

test("empty payees returns null", () => {
  assert.equal(formatPayeesLines({}, makeVault()), null);
});

test("line format is 'name -> account (status)'", () => {
  const vault = makeVault({ allowed: [SHOP] });
  const lines = formatPayeesLines({ shop: SHOP }, vault);
  assert.match(lines[0], /^shop -> shop\.wavecapkey\.testnet \(approved\)$/);
});

test("mixed approved and unapproved in one list", () => {
  const vault = makeVault({ allowed: [SHOP] });
  const lines = formatPayeesLines({ shop: SHOP, bob: BOB }, vault);
  assert.equal(lines.length, 2);
  const shopLine = lines.find((l) => l.startsWith("shop"));
  const bobLine  = lines.find((l) => l.startsWith("bob"));
  assert.match(shopLine, /\(approved\)/);
  assert.match(bobLine,  /\(not approved by vault\)/);
});
