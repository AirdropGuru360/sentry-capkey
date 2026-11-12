import test from "node:test";
import assert from "node:assert/strict";
import { bindExecutor, createPayflow } from "../src/payflow.js";
import { formatNear } from "../src/format.js";
import {
  parseBuyCommand,
  USAGE,
  buyState,
  onPaidCheck,
  buyReplyText,
} from "../src/buy.js";
import { fetchPrice } from "../src/service.js";

const SERVICE_URL = "http://127.0.0.1:8787";
const SERVICE = "service.testnet";
const VAULT = "vault2.wavecapkey.testnet";
const OWNER = "dave-owner.testnet";
const PRICE = "1000000000000000000000000"; // 1 NEAR
const PRICE_YOCTO = 10n ** 24n;
const CHECK_URL = "https://example.com/";
const TX = "A".repeat(44);

function json(status, body) {
  return { status, json: async () => body };
}

function nearText(yocto) {
  return formatNear(yocto, 24).replace(/ NEAR$/, "");
}

// Fake payflow: one executePayment, no Telegram, no network.
function makePayflow({ executePayment, assess, onPaid } = {}) {
  let n = 0;
  const calls = [];
  const exec = executePayment ?? (async () => ({ ok: true, txHash: "HASH1" }));
  const risk = assess ?? (async () => ({ level: "ok", reasons: [] }));
  const flow = createPayflow({
    clock: () => 1_000_000,
    newId: () => `id-${++n}`,
    assess: risk,
    executePayment: bindExecutor({
      getAgent: () => "AGENT",
      vaultId: VAULT,
      ownerId: OWNER,
      executePayment: async (account, payment) => {
        calls.push(payment);
        return exec(account, payment);
      },
    }),
    onPaid,
  });
  return { flow, calls };
}

// ---------------------------------------------------------------------------
// parseBuyCommand
// ---------------------------------------------------------------------------

test("parseBuyCommand accepts an https URL", () => {
  const r = parseBuyCommand("/buy check https://example.com");
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://example.com/");
});

test("parseBuyCommand accepts the Telegraf payload form and URL query", () => {
  const r = parseBuyCommand("check https://example.com/path?q=1");
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://example.com/path?q=1");

  const r2 = parseBuyCommand("/buy@bot check https://example.com/");
  assert.equal(r2.ok, true);
  assert.equal(r2.url, "https://example.com/");
});

test("parseBuyCommand rejects missing parts", () => {
  for (const text of ["/buy", "/buy check", "check", ""]) {
    const r = parseBuyCommand(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.text, USAGE);
  }
});

test("parseBuyCommand rejects non-https URLs", () => {
  for (const text of [
    "/buy check http://example.com",
    "/buy check ftp://example.com",
    "/buy check not-a-url",
  ]) {
    const r = parseBuyCommand(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.text, "Only https URLs are supported.");
  }
});

test("parseBuyCommand rejects unrelated commands", () => {
  const r = parseBuyCommand("/pay 0.5 shop.wavecapkey.testnet");
  assert.equal(r.ok, false);
  assert.equal(r.text, USAGE);
});

// ---------------------------------------------------------------------------
// fetchPrice gates
// ---------------------------------------------------------------------------

test("fetchPrice refuses a wrong account before any payment", async () => {
  const fetchFn = async () => json(200, { account: "other.testnet", priceYocto: PRICE });
  const r = await fetchPrice({ fetchFn, serviceUrl: SERVICE_URL, serviceAccountId: SERVICE });
  assert.equal(r.ok, false);
  assert.match(r.reason, /account/);
});

test("fetchPrice refuses a bad price before any payment", async () => {
  for (const price of ["0", "-1", "abc"]) {
    const fetchFn = async () => json(200, { account: SERVICE, priceYocto: price });
    const r = await fetchPrice({ fetchFn, serviceUrl: SERVICE_URL, serviceAccountId: SERVICE });
    assert.equal(r.ok, false, price);
    assert.match(r.reason, /price/, price);
  }
});

