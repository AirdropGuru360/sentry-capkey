# capkey (near contract)

capkey is a near smart contract that lets a person give an ai agent a wallet with hard spending rules. the owner puts money in a vault and sets the rules. the agent can only spend inside them, and the owner can cut it off at any time.

built for NEAR HACKATHON, track: AI Security & Defense. it is the vault part of the Sentry x Capkey project (see the repo readme).

## the problem

an agent with a normal wallet key can spend everything it holds. it can be prompt-injected, get stuck in a loop, or pick the wrong recipient. the limits have to live onchain, outside the model, so the agent cannot talk its way around them.

## how it works

- the **owner** creates a vault, funds it with NEAR, and sets a policy: max per payment, max per 24 hours, a list of approved recipients, and an expiry time.
- the **agent** is a separate near account. it gets a near **function call key** locked to this contract and the single method `execute_payment`. with that key it cannot do anything else on the network, and it cannot touch the owner's other funds.
- every `execute_payment` call is checked by the contract against the policy. if any rule fails, the call panics and no money moves.
- the owner can `revoke_agent` (kill switch) and `withdraw` at any time, including after a revoke.
- the approved list can change on the fly without restarting the daily limit: `add_recipient` adds a recipient for good, `approve_once` adds one that is removed after a single payment (for example a fresh swap deposit address), and `remove_recipient` takes one off. `set_policy` is the full reset and still restarts the daily window.
- if a transfer fails (for example the recipient account does not exist), a callback puts the money back in the vault and undoes the daily spend.

## methods

| method | who calls it | what it does |
| --- | --- | --- |
| `new()` | deployer, once | sets up the contract |
| `create_vault(agent)` | owner | creates the owner's vault and names the agent account |
| `fund_vault()` (payable) | owner | adds the attached NEAR to the vault |
| `set_policy(per_tx_cap, daily_limit, allowed_recipients, expires_at)` | owner | sets the rules from scratch. amounts in yoctoNEAR (strings), expiry in nanoseconds. clears one-time approvals and restarts the daily window |
| `add_recipient(recipient)` | owner | adds a recipient to the approved list for good. does not touch the daily window or what was spent in it |
| `approve_once(recipient)` | owner | approves a recipient for exactly one payment. the approval is used up by the first accepted payment. does not touch the daily window |
| `remove_recipient(recipient)` | owner | takes a recipient (permanent or one-time) off the list, for example a one-time approval that was never used. does not touch the daily window |
| `execute_payment(owner, recipient, amount)` | agent | pays from the owner's vault if every rule passes |
| `revoke_agent()` | owner | stops the agent from spending and cancels unused one-time approvals |
| `rotate_agent(new_agent)` | owner | replaces the agent and turns spending back on |
| `withdraw(amount)` | owner | sends NEAR from the vault back to the owner |
| `get_vault(owner)` (view) | anyone | shows balance, agent, policy, pending one-time recipients, revoked flag, spent today, remaining today |

notes on the approved list:

- permanent and one-time recipients share one limit of 20 per vault.
- a one-time approval is used up by the first payment that passes every rule. a payment that is refused does not use it up. if the transfer itself bounces (for example the account does not exist), the money goes back to the vault but the approval stays used, so the owner approves again.
- payments to a one-time recipient count toward the same per-payment cap and daily limit as any other payment.
- only the owner can change the list. the agent's key can only call `execute_payment`.

payments are refused with a clear message: `agent has been revoked`, `policy has expired`, `recipient is not on the approved list`, `amount is over the per-transaction cap`, `payment would go over the daily limit`, `vault balance is too low`, `caller is not the agent for this vault`. changing the approved list can also be refused with: `recipient is already on the approved list`, `recipient already has a one-time approval`, `too many approved recipients (the limit is 20)`, `no policy set for this vault`.

## near tools used

