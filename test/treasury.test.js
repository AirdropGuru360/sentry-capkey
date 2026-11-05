import test from "node:test";
import assert from "node:assert/strict";
import { getBalance } from "../src/treasury.js";

const TREASURY = "dave-treasury.testnet";

const jsonResponse = (status, body) => ({ status, json: async () => body });

function capture(response) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return response;
  };
  return { fetchFn, calls };
}

test("returns the balance as a BigInt", async () => {
  const { fetchFn, calls } = capture(
    jsonResponse(200, { result: { amount: "1500000000000000000000000" } }),
  );
  const r = await getBalance(TREASURY, fetchFn);

  assert.equal(r.ok, true);
  assert.equal(r.yocto, 1500000000000000000000000n);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.method, "query");
  assert.equal(calls[0].body.params.request_type, "view_account");
  assert.equal(calls[0].body.params.finality, "final");
  assert.equal(calls[0].body.params.account_id, TREASURY);
});

test("bad JSON is not ok", async () => {
  const { fetchFn } = capture({
    status: 200,
    json: async () => {
      throw new Error("bad json");
    },
  });
  assert.deepEqual(await getBalance(TREASURY, fetchFn), { ok: false });
});

test("an HTTP error is not ok", async () => {
  for (const status of [500, 404, 429]) {
    const { fetchFn } = capture(jsonResponse(status, {}));
    assert.equal((await getBalance(TREASURY, fetchFn)).ok, false, String(status));
  }
});

test("a non-digit amount is not ok", async () => {
  for (const amount of ["12.5", "1e9", "", 1234, null, undefined]) {
    const { fetchFn } = capture(jsonResponse(200, { result: { amount } }));
    assert.equal((await getBalance(TREASURY, fetchFn)).ok, false, String(amount));
  }
});

test("a thrown fetch error never escapes", async () => {
  const fetchFn = async () => {
    throw new Error("socket hang up");
  };
  assert.equal((await getBalance(TREASURY, fetchFn)).ok, false);
});

test("a timeout never escapes", async () => {
  const fetchFn = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  assert.equal((await getBalance(TREASURY, fetchFn)).ok, false);
});

test("a missing account id never calls fetch", async () => {
  for (const id of ["", null, undefined, 42]) {
    const { fetchFn, calls } = capture(jsonResponse(200, { result: { amount: "1" } }));
    assert.equal((await getBalance(id, fetchFn)).ok, false, String(id));
    assert.equal(calls.length, 0, String(id));
  }
});
