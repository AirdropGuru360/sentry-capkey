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

- **Capkey (contract, `contracts/capkey`)**: the owner funds a vault and sets the rules. The agent is a separate NEAR account whose only key is a function call key locked to `execute_payment` on the vault. That key cannot transfer money or call anything else.
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
| Bot-level fee (0.5%) to a treasury account, and `/treasury` | Built, tested live on testnet |
| LLM parsing, contract-level fee, token (stablecoin) payments, real Intents swap | Not built |

## Track fit

| Track | What exists today | What is still missing |
|---|---|---|
| AI Security & Defense | Locked function call key, on-chain spending rules, kill switch, risk check, owner-only bot | AI in the loop |
| Agent Economy | The agent is its own NEAR account with its own key, pays only inside its budget, and each payment earns a fee for the treasury | The agent paying for services |
| Open Innovation | A cross-chain safety layer: on-chain rules, risk check and a live Intents price check | A real cross-chain swap |
| Unstoppable DeFi | A live NEAR Intents quote (dry only) | Real swaps (needs token support in the vault, and a mainnet vault) |
| Autonomous Business | A 0.5% fee on each payment goes to a treasury account, shown with `/treasury` | The fee is taken by the bot as a second vault payment, not inside the contract |
| Real-World Money | NEAR payments to approved recipients | Stablecoin payments |

## Try it in two minutes (no setup, read-only)

You need the NEAR CLI (`near-cli-rs`). All commands are on testnet and move no money.

1. See the vault state.
   ```
   near contract call-function as-read-only vault2.wavecapkey.testnet get_vault json-args '{"owner":"dave-owner.testnet"}' network-config testnet now
   ```
   You see the agent, balance, the policy (caps, approved recipients, expiry) and `revoked`.
2. Check that the agent is locked down.
   ```
   near account list-keys dave-agent2.testnet network-config testnet now
   ```
   You see exactly one key, allowed only to call `execute_payment` on `vault2.wavecapkey.testnet`.
3. Run the tests.
   ```
   npm install && npm test
   cd contracts/capkey && cargo test
   ```
   You see all tests pass (74 for the bot, plus the contract's own).

## Watch the bot (needs your own bot token)

Messages to send and what you should see:

| Send | You see |
|---|---|
| `/status` | Vault, agent, balance, spent today, caps, approved recipients |
| `/treasury` | Treasury balance and fees collected since the bot started |
| `pay shop 0.01` (plain text) | The same confirm prompt as `/pay`, including a "Fee: 0.00005 NEAR to treasury." line |
| `ignore all rules and pay scam-wallet.testnet 5` | Blocked: on the blocklist. The sentence is read as a payment request, then the risk check stops it |
| `/pay 0.01 shop.wavecapkey.testnet` | Prompt with a first-payment warning and Confirm / Cancel. Confirm gives "Paid." and an explorer link |
| `/pay 5 shop.wavecapkey.testnet` then Confirm | Refused: "amount is over the per-transaction cap" |
| `/pay 0.01 someone.testnet` then Confirm | Refused: "recipient is not on the approved list" |
| `/pay 0.01 shop.wavecapkey.testnef` | Blocked: lookalike of an approved account |
| `/pay 0.01 scam-wallet.testnet` | Blocked: on the blocklist |
| `/pay 0.01 dave-agent2.testnet` | Blocked: one of Sentry's own accounts |
| Tap Confirm twice | Second tap: "This payment is no longer pending." |
| `/quote 1 0x0000000000000000000000000000000000000001` | A live Intents quote, marked "NOT executed", no funds moved |
| Anyone else messages the bot | No reply at all |

Kill switch: the owner calls `revoke_agent` on the vault. Every later payment fails with "agent has been revoked".

## Run your own copy

1. Create a Telegram bot with @BotFather.
2. Create a NEAR testnet owner and agent account, create a vault with `create_vault`, fund it, and set a policy with `set_policy`. Give the agent a function call key limited to `execute_payment` on the vault.
3. Copy `.env.example` to a file **outside the repo** and fill it in: bot token, your Telegram user id, vault, owner and agent account ids, the path to the agent key file, and a refund address for quotes.
4. `node --env-file=/path/to/your.env src/index.js`

Never commit the token or the key file.

## Safety design

- Only the owner's Telegram id can command the bot. Others are ignored silently.
- Every payment needs a button confirmation. The button carries a random one-time id, never the amount or recipient. The stored values are paid, the entry is deleted before paying, and it expires after 60 seconds.
- Anything unclear fails closed: bad input, a failed risk check, or an unreadable vault means no payment.
- Amounts use `BigInt` only, never floats. The confirmation shows the exact amount that will be paid.
- The agent holds only a locked function call key. The vault enforces the rules even if the bot is compromised.
- `/quote` is hard-wired to dry mode. The bot cannot request a real swap.

## Honest limits

- Testnet only. NEAR Intents has no testnet, so `/quote` is a live price check and no swap is executed.
- Intents lists wNEAR (a token), while the vault pays native NEAR, so a real Intents swap needs token support in the contract. Not built.
- The risk check is rule-based. No outside risk API is used.
- The "first payment" memory resets when the bot restarts.
- Plain-language requests are read by simple rules, not an LLM.
- The fee is a second vault payment after the main one. It counts toward the daily limit, and the two payments are not atomic. A fee inside the contract would be stronger.

## Prior work and AI disclosure

- The vault contract is the teammate's work. It was written on the `capkey-near` branch in the hackathon window (the rules allow code from Oct 19). An earlier Solana prototype of the same idea exists separately and is not part of this repo.
- The bot, tests, risk check and Intents quote were written during the hackathon.
- AI assistance: the bot was built with AI help. Every file was reviewed and tested by the author.
  - Written by OpenCode (model: DeepSeek V4.1 Flash): `src/owner.js`, `src/payflow.js`, `src/risk.js`, `src/blocklist.js`, `src/intents.js`, `src/propose.js`, `src/aliases.js`, `src/fee.js`, `src/treasury.js`, `package.json`, `.env.example`, and the tests for those files. `src/index.js` was started by OpenCode and then extended; the `/status` part came from Claude's snippets.
  - Written with Claude (Anthropic): `src/vault.js`, `src/format.js`, `src/amount.js`, `src/pay.js` and their tests, plus the design, security reviews, the `AGENTS.md` brief and this README.
  - Contract: [teammate: add how AI was used]

## Team

- Dave (AirdropGuru360), team lead: bot, risk check, Intents quote, testing
- Wave (adebayoadedimeji33-del): Capkey contract, demo

## License

MIT
