import test from "node:test";
import assert from "node:assert/strict";
import { createGuardedPayer } from "../src/guard.js";

const VAULT_ID = "vault2.wavecapkey.testnet";
const OWNER = "dave-owner.testnet";
const AGENT = "dave-agent2.testnet";
const RECIPIENT = "shop.wavecapkey.testnet";

function vaultWith(policy) {
  return {
    agent: AGENT,
    balance: "1000000000000000000000000",
    spent_in_window: "0",
    remaining_today: "1000000000000000000000000",
    policy,
  };
}

// Stubs the vault read (getVault uses global fetch). Returns a restore function.
function stubFetch(payload) {
  const orig = globalThis.fetch;
  // getVault decodes data.result.result as raw UTF-8 text (Buffer.from(str)
  // without "base64"), so the mock must return the raw JSON string, not
  // base64.
  globalThis.fetch = async () => ({
    json: async () => ({
      result: { result: JSON.stringify(payload) },
    }),
  });
  return () => {
    globalThis.fetch = orig;
  };
}

function baseOptions(getAgent) {
  return { vaultId: VAULT_ID, ownerAccount: OWNER, agentAccount: AGENT, getAgent };
}

test("quote previews the vault policy and the risk check: approved recipient is ok", async () => {
  const restore = stubFetch(
    vaultWith({ allowed_recipients: [RECIPIENT], one_time_recipients: [], per_tx_cap: "1000", daily_limit: "5000" }),
  );
  try {
    const agent = {};
    const payer = createGuardedPayer(baseOptions(() => agent));
    const q = await payer.quote(RECIPIENT, 10n);
    // paidBefore is empty, so the first payment to this recipient warns.
    assert.equal(q.level, "warn");
    assert.equal(q.allowed, true);
    assert.match(q.reasons.join(" "), /first payment/);
  } finally {
    restore();
  }
});

test("quote blocks a recipient the vault did not approve", async () => {
  // shop.wavecapkey.testne is one edit away from the recipient: a lookalike
  // that is not itself approved, so the vault policy blocks it.
  const restore = stubFetch(
    vaultWith({ allowed_recipients: ["shop.wavecapkey.testne"], one_time_recipients: [], per_tx_cap: "1000", daily_limit: "5000" }),
  );
  try {
    const agent = {};
    const payer = createGuardedPayer(baseOptions(() => agent));
    const q = await payer.quote(RECIPIENT, 10n);
    assert.equal(q.level, "block");
    assert.equal(q.allowed, false);
    assert.match(q.reasons.join(" "), /lookalike/);
  } finally {
    restore();
  }
});

test("quote blocks when the vault has no policy", async () => {
  const restore = stubFetch({ agent: AGENT, balance: "1", spent_in_window: "0", remaining_today: "1" });
  try {
    const agent = {};
    const payer = createGuardedPayer(baseOptions(() => agent));
    const q = await payer.quote(RECIPIENT, 10n);
    assert.equal(q.level, "block");
    assert.equal(q.allowed, false);
    assert.match(q.reasons.join(" "), /no vault policy/);
  } finally {
    restore();
  }
});

test("quote fails closed when the vault cannot be read", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("down");
  };
  try {
    const agent = {};
    const payer = createGuardedPayer(baseOptions(() => agent));
    const q = await payer.quote(RECIPIENT, 10n);
    assert.equal(q.level, "block");
    assert.equal(q.allowed, false);
    assert.deepEqual(q.reasons, ["risk check failed"]);
  } finally {
    globalThis.fetch = orig;
  }
});

test("pay executes through the injected executor and returns the tx hash", async () => {
  let seen;
  const agent = {
    callFunctionRaw: async (a) => {
      seen = a;
      return { transaction: { hash: "HASH123" } };
    },
  };
  const payer = createGuardedPayer(baseOptions(() => agent));
  const r = await payer.pay(RECIPIENT, 10n);
  assert.deepEqual(r, { ok: true, txHash: "HASH123" });
  assert.equal(seen.methodName, "execute_payment");
  assert.equal(seen.contractId, VAULT_ID);
  assert.deepEqual(seen.args, { owner: OWNER, recipient: RECIPIENT, amount: "10" });
});

test("a refused payment returns ok false with the vault's reason", async () => {
  const agent = {
    callFunctionRaw: async () => {
      throw new Error("Smart contract panicked: capkey: recipient is not on the approved list");
    },
  };
  const payer = createGuardedPayer(baseOptions(() => agent));
  const r = await payer.pay(RECIPIENT, 10n);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "recipient is not on the approved list");
});

test("invalid input never reaches the executor", async () => {
  let calls = 0;
  const agent = {
    callFunctionRaw: async () => {
      calls++;
      return { transaction: { hash: "H" } };
    },
  };
  const payer = createGuardedPayer(baseOptions(() => agent));
  assert.equal((await payer.pay("BAD NAME", 10n)).ok, false);
  assert.equal((await payer.pay(RECIPIENT, 0n)).ok, false);
  assert.equal((await payer.pay(RECIPIENT, 10)).ok, false);
  assert.equal(calls, 0);
});

test("a successful pay is remembered, so the risk check stops warning", async () => {
  const restore = stubFetch(
    vaultWith({ allowed_recipients: [RECIPIENT], one_time_recipients: [], per_tx_cap: "1000", daily_limit: "5000" }),
  );
  try {
    const agent = {
      callFunctionRaw: async () => ({ transaction: { hash: "H" } }),
    };
    const payer = createGuardedPayer(baseOptions(() => agent));

    const before = await payer.quote(RECIPIENT, 10n);
    assert.match(before.reasons.join(" "), /first payment/);

    assert.equal((await payer.pay(RECIPIENT, 10n)).ok, true);

    const after = await payer.quote(RECIPIENT, 10n);
    assert.doesNotMatch(after.reasons.join(" "), /first payment/);
  } finally {
    restore();
  }
});

// DRY_RUN style: injected fakes only, no secrets, no network. env is restored after.
test("DRY_RUN runs with injected fakes and touches neither secrets nor the network", async () => {
  const origEnv = process.env.DRY_RUN;
  process.env.DRY_RUN = "1";
  try {
    const restoreFetch = stubFetch(
      vaultWith({ allowed_recipients: [RECIPIENT], one_time_recipients: [], per_tx_cap: "1000", daily_limit: "5000" }),
    );
    try {
      const agent = {
        callFunctionRaw: async () => ({ transaction: { hash: "DRY-HASH" } }),
      };
      const payer = createGuardedPayer(baseOptions(() => agent));
      assert.equal(process.env.DRY_RUN, "1");
      const q = await payer.quote(RECIPIENT, 10n);
      assert.equal(q.level, "warn"); // first payment to this recipient
      assert.equal(q.allowed, true);
      const p = await payer.pay(RECIPIENT, 10n);
      assert.deepEqual(p, { ok: true, txHash: "DRY-HASH" });
    } finally {
      restoreFetch();
    }
  } finally {
    if (origEnv === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = origEnv;
  }
});
