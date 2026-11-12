import test from "node:test";
import assert from "node:assert/strict";
import { executePayment } from "../src/pay.js";

const base = {
  vaultId: "vault2.wavecapkey.testnet",
  ownerId: "dave-owner.testnet",
  recipient: "shop.wavecapkey.testnet",
  amountYocto: 5n,
};

test("returns the tx hash on success", async () => {
  const account = { callFunctionRaw: async () => ({ transaction: { hash: "HASH123" } }) };
  assert.deepEqual(await executePayment(account, base), { ok: true, txHash: "HASH123" });
});

test("passes exact arguments to the vault", async () => {
  let seen;
  const account = {
    callFunctionRaw: async (a) => { seen = a; return { transaction: { hash: "H" } }; },
  };
  await executePayment(account, base);
  assert.equal(seen.methodName, "execute_payment");
  assert.equal(seen.contractId, base.vaultId);
  assert.deepEqual(seen.args, { owner: base.ownerId, recipient: base.recipient, amount: "5" });
});

test("a refusal becomes ok false with the vault's reason", async () => {
  const account = {
    callFunctionRaw: async () => {
      throw new Error("Smart contract panicked: capkey: recipient is not on the approved list");
    },
  };
  const r = await executePayment(account, base);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "recipient is not on the approved list");
});

test("bad input never reaches the network", async () => {
  let calls = 0;
  const account = { callFunctionRaw: async () => { calls++; return {}; } };
  assert.equal((await executePayment(account, { ...base, recipient: "BAD NAME" })).ok, false);
  assert.equal((await executePayment(account, { ...base, amountYocto: 0n })).ok, false);
  assert.equal((await executePayment(account, { ...base, amountYocto: 5 })).ok, false);
  assert.equal(calls, 0);
});

test("a missing tx hash is not treated as success", async () => {
  const account = { callFunctionRaw: async () => ({}) };
  assert.equal((await executePayment(account, base)).ok, false);
});

test("wNEAR calls execute_ft_payment with the same args", async () => {
  let seen;
  const account = {
    callFunctionRaw: async (a) => {
      seen = a;
      return { transaction: { hash: "HFT" }, status: { SuccessValue: "dHJ1ZQ==" } };
    },
  };
  const r = await executePayment(account, { ...base, token: "wnear" });
  assert.deepEqual(r, { ok: true, txHash: "HFT" });
  assert.equal(seen.methodName, "execute_ft_payment");
  assert.equal(seen.contractId, base.vaultId);
  assert.deepEqual(seen.args, { owner: base.ownerId, recipient: base.recipient, amount: "5" });
});

test("wNEAR true result is paid with the tx hash", async () => {
  const account = {
    callFunctionRaw: async () => ({ transaction: { hash: "H1" }, status: { SuccessValue: "dHJ1ZQ==" } }),
  };
  assert.deepEqual(await executePayment(account, { ...base, token: "wnear" }), { ok: true, txHash: "H1" });
});

test("wNEAR false result is a failed payment, never Paid, with the tx link data", async () => {
  const account = {
    callFunctionRaw: async () => ({ transaction: { hash: "H0" }, status: { SuccessValue: "ZmFsc2U=" } }),
  };
  const r = await executePayment(account, { ...base, token: "wnear" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "transfer failed and was refunded");
  assert.equal(r.txHash, "H0");
});

test("wNEAR AA== (a raw borsh bool) is unclear, never Paid", async () => {
  const account = {
    callFunctionRaw: async () => ({ transaction: { hash: "HA" }, status: { SuccessValue: "AA==" } }),
  };
  const r = await executePayment(account, { ...base, token: "wnear" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "result unclear, check the explorer");
  assert.equal(r.txHash, "HA");
});

test("wNEAR missing SuccessValue is unclear, never Paid", async () => {
  const account = {
    callFunctionRaw: async () => ({ transaction: { hash: "HM" } }),
  };
  const r = await executePayment(account, { ...base, token: "wnear" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "result unclear, check the explorer");
  assert.equal(r.txHash, "HM");
});

test("wNEAR garbage SuccessValue is unclear, never Paid", async () => {
  // base64 of "not json": valid base64, but not valid JSON.
  const account = {
    callFunctionRaw: async () => ({ transaction: { hash: "HG" }, status: { SuccessValue: "bm90IGpzb24=" } }),
  };
  const r = await executePayment(account, { ...base, token: "wnear" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "result unclear, check the explorer");
  assert.equal(r.txHash, "HG");
});

test("wNEAR contract error still becomes the refusal reason", async () => {
  const account = {
    callFunctionRaw: async () => {
      throw new Error("Smart contract panicked: capkey: only wNEAR (wrap.testnet) is accepted");
    },
  };
  const r = await executePayment(account, { ...base, token: "wnear" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "only wNEAR (wrap.testnet) is accepted");
});

test("an unknown token never reaches the network", async () => {
  let calls = 0;
  const account = { callFunctionRaw: async () => { calls++; return {}; } };
  assert.equal((await executePayment(account, { ...base, token: "usdc" })).ok, false);
  assert.equal(calls, 0);
});

test("the default NEAR path still calls execute_payment", async () => {
  let seen;
  const account = {
    callFunctionRaw: async (a) => { seen = a; return { transaction: { hash: "HN" } }; },
  };
  const r = await executePayment(account, { ...base });
  assert.deepEqual(r, { ok: true, txHash: "HN" });
  assert.equal(seen.methodName, "execute_payment");
  assert.equal(seen.token, undefined);
});

test("a non-vault error says the result is unknown", async () => {
  const account = { callFunctionRaw: async () => { throw new Error("socket hang up"); } };
  const r = await executePayment(account, base);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown/);
});
