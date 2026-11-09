import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "../../service/server.js";

const SERVICE = "service.testnet";
const PAYER = "payer.testnet";
const PRICE = 1000n;
const RPC = "https://rpc.test";
const HASH = "A".repeat(44);
const HASH2 = "B".repeat(44);

function paymentResult({
  signer = PAYER,
  receiver = SERVICE,
  deposit = "1000",
  status = { SuccessValue: "" },
} = {}) {
  return {
    status,
    transaction: { signer_id: signer },
    receipts: [
      {
        receiver_id: receiver,
        receipt: { Action: { actions: [{ Transfer: { deposit } }] } },
      },
    ],
  };
}

function rpcResponse(result, status = 200) {
  return {
    status,
    json: async () =>
      status === 200
        ? { jsonrpc: "2.0", id: "x", result }
        : { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR" } },
  };
}

// Routes RPC calls to a fake result and everything else to a fake site.
function makeFetch({ result = paymentResult(), rpcStatus = 200, onTarget } = {}) {
  return async (url, init) => {
    if (String(url) === RPC) return rpcResponse(result, rpcStatus);
    if (onTarget) return onTarget(String(url), init);
    return {
      status: 200,
      headers: new Headers({ server: "test-server", "content-type": "text/html" }),
      body: null,
    };
  };
}

async function withServer(options, fn) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "sentry-service-"));
  const server = createServer({
    serviceAccount: SERVICE,
    payerAccountId: PAYER,
    priceYocto: PRICE,
    rpcUrl: RPC,
    dataDir,
    fetchFn: options.fetchFn,
    lookupFn:
      options.lookupFn ?? (async () => [{ address: "93.184.216.34", family: 4 }]),
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, dataDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function checkUrl(base, url, tx = HASH) {
  const q = new URLSearchParams({ url, tx });
  return fetch(`${base}/check?${q}`);
}

test("GET /price returns the account and price", async () => {
  await withServer({ fetchFn: makeFetch() }, async ({ base }) => {
    const res = await fetch(`${base}/price`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { account: SERVICE, priceYocto: "1000" });
  });
});

test("a paid check succeeds and records the hash", async () => {
  await withServer({ fetchFn: makeFetch() }, async ({ base, dataDir }) => {
    const res = await checkUrl(base, "https://example.com");
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.url, "https://example.com");
    assert.equal(body.status, 200);
    assert.equal(body.finalUrl, "https://example.com/");
    assert.equal(body.tlsOk, true);
    assert.equal(typeof body.ms, "number");
    assert.equal(body.server, "test-server");

    const used = JSON.parse(readFileSync(path.join(dataDir, "used.json"), "utf8"));
    assert.deepEqual(used, [HASH]);
  });
});

test("rejects a wrong signer", async () => {
  const fetchFn = makeFetch({ result: paymentResult({ signer: "other.testnet" }) });
  await withServer({ fetchFn }, async ({ base }) => {
    const res = await checkUrl(base, "https://example.com");
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /signer/);
  });
});

test("rejects a wrong receiver", async () => {
  const fetchFn = makeFetch({ result: paymentResult({ receiver: "other.testnet" }) });
  await withServer({ fetchFn }, async ({ base }) => {
    const res = await checkUrl(base, "https://example.com");
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /receiver/);
  });
});

test("rejects too little paid", async () => {
  const fetchFn = makeFetch({ result: paymentResult({ deposit: "999" }) });
  await withServer({ fetchFn }, async ({ base }) => {
    const res = await checkUrl(base, "https://example.com");
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /too small/);
  });
});

test("rejects a failed transaction", async () => {
  const fetchFn = makeFetch({ result: paymentResult({ status: { Failure: {} } }) });
  await withServer({ fetchFn }, async ({ base }) => {
    const res = await checkUrl(base, "https://example.com");
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /failed/);
  });
});

test("rejects a reused transaction hash and does not fetch again", async () => {
  let targetCalls = 0;
  const fetchFn = makeFetch({
    onTarget: async () => {
      targetCalls += 1;
      return {
        status: 200,
        headers: new Headers({ server: "test-server" }),
        body: null,
      };
    },
  });

  await withServer({ fetchFn }, async ({ base }) => {
    const first = await checkUrl(base, "https://example.com", HASH);
    assert.equal(first.status, 200);

    const second = await checkUrl(base, "https://example.com", HASH);
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /already used/);
    assert.equal(targetCalls, 1);
  });
});

test("allows a different hash after a successful check", async () => {
  await withServer({ fetchFn: makeFetch() }, async ({ base }) => {
    assert.equal((await checkUrl(base, "https://example.com", HASH)).status, 200);
    assert.equal((await checkUrl(base, "https://example.com", HASH2)).status, 200);
  });
});

test("rejects an http URL", async () => {
  await withServer({ fetchFn: makeFetch() }, async ({ base }) => {
    const res = await checkUrl(base, "http://example.com");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /https/);
  });
});

test("rejects localhost", async () => {
  await withServer({ fetchFn: makeFetch() }, async ({ base }) => {
    const res = await checkUrl(base, "https://localhost/");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /localhost/);
  });
});

test("rejects a 192.168.x address", async () => {
  await withServer({ fetchFn: makeFetch() }, async ({ base }) => {
    const res = await checkUrl(base, "https://192.168.1.10/");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /private/);
  });
});

test("rejects a 10.x address", async () => {
  await withServer({ fetchFn: makeFetch() }, async ({ base }) => {
    const res = await checkUrl(base, "https://10.1.2.3/");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /private/);
  });
});

test("rejects a hostname that resolves to a private address", async () => {
  const lookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
  await withServer({ fetchFn: makeFetch(), lookupFn }, async ({ base }) => {
    const res = await checkUrl(base, "https://evil.example/");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /private/);
  });
});

test("rejects an RPC error", async () => {
  const fetchFn = makeFetch({ rpcStatus: 500 });
  await withServer({ fetchFn }, async ({ base }) => {
    const res = await checkUrl(base, "https://example.com");
    assert.equal(res.status, 402);
    assert.match((await res.json()).error, /rpc/);
  });
});

test("rejects a missing or malformed transaction hash", async () => {
  await withServer({ fetchFn: makeFetch() }, async ({ base }) => {
    const missing = await fetch(`${base}/check?url=${encodeURIComponent("https://example.com")}`);
    assert.equal(missing.status, 400);

    const bad = await checkUrl(base, "https://example.com", "not a hash");
    assert.equal(bad.status, 400);
  });
});

test("does not write used.json for a rejected payment", async () => {
  const fetchFn = makeFetch({ result: paymentResult({ signer: "other.testnet" }) });
  await withServer({ fetchFn }, async ({ base, dataDir }) => {
    const res = await checkUrl(base, "https://example.com");
    assert.equal(res.status, 402);
    assert.equal(existsSync(path.join(dataDir, "used.json")), false);
  });
});
