import test from "node:test";
import assert from "node:assert/strict";
import { getVault } from "../src/vault.js";

// getVault passes the contract response straight through, token included:
// no Telegram, no keys, just the RPC mock.
function stubFetch(payload) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => ({
      result: { result: JSON.stringify(payload) },
    }),
  });
  return () => {
    globalThis.fetch = orig;
  };
}

test("getVault passes the token object through unchanged", async () => {
  const token = {
    token_id: "wrap.testnet",
    balance: "5000000000000000000000000",
    policy: { per_tx_cap: "1000000000000000000000000", daily_limit: "5000000000000000000000000" },
    spent_in_window: "0",
    window_start: 0,
    remaining_today: "1000000000000000000000000",
    total_fees_paid: "123000000000000000000000",
  };
  const vault = { agent: "dave-agent2.testnet", balance: "0", token };

  const restore = stubFetch(vault);
  try {
    const got = await getVault("capkey-wnear.testnet", "dave-owner.testnet");
    assert.deepEqual(got, vault);
    assert.equal(got.token.token_id, "wrap.testnet");
    assert.equal(got.token.balance, token.balance);
    assert.equal(got.token.total_fees_paid, token.total_fees_paid);
  } finally {
    restore();
  }
});
