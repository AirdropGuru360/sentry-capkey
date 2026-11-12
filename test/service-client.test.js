import test from "node:test";
import assert from "node:assert/strict";
import { serviceConfig, fetchPrice, fetchCheck } from "../src/service.js";

const SERVICE_URL = "http://127.0.0.1:8787";
const SERVICE = "service.testnet";

function json(status, body) {
  return { status, json: async () => body };
}

test("serviceConfig defaults SERVICE_URL and reads SERVICE_ACCOUNT_ID", () => {
  const hadUrl = process.env.SERVICE_URL;
  const hadAccount = process.env.SERVICE_ACCOUNT_ID;
  try {
    delete process.env.SERVICE_URL;
    delete process.env.SERVICE_ACCOUNT_ID;
    assert.deepEqual(serviceConfig(), { serviceUrl: SERVICE_URL, serviceAccountId: "" });

    process.env.SERVICE_URL = "https://custom.example/";
    process.env.SERVICE_ACCOUNT_ID = "service.testnet";
    assert.deepEqual(serviceConfig(), {
      serviceUrl: "https://custom.example",
      serviceAccountId: "service.testnet",
    });
  } finally {
    if (hadUrl === undefined) delete process.env.SERVICE_URL;
    else process.env.SERVICE_URL = hadUrl;
    if (hadAccount === undefined) delete process.env.SERVICE_ACCOUNT_ID;
    else process.env.SERVICE_ACCOUNT_ID = hadAccount;
  }
});

test("fetchPrice accepts the right account and a positive integer string price", async () => {
  let seenUrl;
  let seenInit;
  const fetchFn = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return json(200, { account: SERVICE, priceYocto: "1000" });
  };
  const r = await fetchPrice({ fetchFn, serviceUrl: SERVICE_URL, serviceAccountId: SERVICE });
  assert.equal(r.ok, true);
  assert.equal(r.priceYocto, "1000");
  assert.equal(seenUrl, `${SERVICE_URL}/price`);
  assert.ok(seenInit.signal, "5s timeout signal must be attached");
});

test("fetchPrice rejects a wrong account", async () => {
  const fetchFn = async () => json(200, { account: "other.testnet", priceYocto: "1000" });
  const r = await fetchPrice({ fetchFn, serviceUrl: SERVICE_URL, serviceAccountId: SERVICE });
  assert.equal(r.ok, false);
  assert.match(r.reason, /account/);
});

test("fetchPrice rejects a bad price", async () => {
  for (const price of ["", "0", "-5", "1.5", "abc", "1e3"]) {
    const fetchFn = async () => json(200, { account: SERVICE, priceYocto: price });
    const r = await fetchPrice({ fetchFn, serviceUrl: SERVICE_URL, serviceAccountId: SERVICE });
    assert.equal(r.ok, false, price);
    assert.match(r.reason, /price/, price);
  }
});

test("fetchPrice rejects a non-200 and invalid JSON", async () => {
  const r1 = await fetchPrice({
    fetchFn: async () => json(500, {}),
    serviceUrl: SERVICE_URL,
    serviceAccountId: SERVICE,
  });
  assert.equal(r1.ok, false);

  const r2 = await fetchPrice({
    fetchFn: async () => ({ status: 200, json: async () => { throw new Error("bad json"); } }),
    serviceUrl: SERVICE_URL,
    serviceAccountId: SERVICE,
  });
  assert.equal(r2.ok, false);
});

test("fetchPrice fails closed when fetch throws", async () => {
  const fetchFn = async () => {
    throw new Error("socket hang up");
  };
  const r = await fetchPrice({ fetchFn, serviceUrl: SERVICE_URL, serviceAccountId: SERVICE });
  assert.equal(r.ok, false);
  assert.match(r.reason, /price request failed/);
});

test("fetchPrice refuses when SERVICE_ACCOUNT_ID is empty", async () => {
  let called = false;
  const fetchFn = async () => {
    called = true;
    return json(200, { account: SERVICE, priceYocto: "1000" });
  };
  const r = await fetchPrice({ fetchFn, serviceUrl: SERVICE_URL, serviceAccountId: "" });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test("fetchCheck accepts a valid check response", async () => {
  let seenUrl;
  const fetchFn = async (url, init) => {
    seenUrl = url;
    return json(200, {
      url: "https://example.com/",
      status: 200,
      finalUrl: "https://example.com/",
      tlsOk: true,
      ms: 42,
      server: "test-server",
    });
  };
  const r = await fetchCheck({
    fetchFn,
    serviceUrl: SERVICE_URL,
    url: "https://example.com/",
    tx: "A".repeat(44),
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.finalUrl, "https://example.com/");
  assert.equal(r.tlsOk, true);
  assert.equal(r.ms, 42);
  assert.equal(r.server, "test-server");
  assert.ok(String(seenUrl).includes("/check?"));
  assert.ok(String(seenUrl).includes("tx="));
});

test("fetchCheck rejects a missing field", async () => {
  const fetchFn = async () =>
    json(200, { url: "https://example.com/", status: 200, finalUrl: "https://example.com/", tlsOk: true, ms: 1 });
  const r = await fetchCheck({ fetchFn, serviceUrl: SERVICE_URL, url: "https://example.com/", tx: "A".repeat(44) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /server/);
});

test("fetchCheck rejects non-200, invalid JSON, and fetch errors", async () => {
  const r1 = await fetchCheck({
    fetchFn: async () => json(502, {}),
    serviceUrl: SERVICE_URL,
    url: "https://example.com/",
    tx: "A".repeat(44),
  });
  assert.equal(r1.ok, false);

  const r2 = await fetchCheck({
    fetchFn: async () => ({ status: 200, json: async () => { throw new Error("bad json"); } }),
    serviceUrl: SERVICE_URL,
    url: "https://example.com/",
    tx: "A".repeat(44),
  });
  assert.equal(r2.ok, false);

  const r3 = await fetchCheck({
    fetchFn: async () => {
      throw new Error("network down");
    },
    serviceUrl: SERVICE_URL,
    url: "https://example.com/",
    tx: "A".repeat(44),
  });
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /check request failed/);
});
