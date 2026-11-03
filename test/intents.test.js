import test from "node:test";
import assert from "node:assert/strict";
import { getDryQuote } from "../src/intents.js";

const RECIPIENT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const REFUND = "dave-owner.testnet";
const URL = "https://1click.chaindefuser.com/v0/quote";

const goodBody = {
  quote: {
    amountOut: "1234567",
    amountOutFormatted: "1.234567",
    timeEstimate: 42,
  },
};

const jsonResponse = (status, body) => ({ status, json: async () => body });

// Captures every call, so tests can inspect the request body.
function capture(response) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return response;
  };
  return { fetchFn, calls };
}

const base = { amountYocto: 10n ** 24n, recipient: RECIPIENT, refundTo: REFUND };

test("returns the quote fields on success", async () => {
  const { fetchFn, calls } = capture(jsonResponse(200, goodBody));
  const r = await getDryQuote({ fetchFn, ...base });

  assert.deepEqual(r, { ok: true, receive: "1.234567", seconds: 42 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].body.amount, "1000000000000000000000000");
  assert.equal(calls[0].body.recipient, RECIPIENT);
  assert.equal(calls[0].body.refundTo, REFUND);
});

test("the deadline is about ten minutes ahead", async () => {
  const { fetchFn, calls } = capture(jsonResponse(200, goodBody));
  await getDryQuote({ fetchFn, ...base });

  const deadline = Date.parse(calls[0].body.deadline);
  assert.ok(Number.isFinite(deadline));
  const delta = deadline - Date.now();
  assert.ok(delta > 9 * 60 * 1000 && delta <= 10 * 60 * 1000 + 1000, String(delta));
});

test("accepts HTTP 201", async () => {
  const { fetchFn } = capture(jsonResponse(201, goodBody));
  assert.equal((await getDryQuote({ fetchFn, ...base })).ok, true);
});

test("HTTP 500 is quote unavailable", async () => {
  const { fetchFn } = capture(jsonResponse(500, {}));
  assert.deepEqual(await getDryQuote({ fetchFn, ...base }), {
    ok: false,
    reason: "quote unavailable",
  });
});

test("HTTP 400 is quote unavailable", async () => {
  const { fetchFn } = capture(jsonResponse(400, {}));
  assert.equal((await getDryQuote({ fetchFn, ...base })).ok, false);
});

test("invalid JSON is quote unavailable", async () => {
  const { fetchFn } = capture({
    status: 200,
    json: async () => {
      throw new Error("bad json");
    },
  });
  assert.equal((await getDryQuote({ fetchFn, ...base })).ok, false);
});

test("missing amountOut is quote unavailable", async () => {
  const { fetchFn } = capture(jsonResponse(200, { quote: { amountOutFormatted: "1" } }));
  assert.equal((await getDryQuote({ fetchFn, ...base })).ok, false);
});

test("amountOut that is not digits is quote unavailable", async () => {
  for (const amountOut of ["12.34", "1e9", "", 1234, null]) {
    const { fetchFn } = capture(jsonResponse(200, { quote: { amountOut } }));
    const r = await getDryQuote({ fetchFn, ...base });
    assert.equal(r.ok, false, String(amountOut));
  }
});

test("a bad amountOutFormatted is quote unavailable", async () => {
  const quotes = [
    { amountOut: "1", timeEstimate: 42 }, // missing
    { amountOut: "1", amountOutFormatted: 1234, timeEstimate: 42 }, // not a string
    { amountOut: "1", amountOutFormatted: "1.2abc", timeEstimate: 42 }, // letters
    { amountOut: "1", amountOutFormatted: "abc", timeEstimate: 42 },
    { amountOut: "1", amountOutFormatted: "1e3", timeEstimate: 42 },
    { amountOut: "1", amountOutFormatted: "", timeEstimate: 42 },
    { amountOut: "1", amountOutFormatted: "1.", timeEstimate: 42 },
    { amountOut: "1", amountOutFormatted: ".5", timeEstimate: 42 },
  ];
  for (const quote of quotes) {
    const { fetchFn } = capture(jsonResponse(200, { quote }));
    const r = await getDryQuote({ fetchFn, ...base });
    assert.equal(r.ok, false, JSON.stringify(quote));
  }
});