- function call keys (the agent's key is limited to `execute_payment` on this contract)
- sub-accounts (separate accounts for the vault, the agent and the recipient)
- promises and callbacks (transfer, then refund if it fails)

## see the live result (read-only, no account needed)

the contract is live on testnet at `vault.wavecapkey.testnet`. with [near-cli-rs](https://github.com/near/near-cli-rs) installed, anyone can read it, no account or keys needed:

1. run:

```
near contract call-function as-read-only vault.wavecapkey.testnet get_vault json-args '{\"owner\":\"wavecapkey.testnet\"}' network-config testnet now
```

**see:** the vault of `wavecapkey.testnet` with `revoked: true`, `balance: "0"` and `spent_in_window` of 0.25 NEAR. this is the state left by the demo below. on windows powershell the backslashes before the quotes are needed. on mac or linux use plain quotes: `'{"owner":"wavecapkey.testnet"}'`.

## try it yourself (testnet)

what you need: rust (the repo pins version 1.93.0 in `rust-toolchain.toml`), the `wasm32-unknown-unknown` target, [cargo-near](https://github.com/near/cargo-near), [near-cli-rs](https://github.com/near/near-cli-rs), and a testnet account with a few NEAR (the examples use `wavecapkey.testnet`, replace it with yours everywhere). no secrets go in the repo, keys stay in your own keychain.

### build and deploy

note: `approve_once` added a field to the stored vault, so deploy this version to a **fresh account**. do not deploy it over a contract that already holds vaults from the first version, because those vaults could no longer be read.

1. build the contract (run this in `contracts/capkey`):

```
cargo near build non-reproducible-wasm --no-abi
```

**see:** `Contract successfully built!` and a path ending in `target/near/capkey.wasm`.

2. create an account for the contract:

```
near account create-account fund-myself vault.wavecapkey.testnet '3 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain sign-as wavecapkey.testnet network-config testnet sign-with-keychain send
```

**see:** `New account <vault.wavecapkey.testnet> created successfully.`

3. deploy and set it up:

```
near contract deploy vault.wavecapkey.testnet use-file target\near\capkey.wasm with-init-call new json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

**see:** `Contract code has been successfully deployed` and the `new` call succeeded.

### the agent and the recipient

4. create the agent account and the approved recipient:

```
near account create-account fund-myself agent.wavecapkey.testnet '1 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain sign-as wavecapkey.testnet network-config testnet sign-with-keychain send
```

```
near account create-account fund-myself shop.wavecapkey.testnet '0.1 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-keychain sign-as wavecapkey.testnet network-config testnet sign-with-keychain send
```

**see:** a success message for each account.

5. give the agent a restricted key. it can only call `execute_payment` on the vault, and it is saved as a file so the cli can sign with it:

```
near account add-key agent.wavecapkey.testnet grant-function-call-access --allowance '0.25 NEAR' --contract-account-id vault.wavecapkey.testnet --function-names 'execute_payment' autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain network-config testnet sign-with-keychain send
```

**see:** `Added access key` for `agent.wavecapkey.testnet`. the cli's normal keychain signing only picks full-access keys, so the commands below sign with the key file. in powershell, save its location first:

```
$f = (Get-ChildItem "$HOME\.near-credentials\testnet\agent.wavecapkey.testnet\*.json").FullName
```

### the demo

6. owner creates the vault, funds it with 2 NEAR, and sets the rules (max 0.1 NEAR per payment, 0.25 NEAR per day, only the shop can be paid, valid until 2026-11-27):

```
near contract call-function as-transaction vault.wavecapkey.testnet create_vault json-args '{\"agent\":\"agent.wavecapkey.testnet\"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as wavecapkey.testnet network-config testnet sign-with-keychain send
```

```
near contract call-function as-transaction vault.wavecapkey.testnet fund_vault json-args '{}' prepaid-gas '30 Tgas' attached-deposit '2 NEAR' sign-as wavecapkey.testnet network-config testnet sign-with-keychain send
```

```
near contract call-function as-transaction vault.wavecapkey.testnet set_policy json-args '{\"per_tx_cap\":\"100000000000000000000000\",\"daily_limit\":\"250000000000000000000000\",\"allowed_recipients\":[\"shop.wavecapkey.testnet\"],\"expires_at\":\"1795737600000000000\"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as wavecapkey.testnet network-config testnet sign-with-keychain send
```

**see:** a success message each, with logs `vault_created`, `vault_funded` and `policy_set`. then `get_vault` (from the section above) shows a balance of 2 NEAR and the rules.

7. **allowed payment.** the agent pays the shop 0.05 NEAR:

```
near contract call-function as-transaction vault.wavecapkey.testnet execute_payment json-args '{\"owner\":\"wavecapkey.testnet\",\"recipient\":\"shop.wavecapkey.testnet\",\"amount\":\"50000000000000000000000\"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as agent.wavecapkey.testnet network-config testnet sign-with-access-key-file $f send
```

**see:** log `payment_executed`, return value `true`, and the signing public key is the agent's restricted key.

8. **over the per-payment cap.** the agent tries 0.5 NEAR:

```
near contract call-function as-transaction vault.wavecapkey.testnet execute_payment json-args '{\"owner\":\"wavecapkey.testnet\",\"recipient\":\"shop.wavecapkey.testnet\",\"amount\":\"500000000000000000000000\"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as agent.wavecapkey.testnet network-config testnet sign-with-access-key-file $f send
```

**see:** error `capkey: amount is over the per-transaction cap`.

9. **recipient not approved.** the agent tries to pay `stranger.testnet`:

```
near contract call-function as-transaction vault.wavecapkey.testnet execute_payment json-args '{\"owner\":\"wavecapkey.testnet\",\"recipient\":\"stranger.testnet\",\"amount\":\"10000000000000000000000\"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as agent.wavecapkey.testnet network-config testnet sign-with-access-key-file $f send
```

**see:** error `capkey: recipient is not on the approved list`.

10. **daily limit.** run this command (it pays 0.1 NEAR) three times. 0.05 is already spent from step 7:

```
near contract call-function as-transaction vault.wavecapkey.testnet execute_payment json-args '{\"owner\":\"wavecapkey.testnet\",\"recipient\":\"shop.wavecapkey.testnet\",\"amount\":\"100000000000000000000000\"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as agent.wavecapkey.testnet network-config testnet sign-with-access-key-file $f send
```

**see:** the first two succeed. the third fails with `capkey: payment would go over the daily limit`.

11. **kill switch.** the owner revokes the agent, then the agent tries a payment:

```
near contract call-function as-transaction vault.wavecapkey.testnet revoke_agent json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as wavecapkey.testnet network-config testnet sign-with-keychain send
```

then run the command from step 7 again.

**see:** log `agent_revoked`, then the agent's payment fails with `capkey: agent has been revoked`.

12. **owner takes the money back** (the vault holds 1.75 NEAR at this point):

```
near contract call-function as-transaction vault.wavecapkey.testnet withdraw json-args '{\"amount\":\"1750000000000000000000000\"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as wavecapkey.testnet network-config testnet sign-with-keychain send
```

**see:** log `withdrawn`, and `get_vault` now shows `balance: "0"`.

### extra check on the restricted key

the agent's key can only call `execute_payment`. trying any other method with it, for example `create_vault`, is refused by the network before the contract runs: `Transaction method name <...> isn't allowed by the access key`.

## tests

`cargo test` runs 51 unit tests (run on linux), covering: vault creation and funding, an allowed payment, the per-payment cap, the approved list, the daily limit and its 24 hour reset, expiry, a missing policy, a low balance, revoke, withdraw after revoke, agent rotation, wrong caller, and the refund after a failed transfer. it also covers changing the approved list: adding, one-time approvals and removing recipients without restarting the daily window, the limit of 20 (permanent and one-time together), a one-time approval being used up once and not by a refused payment, and only the owner (never the agent) being able to change the list. the first 21 behaviours were also checked live on testnet (steps 6 to 12 above); the new approved-list methods are covered by the unit tests so far.

## not built yet

- NEAR only. no USDC or other fungible tokens yet.
- the contract account pays storage for new vaults. owners are not charged a storage deposit yet.
- no abi file (skipped on windows with `--no-abi`).
- no sandbox integration tests, only unit tests plus the live testnet run.
- no front end. the Sentry bot (see the repo readme) is the planned interface.

## history

the idea and the list of test cases come from an earlier solana prototype of capkey by the same author, which is a separate project and is not part of this repo. no code from it was reused. the contract in this folder was written from scratch for near, starting on 2026-10-28.
