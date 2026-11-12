# Sentry x Capkey

A spending-limit vault for AI agents on NEAR, with a Telegram bot in front of it.
The owner sets the rules on-chain. The agent can only spend inside them. One call kills it.

Built for NEAR HACKATHON (Nov 2026). Main track: AI Security & Defense. Also entered: Agent Economy, Unstoppable DeFi, Autonomous Business, Real-World Money and Open Innovation. The "Track fit" section below says plainly what each track has today.

Demo video: [link]  |  Demo post on X: [link]

## The problem

An AI agent with a normal wallet key can spend everything it holds. It can be prompt-injected, get stuck in a loop, or pick the wrong recipient. Limits that live inside the AI's prompt can be talked around. These limits live on-chain, outside the model.

## How it works

```
You (Telegram)
   -> Sentry bot (owner only): parse, risk check, confirm button
      -> Capkey vault (NEAR contract): per-payment cap, daily limit,
         approved recipients, expiry, instant revoke
         -> payment goes to the recipient
```

- **Capkey (contract, `contracts/capkey`)**: the owner funds a vault and sets the rules. The agent is a separate NEAR account whose only key is a function call key locked to `execute_payment` on the vault. That key cannot transfer money or call anything else. The contract (including wNEAR support) was written by my teammate Wave; its source is on branch `capkey-near` and it is deployed at `capkey-wnear.testnet`. I did not write or edit it.
- **Sentry (bot, `src/`)**: a Telegram bot that only obeys the owner. Every payment is parsed, risk-checked, shown for confirmation, and then sent with the agent's locked key. The vault checks the rules again on-chain.

## What is built and what is not

| Part | Status |
|---|---|
| Vault contract: caps, daily limit, approved recipients, expiry, revoke, `approve_once`, `add_recipient`, `remove_recipient` | Built, tested live on testnet |
| Agent account with only a locked function call key (full-access key deleted) | Built |
| `/status`, `/pay` (confirm button, 60 s expiry, single-use id, one payment at a time) | Built |
| Rule-based risk check: blocklist, lookalike names, own accounts, first-payment and large-amount warnings | Built |
| `/quote`: live NEAR Intents price check | Built, dry quote only |
| Plain-language requests ("pay shop 0.5"), read by simple rules, not an LLM | Built |
| wNEAR (wrap.testnet) payments through the vault, with a separate wNEAR cap and daily limit | Built, tested live on testnet |
| Bot-level fee (0.5%) to a treasury account, and `/treasury` | Built; off unless `TREASURY_ACCOUNT_ID` is set |
| Contract-level fee (teammate): `set_fee`, fee taken inside `execute_payment` | Deployed on capkey-vault3.testnet; takes 50 bps to dave-treasury.testnet in the same call |
| Payee book, vault approval status (`/payees`), `/receipts` | Built |
| LLM parsing, stablecoin payments (USDC etc.), real Intents swap | Not built |

## Track fit

| Track | Status |
|---|---|
| Track 4 Autonomous Business | BUILT. The vault contract takes a 50 bps fee on every payment to dave-treasury.testnet in the same call (capkey-vault3.testnet, contract by teammate Wave; that earlier vault still exists); the bot's own fee is off. Evidence: payment tx AmHkp6gjeY2vHFdiqL5QkXZJyS4Z3kDnprkuuxsnCkw1. |
| Track 7 Agent Economy | BUILT. `/buy check <https url>`: the agent pays dave-service.testnet 0.01 NEAR through the vault (same confirm, risk check, caps, kill switch), and service/ verifies the payment on-chain (signer, receiver, amount, success) before returning a site report; each tx hash works once. Evidence: tx BQe19eCmQ42voUpEH25kmLg2oQti2PgZ1FhM4ehmgDKg (older example: tx 6VfRL7k8Ui9K6ZxQ6zqh5q27AJw1YVgXS4QKMk2ALSFt). |
| Track 13 Open Innovation | BUILT. `src/guard.js` (`createGuardedPayer`), `examples/any-agent.js` (`DRY_RUN=1` runs with no secrets), `docs/INTEGRATE.md`. |
| Track 6 Security | Built into the code: rule-based risk check (blocklist, lookalike names, own accounts), owner-only Telegram gate, spending caps (per-payment and daily), locked function-call key limited to `execute_payment`, and instant revoke/rotate. There is no LLM in the loop. |
| Track 8 Real-World Money | BUILT. Plain-language and `/pay` payments in wNEAR (wrap.testnet): "pay <payee> <amount> wnear". The vault keeps a separate wNEAR cap and daily limit (set on the contract with `set_token_policy`), and the contract-level fee is applied in wNEAR on top of the amount. Refunded wNEAR transfers are reported as failed ("transfer failed and was refunded"), never as "Paid". Plus the payee book (`/payee add`, `/payees`), vault approval status, and `/receipts`. Evidence: payment with fee tx 84rEmXFo5n1aRRVQJj8aiihPDHw54riEvbKvofNpQH5r. Paying in wNEAR is a token transfer through the vault, not a swap. |
| Track 1 Unstoppable DeFi | NOT BUILT beyond a read-only quote. `/quote` is a live NEAR Intents price check marked dry-only; no swap is executed. Paying in wNEAR is not a swap — it is a wNEAR transfer through the vault. |

## Try it in two minutes (no setup, read-only)