test("a bad timeEstimate is quote unavailable", async () => {
  const quotes = [
    { amountOut: "1", amountOutFormatted: "1" }, // missing
    { amountOut: "1", amountOutFormatted: "1", timeEstimate: "42" }, // string
    { amountOut: "1", amountOutFormatted: "1", timeEstimate: -1 }, // negative
    { amountOut: "1", amountOutFormatted: "1", timeEstimate: 3601 }, // huge
    { amountOut: "1", amountOutFormatted: "1", timeEstimate: 1e9 },
    { amountOut: "1", amountOutFormatted: "1", timeEstimate: NaN },
    { amountOut: "1", amountOutFormatted: "1", timeEstimate: Infinity },
  ];
  for (const quote of quotes) {
    const { fetchFn } = capture(jsonResponse(200, { quote }));
    const r = await getDryQuote({ fetchFn, ...base });
    assert.equal(r.ok, false, JSON.stringify(quote));
  }
});

test("timeEstimate boundaries 0 and 3600 are accepted", async () => {
  for (const timeEstimate of [0, 3600]) {
    const { fetchFn } = capture(
      jsonResponse(200, { quote: { amountOut: "1", amountOutFormatted: "1", timeEstimate } }),
    );
    const r = await getDryQuote({ fetchFn, ...base });
    assert.equal(r.ok, true, String(timeEstimate));
    assert.equal(r.seconds, timeEstimate);
  }
});

test("a thrown fetch error never escapes", async () => {
  const fetchFn = async () => {
    throw new Error("socket hang up");
  };
  assert.equal((await getDryQuote({ fetchFn, ...base })).ok, false);
});

test("a timeout never escapes", async () => {
  const fetchFn = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const r = await getDryQuote({ fetchFn, ...base });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "quote unavailable");
});

test("an invalid recipient never calls fetch", async () => {
  for (const recipient of ["0x123", "not-an-address", "", null, 42]) {
    const { fetchFn, calls } = capture(jsonResponse(200, goodBody));
    const r = await getDryQuote({ fetchFn, ...base, recipient });
    assert.equal(r.ok, false, String(recipient));
    assert.equal(calls.length, 0, String(recipient));
  }
});

test("a zero or negative amount never calls fetch", async () => {
  for (const amountYocto of [0n, -1n]) {
    const { fetchFn, calls } = capture(jsonResponse(200, goodBody));
    const r = await getDryQuote({ fetchFn, ...base, amountYocto });
    assert.equal(r.ok, false, String(amountYocto));
    assert.equal(calls.length, 0, String(amountYocto));
  }
});

test("a non-bigint amount never calls fetch", async () => {
  for (const amountYocto of ["1000", 1000, 1.5, null, undefined]) {
    const { fetchFn, calls } = capture(jsonResponse(200, goodBody));
    const r = await getDryQuote({ fetchFn, ...base, amountYocto });
    assert.equal(r.ok, false, String(amountYocto));
    assert.equal(calls.length, 0, String(amountYocto));
  }
});

test("a missing refund address never calls fetch", async () => {
  for (const refundTo of ["", "   ", null, undefined]) {
    const { fetchFn, calls } = capture(jsonResponse(200, goodBody));
    const r = await getDryQuote({ fetchFn, ...base, refundTo });
    assert.equal(r.ok, false, String(refundTo));
    assert.equal(calls.length, 0, String(refundTo));
  }
});

test("every request is dry with the fixed assets", async () => {
  const { fetchFn, calls } = capture(jsonResponse(200, goodBody));

  await getDryQuote({ fetchFn, ...base, amountYocto: 1n });
  await getDryQuote({ fetchFn, ...base, amountYocto: 10n ** 24n });
  // Even a caller-supplied dry:false is ignored: the body is fixed.
  await getDryQuote({ fetchFn, ...base, dry: false });

  assert.equal(calls.length, 3);
  for (const { body } of calls) {
    assert.equal(body.dry, true);
    assert.equal(body.swapType, "EXACT_INPUT");
    assert.equal(body.slippageTolerance, 100);
    assert.equal(body.originAsset, "nep141:wrap.near");
    assert.equal(body.depositType, "ORIGIN_CHAIN");
    assert.equal(
      body.destinationAsset,
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    );
    assert.equal(body.refundType, "ORIGIN_CHAIN");
    assert.equal(body.recipientType, "DESTINATION_CHAIN");
    assert.equal(typeof body.amount, "string");
  }
});
