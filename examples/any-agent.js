// any-agent.js — a plain-script agent (no Telegram) paying through a Capkey vault.
// Run: DRY_RUN=1 node examples/any-agent.js   (injected fakes: no secrets, no network)
import { createGuardedPayer } from "../src/guard.js";

const VAULT_ID = "vault2.wavecapkey.testnet";
const OWNER = "dave-owner.testnet";
const AGENT = "dave-agent2.testnet";
const RECIPIENT = "shop.wavecapkey.testnet";
const AMOUNT = 10n ** 23n; // 0.1 NEAR

const dryRun = process.env.DRY_RUN === "1";
if (dryRun) {
  // Fake vault read: no network, no secrets.
  // getVault decodes data.result.result as raw UTF-8 text, so the mock
  // returns the raw JSON string (not base64).
  globalThis.fetch = async () => ({
    json: async () => ({
      result: {
        result: JSON.stringify({
          agent: AGENT,
          balance: "1000000000000000000000000",
          spent_in_window: "0",
          remaining_today: "1000000000000000000000000",
          policy: {
            allowed_recipients: [RECIPIENT],
            one_time_recipients: [],
            per_tx_cap: "1000000000000000000000000",
            daily_limit: "5000000000000000000000000",
          },
        }),
      },
    }),
  });
}

const payer = createGuardedPayer({
  vaultId: VAULT_ID,
  ownerAccount: OWNER,
  agentAccount: AGENT,
  // Injected fake executor in dry run; a real agent would create its locked
  // account here from AGENT_KEY_FILE and NEAR_RPC_URL.
  getAgent: () => ({
    callFunctionRaw: async () => ({ transaction: { hash: "DRY-RUN-TX" } }),
  }),
});

async function main() {
  const quote = await payer.quote(RECIPIENT, AMOUNT);
  console.log(`quote ${RECIPIENT} ${AMOUNT.toString()}: ${quote.level} ${quote.reasons.join(", ") || "-"}`);
  if (quote.level === "block") return console.log("guarded: payment refused");
  const paid = await payer.pay(RECIPIENT, AMOUNT);
  console.log(paid.ok ? `paid ${paid.txHash}` : `pay failed: ${paid.reason}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
