import test from "node:test";
import assert from "node:assert/strict";
import { createPayflow, parsePayCommand, bindExecutor } from "../src/payflow.js";
import { assessRecipient } from "../src/risk.js";

// Fake clock, fake executePayment and fake risk check: no Telegram, no network.
function setup({ executePayment, assess, treasury, feeBps = 50 } = {}) {
  let now = 1_000_000;
  let n = 0;
  const calls = [];
  const exec =
    executePayment ??
    (async (payment) => {
      calls.push(payment);
      return { ok: true, txHash: "HASH1" };
    });
  const risk = assess ?? (async () => ({ level: "ok", reasons: [] }));
  const flow = createPayflow({
    clock: () => now,
    executePayment: exec,
    assess: risk,
    treasury,
    feeBps,
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

test("request asks for confirmation and stores the payment", async () => {
  const { flow } = setup();
  const r = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
  assert.equal(r.ok, true);
  assert.equal(r.id, "id-1");
  assert.equal(
    r.text,
    "Pay 0.5 NEAR to shop.wavecapkey.testnet? Expires in 60 seconds.",
  );
});

test("the prompt shows the exact amount and the stored amount is exact", async () => {
  const { flow, calls } = setup();
  const r = await flow.request("/pay 0.123456789 shop.wavecapkey.testnet");
  assert.equal(r.ok, true);
  assert.ok(r.text.includes("0.123456789"), r.text);

  const paid = await flow.confirm(r.id);
  assert.equal(paid.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].amountYocto, 123456789000000000000000n);
});

test("a blocked recipient creates no pending payment", async () => {
  const { flow, calls } = setup({
    assess: async () => ({ level: "block", reasons: ["Recipient is on the blocklist."] }),
  });

  const r = await flow.request("/pay 0.5 scam-wallet.testnet");
  assert.equal(r.ok, false);
  assert.match(r.text, /blocklist/);
  assert.equal(r.id, undefined);

  // Nothing was stored, so even the id that would have been used is unknown.
  const after = await flow.confirm("id-1");
  assert.equal(after.ok, false);
  assert.match(after.text, /no longer pending/i);
  assert.equal(calls.length, 0);
});

test("warnings are added to the confirmation prompt", async () => {
  const { flow } = setup({
    assess: async () => ({
      level: "warn",
      reasons: ["This is the first payment to this recipient."],
    }),
  });

  const r = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
  assert.equal(r.ok, true);
  assert.match(r.text, /Warnings:/);
  assert.match(r.text, /first payment/);
});

test("a failing risk check blocks instead of paying", async () => {
  const { flow, calls } = setup({
    assess: async () => {
      throw new Error("risk service down");
    },
  });

  const r = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
  assert.equal(r.ok, false);
  assert.match(r.text, /risk check failed/);
  assert.equal(calls.length, 0);
});

test("confirm checks the risk again before paying", async () => {
  let checks = 0;
  const { flow, calls } = setup({
    assess: async () => {
      checks++;
      return checks === 1
        ? { level: "ok", reasons: [] }
        : { level: "block", reasons: ["Recipient is on the blocklist."] };
    },
  });

  const { id } = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);
  assert.equal(r.ok, false);
  assert.match(r.text, /blocklist/);
  assert.equal(checks, 2);
  assert.equal(calls.length, 0);
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
    assess: async () => ({ level: "ok", reasons: [] }),
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

  const { id } = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
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
  const { id } = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);
  assert.equal(r.ok, true);
  assert.equal(r.recipient, "shop.wavecapkey.testnet"); // lets index.js fill paidBefore
  assert.equal(
    r.text,
    "Paid.\nhttps://explorer.testnet.near.org/transactions/HASH1",
  );
  assert.deepEqual(calls, [
    { recipient: "shop.wavecapkey.testnet", amountYocto: 500000000000000000000000n },
  ]);
});

test("confirm is single use: the second tap never pays", async () => {
  const { flow, calls } = setup();
  const { id } = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
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
  const { id } = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
  advance(60_001);
  const r = await flow.confirm(id);
  assert.equal(r.ok, false);
  assert.match(r.text, /expired/i);
  assert.equal(calls.length, 0);
});

