import test from "node:test";
import assert from "node:assert/strict";
import { createPayflow, parsePayCommand, bindExecutor } from "../src/payflow.js";

// Fake clock and fake executePayment: no Telegram, no network.
function setup(executePayment) {
  let now = 1_000_000;
  let n = 0;
  const calls = [];
  const exec =
    executePayment ??
    (async (payment) => {
      calls.push(payment);
      return { ok: true, txHash: "HASH1" };
    });
  const flow = createPayflow({
    clock: () => now,
    executePayment: exec,
    newId: () => `id-${++n}`,
  });
  return {
    flow,
    calls,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("parsePayCommand reads amount and recipient", () => {
  const r = parsePayCommand("/pay 0.5 shop.wavecapkey.testnet");
  assert.equal(r.ok, true);
  assert.equal(r.amountYocto, 500000000000000000000000n);
  assert.equal(r.recipient, "shop.wavecapkey.testnet");
});

test("parsePayCommand rejects an invalid amount", () => {
  for (const bad of ["/pay 0 shop.wavecapkey.testnet", "/pay 1.5.5 shop.wavecapkey.testnet", "/pay -1 shop.wavecapkey.testnet"]) {
    const r = parsePayCommand(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.text, /amount/i, bad);
  }
});

test("parsePayCommand rejects an invalid recipient", () => {
  const r = parsePayCommand("/pay 0.5 BAD NAME");
  assert.equal(r.ok, false);
  assert.match(r.text, /recipient/i);
});

test("request asks for confirmation and stores the payment", () => {
  const { flow } = setup();
  const r = flow.request("/pay 0.5 shop.wavecapkey.testnet");
  assert.equal(r.ok, true);
  assert.equal(r.id, "id-1");
  assert.equal(
    r.text,
    "Pay 0.5 NEAR to shop.wavecapkey.testnet? Expires in 60 seconds.",
  );
});

test("the prompt shows the exact amount and the stored amount is exact", async () => {
  const { flow, calls } = setup();
  const r = flow.request("/pay 0.123456789 shop.wavecapkey.testnet");
  assert.equal(r.ok, true);
  assert.ok(r.text.includes("0.123456789"), r.text);

  const paid = await flow.confirm(r.id);
  assert.equal(paid.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].amountYocto, 123456789000000000000000n);
});

test("bindExecutor adds vaultId and ownerId and stays lazy", async () => {
  let agentCalls = 0;
  const seen = [];
  const bound = bindExecutor({
    getAgent: () => {
      agentCalls++;
      return "AGENT";
    },
    vaultId: "vault2.wavecapkey.testnet",
    ownerId: "dave-owner.testnet",
    executePayment: async (account, payment) => {
      seen.push({ account, payment });
      return { ok: true, txHash: "HASH1" };
    },
  });

  assert.equal(agentCalls, 0); // nothing happens until a confirm calls it
  const r = await bound({ recipient: "shop.wavecapkey.testnet", amountYocto: 5n });

  assert.equal(r.ok, true);
  assert.equal(agentCalls, 1);
  assert.deepEqual(seen, [
    {
      account: "AGENT",
      payment: {
        recipient: "shop.wavecapkey.testnet",
        amountYocto: 5n,
        vaultId: "vault2.wavecapkey.testnet",
        ownerId: "dave-owner.testnet",
      },
    },
  ]);
});

test("a confirmed payment reaches the vault with vaultId and ownerId", async () => {
  const seen = [];
  const flow = createPayflow({
    clock: () => 1_000_000,
    newId: () => "id-1",
    executePayment: bindExecutor({
      getAgent: () => "AGENT",
      vaultId: "vault2.wavecapkey.testnet",
      ownerId: "dave-owner.testnet",
      executePayment: async (account, payment) => {
        seen.push(payment);
        return { ok: true, txHash: "HASH1" };
      },
    }),
  });

  const { id } = flow.request("/pay 0.5 shop.wavecapkey.testnet");
  assert.equal((await flow.confirm(id)).ok, true);
  assert.deepEqual(seen, [
    {
      recipient: "shop.wavecapkey.testnet",
      amountYocto: 500000000000000000000000n,
      vaultId: "vault2.wavecapkey.testnet",
      ownerId: "dave-owner.testnet",
    },
  ]);
});

test("confirm pays with the stored values, not the typed text", async () => {
  const { flow, calls } = setup();
  const { id } = flow.request("/pay 0.5 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);
  assert.equal(r.ok, true);
  assert.equal(
    r.text,
    "Paid. https://explorer.testnet.near.org/transactions/HASH1",
  );
  assert.deepEqual(calls, [
    { recipient: "shop.wavecapkey.testnet", amountYocto: 500000000000000000000000n },
  ]);
});

test("confirm is single use: the second tap never pays", async () => {
  const { flow, calls } = setup();
  const { id } = flow.request("/pay 0.5 shop.wavecapkey.testnet");
  assert.equal((await flow.confirm(id)).ok, true);

  const second = await flow.confirm(id);
  assert.equal(second.ok, false);
  assert.match(second.text, /no longer pending/i);
  assert.equal(calls.length, 1);
});

test("unknown id is refused and pays nothing", async () => {
  const { flow, calls } = setup();
  const r = await flow.confirm("does-not-exist");
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test("an expired request is refused and pays nothing", async () => {
  const { flow, calls, advance } = setup();
  const { id } = flow.request("/pay 0.5 shop.wavecapkey.testnet");
  advance(60_001);
  const r = await flow.confirm(id);
  assert.equal(r.ok, false);
  assert.match(r.text, /expired/i);
  assert.equal(calls.length, 0);
});

test("cancel deletes the pending payment", async () => {
  const { flow, calls } = setup();
  const { id } = flow.request("/pay 0.5 shop.wavecapkey.testnet");
  assert.equal(flow.cancel(id).ok, true);

  const r = await flow.confirm(id);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test("a refused payment shows the vault's reason", async () => {
  const { flow } = setup(async () => ({
    ok: false,
    reason: "recipient is not on the approved list",
  }));
  const { id } = flow.request("/pay 0.5 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);
  assert.equal(r.ok, false);
  assert.equal(r.text, "recipient is not on the approved list");
});

test("a thrown error is not reported as success", async () => {
  const { flow } = setup(async () => {
    throw new Error("boom");
  });
  const { id } = flow.request("/pay 0.5 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);
  assert.equal(r.ok, false);
});

test("two simultaneous confirms never run in parallel", async () => {
  let running = 0;
  let maxRunning = 0;
  let started;
  const firstStarted = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const { flow } = setup(async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    started();
    await gate;
    running--;
    return { ok: true, txHash: "HASH1" };
  });

  const a = flow.request("/pay 0.1 shop.wavecapkey.testnet");
  const b = flow.request("/pay 0.2 shop.wavecapkey.testnet");
  const first = flow.confirm(a.id);
  const second = flow.confirm(b.id);

  await firstStarted;
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the second one try
  assert.equal(maxRunning, 1);

  release();
  const [ra, rb] = await Promise.all([first, second]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.equal(maxRunning, 1);
});
