# Plug your agent into a Capkey vault

The vault is a reusable safety layer: the agent never holds funds or policy
power — it only holds a function-call key limited to `execute_payment`, and
every payment must pass the vault's on-chain rules plus your own risk check.
This guide shows how to wire any agent (a plain script, a Telegram bot, or
anything else) into a Capkey vault using `createGuardedPayer` (see `src/guard.js`).

## 1. Deploy or use a vault

Use an existing vault, or deploy the Capkey vault contract and initialize it.
The vault holds the owner's funds and enforces limits on-chain.

Testnet example (public, no secrets):

```
vault2.wavecapkey.testnet
owner: dave-owner.testnet
agent: dave-agent2.testnet  (holds only a locked function-call key)
```

## 2. create_vault

Initialize the vault as its owner so it can hold funds and track spending:

```
near call vault2.wavecapkey.testnet create_vault '{"owner": "dave-owner.testnet"}' --accountId dave-owner.testnet
```

Only the owner should ever call owner methods.

## 3. Give the agent a function-call key limited to execute_payment

The agent account must NOT have full access to the vault. Add a function-call
key that can call only `execute_payment` on the vault contract:

```
near call vault2.wavecapkey.testnet add_function_call_key \
  '{"public_key": "<agent public key>", "allowance": "...", "receiver_id": "vault2.wavecapkey.testnet", "method_names": ["execute_payment"]}' \
  --accountId dave-agent2.testnet
```

The owner can revoke this key at any time (step 6), instantly stopping the agent.

## 4. set_policy

Set the rules the vault enforces on every payment: max per payment, daily
limit, approved recipients. The owner uses `set_policy` (or `approve_once` /
`add_recipient` for one-off recipients — these do not reset the daily window).

```
near call vault2.wavecapkey.testnet set_policy '{
  "per_tx_cap": "1000000000000000000000000",
  "daily_limit": "5000000000000000000000000",
  "allowed_recipients": ["shop.wavecapkey.testnet"]
}' --accountId dave-owner.testnet
```

Amounts are yoctoNEAR strings (1 NEAR = 10^24).

## 5. The agent code

```js
import { createGuardedPayer } from "./guard.js";

const payer = createGuardedPayer({
  vaultId: "vault2.wavecapkey.testnet",
  ownerAccount: "dave-owner.testnet",
  agentAccount: "dave-agent2.testnet",
  getAgent: () => myAgentAccount, // your agent's near-api-js Account with the locked key
  rpcUrl: process.env.NEAR_RPC_URL,
});

const quote = await payer.quote("shop.wavecapkey.testnet", amountYocto);
// quote.level: "ok" | "warn" | "block". quote.allowed is false on "block".
if (!quote.allowed) return refuse(quote.reasons);

const result = await payer.pay("shop.wavecapkey.testnet", amountYocto);
// result.ok ? result.txHash : result.reason
```

`quote` runs the existing rule-based risk check plus a live preview of the
vault policy (approved recipients, per-payment cap, daily limit) fetched
read-only from the vault. `pay` executes through the existing executor — the
agent's locked key calling `execute_payment`. The vault enforces its rules
on-chain, so the agent can never pay more or to someone it is not allowed to.

For a runnable dry example with no secrets or network:

```
DRY_RUN=1 node examples/any-agent.js
```

## 6. What the owner can always do

| Action | Effect |
|--------|--------|
| Revoke the agent's function-call key | The agent stops paying immediately, on-chain. |
| Rotate the agent's key | Replace the locked key without changing the vault policy. |
| Change limits (`set_policy`) | New per-payment cap / daily limit apply to the next payment. |
| `approve_once` / `add_recipient` / `remove_recipient` | Adjust approved recipients without resetting the daily window. |

The bot adds checks on top of the vault; it never weakens the on-chain rules.