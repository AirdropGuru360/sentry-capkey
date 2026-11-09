import test from "node:test";
import assert from "node:assert/strict";
import { verifyPayment } from "../../service/verify.js";

const RPC = "https://rpc.test";
const PAYER = "payer.testnet";
const SERVICE = "service.testnet";

function result(overrides = {}) {
  return {
    status: { SuccessValue: "" },
    transaction: { signer_id: PAYER },
    receipts: [
      {
        receiver_id: SERVICE,
        receipt: {
          Action: {
            actions: [{ Transfer: { deposit: "1000" } }],
          },
        },
      },
    ],
    ...overrides,
  };
}

function rpcOk(payload) {
  return { status: 200, json: async () => ({ jsonrpc: "2.0", id: "x", result: payload }) };
}

function baseArgs(fetchFn, extra = {}) {
  return {
    rpcUrl: RPC,
    txHash: "A".repeat(44),
    signerId: PAYER,
    serviceAccount: SERVICE,
    minYocto: 1000n,
    fetchFn,
    ...extra,
  };
}

test("verifyPayment uses the official EXPERIMENTAL_tx_status request shape", async () => {
  let seen;
  const fetchFn = async (url, init) => {
    seen = { url, init };
    return rpcOk(result());
  };

  const r = await verifyPayment(baseArgs(fetchFn));

  assert.deepEqual(r, { ok: true });
  assert.equal(seen.url, RPC);
  assert.equal(seen.init.method, "POST");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.method, "EXPERIMENTAL_tx_status");
  assert.deepEqual(body.params, {
    tx_hash: "A".repeat(44),
    sender_account_id: PAYER,
    wait_until: "FINAL",
  });
});

test("accepts a successful payment", async () => {
  const r = await verifyPayment(baseArgs(async () => rpcOk(result())));
  assert.deepEqual(r, { ok: true });
});

test("accepts a decimal-string minYocto and the legacy actions shape", async () => {
  const legacy = result({
    receipts: [
      {
        receiver_id: SERVICE,
        actions: [{ Transfer: { deposit: "1500" } }],
      },
    ],
  });
  const r = await verifyPayment(
    baseArgs(async () => rpcOk(legacy), { minYocto: "1000" }),
  );
  assert.deepEqual(r, { ok: true });
});

test("rejects a wrong signer", async () => {
  const bad = result({ transaction: { signer_id: "other.testnet" } });
  const r = await verifyPayment(baseArgs(async () => rpcOk(bad)));
  assert.equal(r.ok, false);
  assert.match(r.reason, /signer/);
});

test("rejects a wrong receiver", async () => {
  const bad = result({
    receipts: [
      {
        receiver_id: "other.testnet",
        receipt: { Action: { actions: [{ Transfer: { deposit: "1000" } }] } },
      },
    ],
  });
  const r = await verifyPayment(baseArgs(async () => rpcOk(bad)));
  assert.equal(r.ok, false);
  assert.match(r.reason, /receiver/);
});

test("rejects too little paid", async () => {
  const bad = result({
    receipts: [
      {
        receiver_id: SERVICE,
        receipt: { Action: { actions: [{ Transfer: { deposit: "999" } }] } },
      },
    ],
  });
  const r = await verifyPayment(baseArgs(async () => rpcOk(bad)));
  assert.equal(r.ok, false);
  assert.match(r.reason, /too small/);
});

test("rejects a failed transaction", async () => {
  const bad = result({ status: { Failure: { ActionError: {} } } });
  const r = await verifyPayment(baseArgs(async () => rpcOk(bad)));
  assert.equal(r.ok, false);
  assert.match(r.reason, /failed/);
});

test("rejects a non-final status", async () => {
  const bad = result({ status: "NotStarted" });
  const r = await verifyPayment(baseArgs(async () => rpcOk(bad)));
  assert.equal(r.ok, false);
  assert.match(r.reason, /failed/);
});

test("returns not ok on an RPC error response", async () => {
  const fetchFn = async () => ({
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR" } }),
  });
  const r = await verifyPayment(baseArgs(fetchFn));
  assert.equal(r.ok, false);
  assert.match(r.reason, /rpc/);
});

test("returns not ok on an RPC HTTP error", async () => {
  const fetchFn = async () => ({ status: 500, json: async () => ({}) });
  const r = await verifyPayment(baseArgs(fetchFn));
  assert.equal(r.ok, false);
  assert.match(r.reason, /rpc/);
});

test("never throws when fetch throws", async () => {
  const fetchFn = async () => {
    throw new Error("socket hang up");
  };
  const r = await verifyPayment(baseArgs(fetchFn));
  assert.equal(r.ok, false);
  assert.match(r.reason, /rpc unavailable/);
});

test("never throws on bad JSON", async () => {
  const fetchFn = async () => ({
    status: 200,
    json: async () => {
      throw new Error("bad json");
    },
  });
  const r = await verifyPayment(baseArgs(fetchFn));
  assert.equal(r.ok, false);
  assert.match(r.reason, /rpc error/);
});