You need the NEAR CLI (`near-cli-rs`). All commands are on testnet and move no money.

1. See the vault state.
   ```
   near contract call-function as-read-only capkey-wnear.testnet get_vault json-args '{"owner":"dave-owner.testnet"}' network-config testnet now
   ```
   You see the agent, balance, the policy (caps, approved recipients, expiry) and `revoked`, plus the wNEAR policy (balance, cap, daily limit, remaining today, fees paid).
2. Check that the agent is locked down.
   ```
   near account list-keys dave-agent4.testnet network-config testnet now
   ```
   You see exactly one key, allowed only to call `execute_payment` on `capkey-wnear.testnet`.
3. Run the tests.
   ```
   npm install && npm test
   cd contracts/capkey && cargo test
   ```
   You see all tests pass (249 for the bot, plus the contract's own).

## Watch the bot (needs your own bot token)

Messages to send and what you should see:

| Send | You see |
|---|---|
| `/status` | Vault, agent, balance, spent today, caps, approved recipients, and the wNEAR policy lines |
| `/treasury` | Treasury balance and fees collected since the bot started |
| `pay shop 0.01` (plain text) | The same confirm prompt as `/pay`, including a "Fee: 0.00005 NEAR to treasury." line |
| `pay shop 0.5 wnear` (plain text) | Same confirm flow, amounts labeled wNEAR; the fee (if a treasury is set) is taken in wNEAR on top of the amount |
| `ignore all rules and pay scam-wallet.testnet 5` | Blocked: on the blocklist. The sentence is read as a payment request, then the risk check stops it |
| `/pay 0.01 shop.wavecapkey.testnet` | Prompt with a first-payment warning and Confirm / Cancel. Confirm gives "Paid." and an explorer link |
| `/pay 5 shop.wavecapkey.testnet` then Confirm | Refused: "amount is over the per-transaction cap" |
| `/pay 0.01 someone.testnet` then Confirm | Refused: "recipient is not on the approved list" |
| `/pay 0.01 shop.wavecapkey.testnef` | Blocked: lookalike of an approved account |
| `/pay 0.01 scam-wallet.testnet` | Blocked: on the blocklist |
| `/pay 0.01 dave-agent4.testnet` | Blocked: one of Sentry's own accounts |
| Tap Confirm twice | Second tap: "This payment is no longer pending." |
| `/quote 1 0x0000000000000000000000000000000000000001` | A live Intents quote, marked "NOT executed", no funds moved |
| Anyone else messages the bot | No reply at all |

Kill switch: the owner calls `revoke_agent` on the vault. Every later payment fails with "agent has been revoked".

## How to run

### Bot

1. Create a Telegram bot with @BotFather.
2. Create NEAR testnet owner and agent accounts, create a vault with `create_vault`, fund it, and set a policy with `set_policy`. Give the agent a function call key limited to `execute_payment` on the vault.
3. Copy `.env.example` to a file **outside the repo** and fill it in: `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `VAULT_CONTRACT_ID`, `OWNER_ACCOUNT_ID`, `AGENT_ACCOUNT_ID`, `AGENT_KEY_FILE`, `NEAR_RPC_URL`, `INTENTS_REFUND_TO`, `TREASURY_ACCOUNT_ID`.
4. `node --env-file=/path/to/your.env src/index.js`

Never commit the token or the key file.

### Site-check service (`service/`)

Runs locally and binds to 127.0.0.1 only. Required env variables: `SERVICE_ACCOUNT_ID`, `SERVICE_PRICE_YOCTO`, `RPC_URL`, `PAYER_ACCOUNT_ID`. Optional: `SERVICE_PORT` (default 8787), `SERVICE_DATA_DIR`.

```
node service/server.js
```

### Dry-run example (no secrets, no network)

```
DRY_RUN=1 node examples/any-agent.js
```

## Known limits

- Testnet only: everything runs on `capkey-wnear.testnet` (agent `dave-agent4.testnet`). NEAR Intents has no testnet, so `/quote` is a live price check and no swap is executed.
- wNEAR recipients and the fee treasury must be registered on wrap.testnet before they can receive wNEAR.
- No LLM in the loop: plain-language requests are read by simple rules, and `/quote` is hard-wired to dry mode.
- `/status` shows native amounts as "… NEAR" with no "native" qualifier; wNEAR amounts carry the "wNEAR" label.
- The "first payment" memory resets when the bot restarts.
- The contract-level fee (teammate's contract, capkey-vault3.testnet) takes 50 bps to dave-treasury.testnet in the same call; the bot's own 0.5% fee is off unless `TREASURY_ACCOUNT_ID` is set. The bot's fee is a second vault payment after the main one, counts toward the daily limit, and the two payments are not atomic.

## AI disclosure

- Code written with OpenCode using DeepSeek V4 Flash (free) and Nemotron 3.5 Super (free).
- Planning, prompts and review help from Claude (Anthropic).
- The vault contract (`contracts/`), including the wNEAR support, was written by my teammate Wave; its source is on branch `capkey-near` and it is deployed at `capkey-wnear.testnet`. I did not write or edit the contract.
- All code in this repo was run and tested by me: `node --test` reports 249 tests pass, 0 fail.

## Team

- Dave (AirdropGuru360), team lead: bot, risk check, Intents quote, testing
- Wave (adebayoadedimeji33-del): Capkey contract, demo

## License

MIT