test("fetchPrice refuses an empty SERVICE_ACCOUNT_ID without calling fetch", async () => {
  let called = false;
  const fetchFn = async () => {
    called = true;
    return json(200, { account: SERVICE, priceYocto: PRICE });
  };
  const r = await fetchPrice({ fetchFn, serviceUrl: SERVICE_URL, serviceAccountId: "" });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// End-to-end /buy flow through the real payflow, with injected fetch
// ---------------------------------------------------------------------------

test("success: price, payment to the service, then site check", async () => {
  let priceCalls = 0;
  let checkCalls = 0;
  let checkUrlSeen;
  const priceFetch = async () => {
    priceCalls++;
    return json(200, { account: SERVICE, priceYocto: PRICE });
  };
  const checkFetch = async (url) => {
    checkCalls++;
    checkUrlSeen = url;
    return json(200, {
      url: CHECK_URL,
      status: 200,
      finalUrl: "https://example.com/",
      tlsOk: true,
      ms: 42,
      server: "test-server",
    });
  };

  const state = buyState();
  const { flow, calls } = makePayflow({
    executePayment: async () => ({ ok: true, txHash: TX }),
    onPaid: async ({ recipient, txHash }) => {
      return onPaidCheck({
        state,
        recipient,
        txHash,
        fetchFn: checkFetch,
        serviceUrl: SERVICE_URL,
        serviceAccountId: SERVICE,
      });
    },
  });

  const price = await fetchPrice({ fetchFn: priceFetch, serviceUrl: SERVICE_URL, serviceAccountId: SERVICE });
  assert.equal(price.ok, true);

  const { id, text } = await flow.request(`${nearText(PRICE_YOCTO)} ${SERVICE}`);
  assert.equal(id, "id-1");
  assert.equal(text, `Pay ${nearText(PRICE_YOCTO)} NEAR to ${SERVICE}? Expires in 60 seconds.`);
  state.url = CHECK_URL; // as index.js does after /buy

  const paid = await flow.confirm(id);
  assert.equal(paid.ok, true);
  assert.equal(paid.txHash, TX);
  assert.equal(paid.recipient, SERVICE);

  assert.equal(state.check.ok, true);
  const reply = buyReplyText({ paid, check: state.check });
  assert.match(reply, /status: 200/);
  assert.match(reply, /final URL: https:\/\/example.com\//);
  assert.match(reply, /TLS ok: true/);
  assert.match(reply, /42 ms/);
  assert.match(reply, /server: test-server/);
  assert.ok(reply.includes(`transactions/${TX}`));

  assert.equal(priceCalls, 1);
  assert.equal(checkCalls, 1);
  assert.equal(new URL(checkUrlSeen).searchParams.get("url"), CHECK_URL);
  assert.equal(new URL(checkUrlSeen).searchParams.get("tx"), TX);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    recipient: SERVICE,
    amountYocto: PRICE_YOCTO,
    vaultId: VAULT,
    ownerId: OWNER,
  });
});

test("wrong account in /price: no payment at all", async () => {
  let priceCalls = 0;
  const priceFetch = async () => {
    priceCalls++;
    return json(200, { account: "other.testnet", priceYocto: PRICE });
  };

  const { flow, calls } = makePayflow();
  const price = await fetchPrice({ fetchFn: priceFetch, serviceUrl: SERVICE_URL, serviceAccountId: SERVICE });
  assert.equal(price.ok, false);
  assert.equal(priceCalls, 1);
  assert.equal(calls.length, 0);
});

test("bad price: no payment at all", async () => {
  const priceFetch = async () => json(200, { account: SERVICE, priceYocto: "0" });
  const { flow, calls } = makePayflow();
  const price = await fetchPrice({ fetchFn: priceFetch, serviceUrl: SERVICE_URL, serviceAccountId: SERVICE });
  assert.equal(price.ok, false);
  assert.equal(calls.length, 0);
});

test("service error after payment: payment went through, txHash shown, no retry", async () => {
  const priceFetch = async () => json(200, { account: SERVICE, priceYocto: PRICE });
  const checkFetch = async () => {
    throw new Error("network down");
  };

  const state = buyState();
  const { flow, calls } = makePayflow({
    executePayment: async () => ({ ok: true, txHash: TX }),
    onPaid: async ({ recipient, txHash }) => {
      return onPaidCheck({
        state,
        recipient,
        txHash,
        fetchFn: checkFetch,
        serviceUrl: SERVICE_URL,
        serviceAccountId: SERVICE,
      });
    },
  });

  const price = await fetchPrice({ fetchFn: priceFetch, serviceUrl: SERVICE_URL, serviceAccountId: SERVICE });
  const { id } = await flow.request(`${nearText(PRICE_YOCTO)} ${SERVICE}`);
  state.url = CHECK_URL;

  const paid = await flow.confirm(id);
  assert.equal(paid.ok, true);
  assert.equal(state.check.ok, false);
  const reply = buyReplyText({ paid, check: state.check });
  assert.match(reply, /Payment went through:/);
  assert.ok(reply.includes(`transactions/${TX}`));
  assert.match(reply, /Not retrying automatically/);
  assert.equal(calls.length, 1);
});

test("non-https URL: rejected before any price fetch or payment", async () => {
  let priceCalls = 0;
  const priceFetch = async () => {
    priceCalls++;
    return json(200, { account: SERVICE, priceYocto: PRICE });
  };
  const { flow, calls } = makePayflow();

  const parsed = parseBuyCommand("/buy check http://example.com");
  assert.equal(parsed.ok, false);
  assert.equal(priceCalls, 0);
  assert.equal(calls.length, 0);
});

test("risk check blocks the /buy payment like any other payment", async () => {
  const { flow, calls } = makePayflow({
    assess: async () => ({ level: "block", reasons: ["Recipient is on the blocklist."] }),
  });
  const r = await flow.request(`${nearText(PRICE_YOCTO)} ${SERVICE}`);
  assert.equal(r.ok, false);
  assert.match(r.text, /blocklist/);
  assert.equal(calls.length, 0);
});

test("onPaidCheck does nothing for non-service payments", async () => {
  const state = buyState();
  let called = false;
  const check = await onPaidCheck({
    state,
    recipient: "shop.wavecapkey.testnet",
    txHash: TX,
    fetchFn: async () => { called = true; return json(200, {}); },
    serviceUrl: SERVICE_URL,
    serviceAccountId: SERVICE,
  });
  assert.equal(check, null);
  assert.equal(called, false);
  assert.equal(state.check, null);
});
