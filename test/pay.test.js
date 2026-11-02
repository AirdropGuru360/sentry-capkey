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