test("cancel deletes the pending payment", async () => {
  const { flow, calls } = setup();
  const { id } = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
  assert.equal(flow.cancel(id).ok, true);

  const r = await flow.confirm(id);
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test("a refused payment shows the vault's reason", async () => {
  const { flow } = setup({
    executePayment: async () => ({
      ok: false,
      reason: "recipient is not on the approved list",
    }),
  });
  const { id } = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);
  assert.equal(r.ok, false);
  assert.equal(r.text, "recipient is not on the approved list");
});

test("a thrown error is not reported as success", async () => {
  const { flow } = setup({
    executePayment: async () => {
      throw new Error("boom");
    },
  });
  const { id } = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
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

  const { flow } = setup({
    executePayment: async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      started();
      await gate;
      running--;
      return { ok: true, txHash: "HASH1" };
    },
  });

  const a = await flow.request("/pay 0.1 shop.wavecapkey.testnet");
  const b = await flow.request("/pay 0.2 shop.wavecapkey.testnet");
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

const TREASURY = "dave-treasury.testnet";

test("the prompt shows the fee when a treasury is set", async () => {
  const { flow } = setup({ treasury: TREASURY });
  const r = await flow.request("/pay 1 shop.wavecapkey.testnet");
  assert.equal(r.ok, true);
  assert.match(r.text, /Fee: 0\.005 NEAR to treasury\./);
});

test("no treasury means no fee and exactly one call", async () => {
  const { flow, calls } = setup();
  const r = await flow.request("/pay 1 shop.wavecapkey.testnet");
  assert.doesNotMatch(r.text, /Fee:/);

  const paid = await flow.confirm(r.id);
  assert.equal(paid.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(flow.getCollectedFees(), 0n);
});

test("a failed main payment is never charged a fee", async () => {
  const seen = [];
  const { flow } = setup({
    treasury: TREASURY,
    executePayment: async (payment) => {
      seen.push(payment);
      return { ok: false, reason: "daily limit reached" };
    },
  });

  const { id } = await flow.request("/pay 1 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);
  assert.equal(r.ok, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].recipient, "shop.wavecapkey.testnet");
  assert.equal(flow.getCollectedFees(), 0n);
});

test("a successful payment also collects the fee, with both links", async () => {
  const seen = [];
  let n = 0;
  const { flow } = setup({
    treasury: TREASURY,
    executePayment: async (payment) => {
      seen.push(payment);
      n++;
      return { ok: true, txHash: `H${n}` };
    },
  });

  const { id } = await flow.request("/pay 1 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);

  assert.equal(r.ok, true);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], {
    recipient: "shop.wavecapkey.testnet",
    amountYocto: 10n ** 24n,
  });
  assert.deepEqual(seen[1], { recipient: TREASURY, amountYocto: 5n * 10n ** 21n });
  assert.match(r.text, /transactions\/H1/);
  assert.match(r.text, /transactions\/H2/);
  assert.match(r.text, /Fee: 0\.005 NEAR/);
  assert.equal(flow.getCollectedFees(), 5n * 10n ** 21n);
});

test("a failed fee keeps the main payment paid and is never retried", async () => {
  let feeCalls = 0;
  const { flow } = setup({
    treasury: TREASURY,
    executePayment: async (payment) => {
      if (payment.recipient === TREASURY) {
        feeCalls++;
        return { ok: false, reason: "treasury is locked" };
      }
      return { ok: true, txHash: "MAIN" };
    },
  });

  const { id } = await flow.request("/pay 1 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);

  assert.equal(r.ok, true);
  assert.equal(
    r.text,
    "Paid.\nhttps://explorer.testnet.near.org/transactions/MAIN\nFee not collected: treasury is locked",
  );
  assert.equal(feeCalls, 1);
  assert.equal(flow.getCollectedFees(), 0n);
});

test("a fee that throws is reported, not retried", async () => {
  let feeCalls = 0;
  const { flow } = setup({
    treasury: TREASURY,
    executePayment: async (payment) => {
      if (payment.recipient === TREASURY) {
        feeCalls++;
        throw new Error("socket hang up");
      }
      return { ok: true, txHash: "MAIN" };
    },
  });

  const { id } = await flow.request("/pay 1 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);

  assert.equal(r.ok, true);
  assert.match(r.text, /Fee not collected: payment failed/);
  assert.equal(feeCalls, 1);
});

test("a fee computation error still reports the main payment as paid", async () => {
  const seen = [];
  const { flow } = setup({
    treasury: TREASURY,
    feeBps: 500, // invalid: computeFee throws at fee time
    executePayment: async (payment) => {
      seen.push(payment);
      return { ok: true, txHash: "MAIN" };
    },
  });

  const { id } = await flow.request("/pay 1 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);

  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(
    r.text,
    "Paid.\nhttps://explorer.testnet.near.org/transactions/MAIN\nFee not collected: fee error.",
  );
  assert.equal(flow.getCollectedFees(), 0n);
});

test("the treasury is blocked as one of our own accounts", async () => {
  const { flow, calls } = setup({
    treasury: TREASURY,
    assess: async ({ recipient, amountYocto }) =>
      assessRecipient({
        recipient,
        amountYocto,
        approved: ["shop.wavecapkey.testnet"],
        perTxCap: 10n * 10n ** 24n,
        selfIds: [TREASURY],
        blocklist: [],
        paidBefore: new Set(),
      }),
  });

  const r = await flow.request("/pay 1 dave-treasury.testnet");
  assert.equal(r.ok, false);
  assert.match(r.text, /own accounts/);
  assert.equal(calls.length, 0);
});

test("two concurrent confirms never overlap, including fee calls", async () => {
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

  const { flow } = setup({
    treasury: TREASURY,
    executePayment: async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      started();
      await gate;
      running--;
      return { ok: true, txHash: "H" };
    },
  });

  const a = await flow.request("/pay 1 shop.wavecapkey.testnet");
  const b = await flow.request("/pay 2 shop.wavecapkey.testnet");
  const first = flow.confirm(a.id);
  const second = flow.confirm(b.id);

  await firstStarted;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(maxRunning, 1);

  release();
  const [ra, rb] = await Promise.all([first, second]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.equal(maxRunning, 1);
});

// ---------------------------------------------------------------------------
// onPaid callback
// ---------------------------------------------------------------------------

test("onPaid is called once after a successful payment (no fee)", async () => {
  const calls = [];
  let n = 0;
  const flow = createPayflow({
    clock: () => 1_000_000,
    newId: () => `id-${++n}`,
    assess: async () => ({ level: "ok", reasons: [] }),
    executePayment: async () => ({ ok: true, txHash: "HTXHASH" }),
    onPaid: async (info) => { calls.push(info); },
  });

  const { id } = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);

  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].recipient, "shop.wavecapkey.testnet");
  assert.equal(calls[0].amountYocto, 500000000000000000000000n);
  assert.equal(calls[0].txHash, "HTXHASH");
  assert.equal(calls[0].feeYocto, 0n);
  assert.equal(calls[0].feeTxHash, undefined);
});

test("onPaid is not called when the payment fails or is blocked", async () => {
  const calls = [];
  let n = 0;

  // Blocked at request time
  const blocked = createPayflow({
    clock: () => 1_000_000,
    newId: () => `id-${++n}`,
    assess: async () => ({ level: "block", reasons: ["blocklisted"] }),
    executePayment: async () => ({ ok: true, txHash: "HTXHASH" }),
    onPaid: async (info) => { calls.push(info); },
  });
  await blocked.request("/pay 0.5 shop.wavecapkey.testnet");
  assert.equal(calls.length, 0);

  // Failed at execute time
  const failed = createPayflow({
    clock: () => 1_000_000,
    newId: () => `id-${++n}`,
    assess: async () => ({ level: "ok", reasons: [] }),
    executePayment: async () => ({ ok: false, reason: "daily limit reached" }),
    onPaid: async (info) => { calls.push(info); },
  });
  const { id } = await failed.request("/pay 0.5 shop.wavecapkey.testnet");
  await failed.confirm(id);
  assert.equal(calls.length, 0);
});

test("a throwing onPaid does not change the result", async () => {
  let n = 0;
  const flow = createPayflow({
    clock: () => 1_000_000,
    newId: () => `id-${++n}`,
    assess: async () => ({ level: "ok", reasons: [] }),
    executePayment: async () => ({ ok: true, txHash: "HTXHASH" }),
    onPaid: async () => { throw new Error("callback boom"); },
  });

  const { id } = await flow.request("/pay 0.5 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);

  assert.equal(r.ok, true);
  assert.equal(r.txHash, "HTXHASH");
});

test("onPaid receives feeYocto 0n and no feeTxHash when the fee payment fails", async () => {
  const calls = [];
  let n = 0;
  const TREASURY = "dave-treasury.testnet";

  const flow = createPayflow({
    clock: () => 1_000_000,
    newId: () => `id-${++n}`,
    assess: async () => ({ level: "ok", reasons: [] }),
    treasury: TREASURY,
    executePayment: async (payment) => {
      if (payment.recipient === TREASURY) return { ok: false, reason: "treasury locked" };
      return { ok: true, txHash: "MAIN" };
    },
    onPaid: async (info) => { calls.push(info); },
  });

  const { id } = await flow.request("/pay 1 shop.wavecapkey.testnet");
  const r = await flow.confirm(id);

  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].txHash, "MAIN");
  assert.equal(calls[0].feeYocto, 0n);
  assert.equal(calls[0].feeTxHash, undefined);
});
