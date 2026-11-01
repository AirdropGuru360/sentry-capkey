# AGENTS.md - brief for AI coding agents (OpenCode)

Read this fully before writing any code. If something here conflicts with a request, stop and ask.

## Project
Sentry x Capkey, built for NEAR HACKATHON (deadline 2026-11-14 23:59 UTC).
Tracks: security (main), agents, defi.

- **Capkey** (done): a NEAR vault contract. The owner funds a vault and sets rules (max per payment, daily limit, approved recipients, expiry). The AI agent is a NEAR account whose function call key is locked to `execute_payment` on the vault. The owner can revoke instantly.
- **Sentry** (to build): a Telegram bot (@SentryCapkeyBot) where the owner asks the agent to pay. Flow: parse request -> risk check -> confirmation -> pay through the vault -> report result. Later: cross-chain payout through NEAR Intents 1Click, and a small fee.

## Fixed facts (public, testnet)
- Vault contract: `vault2.wavecapkey.testnet` (teammate's contract)
- Owner account: `dave-owner.testnet`
- Agent account: `dave-agent2.testnet` (holds ONLY a function call key for `execute_payment`)
- Approved recipient for tests: `shop.wavecapkey.testnet`
- Amounts are yoctoNEAR strings (1 NEAR = 10^24). Never use JavaScript floats for money; use BigInt.

## Hard rules
1. **Do not edit anything in `contracts/`.** It belongs to the teammate. Ask first.
2. **Never read, print, copy or commit secrets**: `.env`, `~/.near-credentials`, seed phrases, the Telegram bot token. Read secrets only from environment variables. `.env` must stay in `.gitignore`.
3. **No mainnet transactions** and no spending real tokens without asking me first. Intents has no testnet, so mainnet tests use tiny amounts and `dry: true` quotes only.
4. **Fail closed.** If a check, API or parse fails, the agent refuses and tells the owner. It never pays "just in case".
5. **Only the owner's Telegram user ID** (env `OWNER_TELEGRAM_ID`) may send commands. Ignore everyone else.
6. **Always ask for confirmation** ("Pay X to Y? Reply confirm") before any payment. Never auto-execute.
7. **Idempotency:** one unique ID per request, stored locally, so a retry never pays twice.
8. The vault enforces the rules on-chain. Do not re-implement or weaken them in the bot. The bot adds checks, never removes them.
9. Do not call `set_policy` per payout: it replaces the whole policy AND resets the daily window. Use the owner-only `approve_once`, `add_recipient` and `remove_recipient` methods instead (they do not reset the daily window).
10. Verify package names, endpoints and versions in the official docs before installing or using them. Do not guess. If unsure, say so.

## Stack
Node.js (runs on Android Termux / Debian). Keep dependencies few. Ask before adding a new one.
Likely: Telegraf (Telegram), near-api-js (NEAR), the NEAR Intents 1Click SDK. Check each in its docs first.

## Build order (do one at a time, stop after each)
1. Bot skeleton: `/start`, owner-only check, `.env` loading, `/status` reads `get_vault` (read-only).
2. Payment flow on testnet: parse -> confirm -> `execute_payment` signed with the agent's locked key -> report tx hash.
3. Risk check (rule-based first; add a real API only if verified).
4. 1Click quote (`dry: true`) and payout design (needs `add_recipient`).
5. Fee/treasury, README, demo.

## Working style
- I am learning. Work in small steps, explain each change in 2-3 short sentences, and wait for me before the next step.
- Keep replies short and simple.
- Small commits on branch `dave-bot`. Never push to `main` or `capkey-near`.
- Add tests for rules and parsing. Run them before saying something works.
- Keep a list of every file you generate, because the README must disclose AI-written code.
