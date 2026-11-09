//! capkey: spending-policy vaults for AI agents on NEAR.
//!
//! An owner funds a vault and sets a policy (per-transaction cap, daily limit,
//! approved recipients, expiry). The agent is a separate NEAR account that can only
//! call `execute_payment`. Give that account a function call key locked to this
//! contract and the method `execute_payment`, and the agent can never spend outside
//! the policy. The owner can revoke the agent at any time and withdraw the funds.
//!
//! The approved list can change without restarting the daily window: `add_recipient`
//! adds a permanent recipient, `approve_once` adds a recipient that is removed after
//! one payment (for example a fresh deposit address from a swap quote), and
//! `remove_recipient` takes either kind back off.
//!
//! The owner can also set a fee (`set_fee`, at most 2%) that the contract sends to a
//! treasury account inside every `execute_payment`, on top of the payment itself. The
//! agent cannot skip it, because it is part of the same call.
//!
//! One token is supported next to NEAR: wNEAR on testnet (`wrap.testnet`, NEP-141). The
//! owner deposits it with `ft_transfer_call` (the contract tracks the vault's wNEAR
//! balance), sets a separate cap and daily limit with `set_token_policy`, and the agent
//! pays it out with `execute_ft_payment`. Token payments follow the same rules as NEAR
//! payments (approved recipients, expiry, revoke switch, fee), but the token has its own
//! cap, daily window and balance, so the NEAR limits are not affected by token payments
//! and the token limits are not affected by NEAR payments.
//!
//! Amounts are in yoctoNEAR (1 NEAR = 10^24 yoctoNEAR); wNEAR amounts use the same
//! 24 decimals. Timestamps are nanoseconds.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

/// The only token the vault accepts: wNEAR on testnet.
const WNEAR_TOKEN: &str = "wrap.testnet";
/// Gas for each `ft_transfer` call to the token contract.
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
/// Gas for the callback that checks the token transfers (it reads up to two results).
const FT_CALLBACK_GAS: Gas = Gas::from_tgas(10);

/// One day in nanoseconds: the length of the daily spending window.
const DAY_NS: u64 = 86_400_000_000_000;
/// Most recipients a vault can have at once: permanent and one-time approvals together.
const MAX_RECIPIENTS: usize = 20;
/// The highest fee an owner can set: 200 basis points = 2%.
const MAX_FEE_BPS: u16 = 200;
const BPS_DENOMINATOR: u128 = 10_000;
const CALLBACK_GAS: Gas = Gas::from_tgas(5);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Vaults,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Policy {
    per_tx_cap: u128,
    daily_limit: u128,
    allowed_recipients: Vec<AccountId>,
    expires_at: u64,
}

/// A fee that is paid to `treasury` on top of every payment: `bps` basis points
/// (1 bps = 0.01%) of the payment amount, rounded down.
#[near(serializers = [borsh])]
#[derive(Clone)]
struct Fee {
    bps: u16,
    treasury: AccountId,
}

/// The cap and daily limit for wNEAR payments. They are separate from the NEAR limits.
#[near(serializers = [borsh])]
#[derive(Clone)]
struct TokenPolicy {
    per_tx_cap: u128,
    daily_limit: u128,
}

/// Everything the vault tracks for wNEAR, kept apart from the NEAR numbers.
#[near(serializers = [borsh])]
#[derive(Default)]
struct TokenAccount {
    balance: u128,
    policy: Option<TokenPolicy>,
    window_start: u64,
    spent_in_window: u128,
    /// wNEAR fees sent to the treasury so far (fees that bounced are not counted).
    fees_paid: u128,
}

#[near(serializers = [borsh])]
struct Vault {
    agent: AccountId,
    balance: u128,
    policy: Option<Policy>,
    window_start: u64,
    spent_in_window: u128,
    revoked: bool,
    /// Recipients approved for exactly one payment each. A recipient leaves this list
    /// the moment a payment to it is accepted.
    one_time_recipients: Vec<AccountId>,
    /// The fee taken on every payment, if the owner set one.
    fee: Option<Fee>,
    /// Total fees sent to the treasury so far (fees that bounced are not counted).
    fees_paid: u128,
    /// The wNEAR side of the vault.
    token: TokenAccount,
}

#[near(serializers = [json])]
pub struct PolicyView {
    pub per_tx_cap: U128,
    pub daily_limit: U128,
    pub allowed_recipients: Vec<AccountId>,
    pub expires_at: U64,
}

#[near(serializers = [json])]
pub struct VaultView {
    pub agent: AccountId,
    pub balance: U128,
    pub revoked: bool,
    pub policy: Option<PolicyView>,
    pub one_time_recipients: Vec<AccountId>,
    /// Fee in basis points (0 means no fee) and where it goes.
    pub fee_bps: u16,
    pub fee_treasury: Option<AccountId>,
    /// Total fees paid to the treasury so far, in yoctoNEAR.
    pub total_fees_paid: U128,
    pub spent_in_window: U128,
    pub window_start: U64,
    pub remaining_today: U128,
    /// The wNEAR side of the vault: balance, limits and fees, all in wNEAR.
    pub token: TokenView,
}

#[near(serializers = [json])]
pub struct TokenPolicyView {
    pub per_tx_cap: U128,
    pub daily_limit: U128,
}

#[near(serializers = [json])]
pub struct TokenView {
    /// The token contract (always `wrap.testnet`).
    pub token_id: AccountId,
    pub balance: U128,
    /// `None` until the owner calls `set_token_policy`.
    pub policy: Option<TokenPolicyView>,
    pub spent_in_window: U128,
    pub window_start: U64,
    pub remaining_today: U128,
    pub total_fees_paid: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Capkey {
    vaults: LookupMap<AccountId, Vault>,
}

#[near]
impl Capkey {
    #[init]
    pub fn new() -> Self {
        Self {
            vaults: LookupMap::new(StorageKey::Vaults),
        }
    }

    // ---------------------------------------------------------------- owner

    /// Create your vault and name the agent account allowed to spend from it.
    pub fn create_vault(&mut self, agent: AccountId) {
        let owner = env::predecessor_account_id();
        require!(
            !self.vaults.contains_key(&owner),
            "capkey: you already have a vault"
        );
        require!(
            agent != owner,
            "capkey: the agent must be a different account than the owner"
        );
        self.vaults.insert(
            owner.clone(),
            Vault {
                agent: agent.clone(),
                balance: 0,
                policy: None,
                window_start: 0,
                spent_in_window: 0,
                revoked: false,
                one_time_recipients: Vec::new(),
                fee: None,
                fees_paid: 0,
                token: TokenAccount::default(),
            },
        );
        log_event("vault_created", json!({ "owner": owner, "agent": agent }));
    }

    /// Add the attached NEAR to your vault.
    #[payable]
    pub fn fund_vault(&mut self) {
        let owner = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, "capkey: attach a deposit to fund the vault");
        let vault = self.vault_mut(&owner);
        vault.balance += deposit;
        let balance = vault.balance;
        log_event(
            "vault_funded",
            json!({ "owner": owner, "amount": deposit.to_string(), "balance": balance.to_string() }),
        );
    }

    /// Deposit wNEAR into your vault. Do not call this yourself: the token contract
    /// (`wrap.testnet`) calls it when you send wNEAR with
    /// `ft_transfer_call { receiver_id: <this contract>, amount, msg: "" }`.
    ///
    /// Only wNEAR is accepted, and only into the vault of the account that sent it. If
    /// the sender has no vault, the whole amount is handed back (returned as unused) and
    /// the token contract refunds it. A plain `ft_transfer` to this contract is NOT
    /// credited, so always deposit with `ft_transfer_call`.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = msg;
        require!(
            env::predecessor_account_id() == wnear(),
            "capkey: only wNEAR (wrap.testnet) is accepted"
        );
        let Some(vault) = self.vaults.get_mut(&sender_id) else {
            // No vault to credit: give everything back.
            return PromiseOrValue::Value(amount);
        };
        vault.token.balance = vault
            .token
            .balance
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("capkey: amount is too large"));
        let balance = vault.token.balance;
        log_event(
            "token_deposit",
            json!({
                "owner": sender_id,
                "token": WNEAR_TOKEN,
                "amount": amount.0.to_string(),
                "balance": balance.to_string(),
            }),
        );
        // Everything was used.
        PromiseOrValue::Value(U128(0))
    }

    /// Set the cap and daily limit for wNEAR payments. They are separate from the NEAR
    /// limits and in wNEAR units (24 decimals). Replaces any earlier token policy and
    /// restarts the wNEAR daily window only. wNEAR payments also need the NEAR policy
    /// (`set_policy`), because the approved list and the expiry are shared.
    pub fn set_token_policy(&mut self, per_tx_cap: U128, daily_limit: U128) {
        let owner = env::predecessor_account_id();
        require!(
            per_tx_cap.0 > 0,
            "capkey: per-transaction cap must be above zero"
        );
        require!(
            daily_limit.0 >= per_tx_cap.0,
            "capkey: daily limit must be at least the per-transaction cap"
        );
        let vault = self.vault_mut(&owner);
        vault.token.policy = Some(TokenPolicy {
            per_tx_cap: per_tx_cap.0,
            daily_limit: daily_limit.0,
        });
        vault.token.window_start = 0;
        vault.token.spent_in_window = 0;
        log_event(
            "token_policy_set",
            json!({
                "owner": owner,
                "token": WNEAR_TOKEN,
                "per_tx_cap": per_tx_cap.0.to_string(),
                "daily_limit": daily_limit.0.to_string(),
            }),
        );
    }

    /// Set the spending policy. Replaces any earlier policy, clears any one-time
    /// approvals and restarts the daily window. To change only the approved list, use
    /// `add_recipient`, `approve_once` and `remove_recipient` instead.
    pub fn set_policy(
        &mut self,
        per_tx_cap: U128,
        daily_limit: U128,
        allowed_recipients: Vec<AccountId>,
        expires_at: U64,
    ) {
        let owner = env::predecessor_account_id();
        require!(
            per_tx_cap.0 > 0,
            "capkey: per-transaction cap must be above zero"
        );
        require!(
            daily_limit.0 >= per_tx_cap.0,
            "capkey: daily limit must be at least the per-transaction cap"
        );
        require!(
            !allowed_recipients.is_empty() && allowed_recipients.len() <= MAX_RECIPIENTS,
            "capkey: provide between 1 and 20 approved recipients"
        );
        require!(
            expires_at.0 > env::block_timestamp(),
            "capkey: expiry must be in the future"
        );
        let vault = self.vault_mut(&owner);
        vault.policy = Some(Policy {
            per_tx_cap: per_tx_cap.0,
            daily_limit: daily_limit.0,
            allowed_recipients: allowed_recipients.clone(),
            expires_at: expires_at.0,
        });
        vault.one_time_recipients.clear();
        vault.window_start = 0;
        vault.spent_in_window = 0;
        log_event(
            "policy_set",
            json!({
                "owner": owner,
                "per_tx_cap": per_tx_cap.0.to_string(),
                "daily_limit": daily_limit.0.to_string(),
                "allowed_recipients": allowed_recipients,
                "expires_at": expires_at.0.to_string(),
            }),
        );
    }

    /// Add one recipient to the approved list for good, WITHOUT touching the daily
    /// window or what was already spent in it. If the recipient currently has a
    /// one-time approval, it becomes a permanent one.
    pub fn add_recipient(&mut self, recipient: AccountId) {
        let owner = env::predecessor_account_id();
        let vault = self.vault_mut(&owner);
        let Vault {
            policy,
            one_time_recipients,
            ..
        } = vault;
        let policy = policy
            .as_mut()
            .unwrap_or_else(|| env::panic_str("capkey: no policy set for this vault"));
        require!(
            !policy.allowed_recipients.contains(&recipient),
            "capkey: recipient is already on the approved list"
        );
        match one_time_recipients.iter().position(|r| *r == recipient) {
            // Promoting a one-time approval keeps the total number of recipients the same.
            Some(i) => {
                one_time_recipients.remove(i);
            }
            None => {
                require!(
                    policy.allowed_recipients.len() + one_time_recipients.len() < MAX_RECIPIENTS,
                    "capkey: too many approved recipients (the limit is 20)"
                );
            }
        }
        policy.allowed_recipients.push(recipient.clone());
        log_event(
            "recipient_added",
            json!({ "owner": owner, "recipient": recipient }),
        );
    }

    /// Approve a recipient for exactly ONE payment, WITHOUT touching the daily window.
    /// The approval is used up by the first accepted payment to that recipient, even if
    /// the transfer later bounces (the money returns to the vault, the approval does
    /// not). Useful for single-use addresses such as a swap deposit address.
    pub fn approve_once(&mut self, recipient: AccountId) {
        let owner = env::predecessor_account_id();
        let vault = self.vault_mut(&owner);
        let Vault {
            policy,
            one_time_recipients,
            ..
        } = vault;
        let policy = policy
            .as_ref()
            .unwrap_or_else(|| env::panic_str("capkey: no policy set for this vault"));
        require!(
            !policy.allowed_recipients.contains(&recipient),
            "capkey: recipient is already on the approved list"
        );
        require!(
            !one_time_recipients.contains(&recipient),
            "capkey: recipient already has a one-time approval"
        );
        require!(
            policy.allowed_recipients.len() + one_time_recipients.len() < MAX_RECIPIENTS,
            "capkey: too many approved recipients (the limit is 20)"
        );
        one_time_recipients.push(recipient.clone());
        log_event(
            "one_time_approval_added",
            json!({ "owner": owner, "recipient": recipient }),
        );
    }

    /// Take a recipient off the approved list (permanent or one-time), WITHOUT
    /// touching the daily window. Use it to cancel an approval that was never used.
    pub fn remove_recipient(&mut self, recipient: AccountId) {
        let owner = env::predecessor_account_id();
        let vault = self.vault_mut(&owner);
        let mut removed = false;
        if let Some(policy) = vault.policy.as_mut() {
            if let Some(i) = policy
                .allowed_recipients
                .iter()
                .position(|r| *r == recipient)
            {
                policy.allowed_recipients.remove(i);
                removed = true;
            }
        }
        if let Some(i) = vault
            .one_time_recipients
            .iter()
            .position(|r| *r == recipient)
        {
            vault.one_time_recipients.remove(i);
            removed = true;
        }
        require!(removed, "capkey: recipient is not on the approved list");
        log_event(
            "recipient_removed",
            json!({ "owner": owner, "recipient": recipient }),
        );
    }

    /// Set the fee the contract takes on every payment: `bps` basis points (50 = 0.5%)
    /// of the payment amount, rounded down, sent to `treasury` inside the same
    /// `execute_payment` call. It is charged ON TOP of the payment, and it counts toward
    /// the per-transaction cap, the daily limit and the balance check, so the limits
    /// stay hard ceilings on what leaves the vault. The treasury does not need to be on
    /// the approved list. The most allowed is 200 bps (2%). `bps` of 0 turns the fee
    /// off. Does not touch the daily window or the policy.
    pub fn set_fee(&mut self, bps: u16, treasury: AccountId) {
        let owner = env::predecessor_account_id();
        require!(
            bps <= MAX_FEE_BPS,
            "capkey: fee is over the limit of 200 basis points (2%)"
        );
        require!(
            treasury != env::current_account_id(),
            "capkey: the fee treasury cannot be the vault contract itself"
        );
        let vault = self.vault_mut(&owner);
        vault.fee = if bps == 0 {
            None
        } else {
            Some(Fee {
                bps,
                treasury: treasury.clone(),
            })
        };
        log_event(
            "fee_set",
            json!({ "owner": owner, "bps": bps, "treasury": treasury }),
        );
    }

    /// Kill switch: the agent can no longer spend, and any unused one-time approvals
    /// are cancelled. Funds stay yours to withdraw.
    pub fn revoke_agent(&mut self) {
        let owner = env::predecessor_account_id();
        let vault = self.vault_mut(&owner);
        vault.revoked = true;
        vault.one_time_recipients.clear();
        let agent = vault.agent.clone();
        log_event("agent_revoked", json!({ "owner": owner, "agent": agent }));
    }

    /// Swap in a new agent account and switch spending back on.
    pub fn rotate_agent(&mut self, new_agent: AccountId) {
        let owner = env::predecessor_account_id();
        require!(
            new_agent != owner,
            "capkey: the agent must be a different account than the owner"
        );
        let vault = self.vault_mut(&owner);
        vault.agent = new_agent.clone();
        vault.revoked = false;
        log_event(
            "agent_rotated",
            json!({ "owner": owner, "agent": new_agent }),
        );
    }

    /// Take NEAR back out of your vault. Works any time, including after a revoke.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let owner = env::predecessor_account_id();
        let vault = self.vault_mut(&owner);
        require!(amount.0 > 0, "capkey: amount must be above zero");
        require!(
            amount.0 <= vault.balance,
            "capkey: amount is more than the vault balance"
        );
        vault.balance -= amount.0;
        let window_start = vault.window_start;
        log_event(
            "withdrawn",
            json!({ "owner": owner, "amount": amount.0.to_string() }),
        );
        Promise::new(owner.clone())
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_transfer_resolved(owner, amount, false, U64(window_start)),
            )
    }

    /// Take wNEAR back out of your vault. Works any time, including after a revoke.
    /// You must be registered on the token contract (you are, if you deposited from
    /// this account). If the transfer fails, the amount goes back on your vault balance.
    pub fn withdraw_token(&mut self, amount: U128) -> Promise {
        let owner = env::predecessor_account_id();
        let vault = self.vault_mut(&owner);
        require!(amount.0 > 0, "capkey: amount must be above zero");
        require!(
            amount.0 <= vault.token.balance,
            "capkey: amount is more than the vault token balance"
        );
        vault.token.balance -= amount.0;
        log_event(
            "token_withdrawn",
            json!({ "owner": owner, "token": WNEAR_TOKEN, "amount": amount.0.to_string() }),
        );
        ft_transfer(owner.clone(), amount.0).then(
            Self::ext(env::current_account_id())
                .with_static_gas(FT_CALLBACK_GAS)
                .on_ft_withdraw_resolved(owner, amount),
        )
    }

    // ---------------------------------------------------------------- agent

    /// Called by the agent account: pay `amount` from `owner`'s vault to `recipient`,
    /// but only if every rule in the policy allows it. Otherwise this panics and
    /// nothing moves. If the owner set a fee, the fee is sent to the treasury in the
    /// same call, on top of `amount`, and counts toward the cap, the daily limit and the
    /// balance check.
    pub fn execute_payment(
        &mut self,
        owner: AccountId,
        recipient: AccountId,
        amount: U128,
    ) -> Promise {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let vault = self.vault_mut(&owner);

        require!(
            caller == vault.agent,
            "capkey: caller is not the agent for this vault"
        );
        require!(!vault.revoked, "capkey: agent has been revoked");
        let policy = vault
            .policy
            .clone()
            .unwrap_or_else(|| env::panic_str("capkey: no policy set for this vault"));
        require!(now < policy.expires_at, "capkey: policy has expired");
        require!(amount.0 > 0, "capkey: amount must be above zero");
        let on_permanent_list = policy.allowed_recipients.contains(&recipient);
        let one_time_slot = vault
            .one_time_recipients
            .iter()
            .position(|r| *r == recipient);
        require!(
            on_permanent_list || one_time_slot.is_some(),
            "capkey: recipient is not on the approved list"
        );

        // The fee (zero when none is set) is charged on top of the amount. Everything
        // that leaves the vault, fee included, is held to the cap, the daily limit and
        // the balance.
        let fee_config = vault.fee.clone();
        let fee = match &fee_config {
            Some(f) => {
                amount
                    .0
                    .checked_mul(f.bps as u128)
                    .unwrap_or_else(|| env::panic_str("capkey: amount is too large"))
                    / BPS_DENOMINATOR
            }
            None => 0,
        };
        let total = amount
            .0
            .checked_add(fee)
            .unwrap_or_else(|| env::panic_str("capkey: amount is too large"));
        require!(
            total <= policy.per_tx_cap,
            "capkey: amount is over the per-transaction cap"
        );

        // The daily window starts at the first payment and lasts 24 hours.
        if vault.spent_in_window > 0 && now >= vault.window_start + DAY_NS {
            vault.spent_in_window = 0;
        }
        if vault.spent_in_window == 0 {
            vault.window_start = now;
        }
        require!(
            vault.spent_in_window + total <= policy.daily_limit,
            "capkey: payment would go over the daily limit"
        );
        require!(total <= vault.balance, "capkey: vault balance is too low");

        // Update the books first, then send the money. A one-time approval is used up
        // here, once every rule has passed.
        vault.balance -= total;
        vault.spent_in_window += total;
        vault.fees_paid += fee;
        let window_start = vault.window_start;
        let used_one_time_approval = match one_time_slot {
            Some(i) if !on_permanent_list => {
                vault.one_time_recipients.remove(i);
                true
            }
            _ => false,
        };

        log_event(
            "payment_executed",
            json!({
                "owner": owner,
                "agent": caller,
                "recipient": recipient,
                "amount": amount.0.to_string(),
                "fee": fee.to_string(),
                "one_time_approval_used": used_one_time_approval,
            }),
        );

        let payment = Promise::new(recipient).transfer(NearToken::from_yoctonear(amount.0));
        match fee_config {
            // No fee: one transfer, exactly as before.
            None => payment.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_transfer_resolved(owner, amount, true, U64(window_start)),
            ),
            // Fee: the payment and the fee go out together, and one callback checks both.
            Some(f) => {
                if fee == 0 {
                    // The fee rounded down to nothing, so there is nothing to send.
                    return payment.then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(CALLBACK_GAS)
                            .on_transfer_resolved(owner, amount, true, U64(window_start)),
                    );
                }
                let fee_transfer =
                    Promise::new(f.treasury).transfer(NearToken::from_yoctonear(fee));
                payment.and(fee_transfer).then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_payment_with_fee_resolved(owner, amount, U128(fee), U64(window_start)),
                )
            }
        }
    }

    /// The wNEAR version of `execute_payment`, called by the agent account: pay `amount`
    /// wNEAR from `owner`'s vault to `recipient`, but only if every rule allows it.
    /// Otherwise this panics and nothing moves.
    ///
    /// The rules are the same as for NEAR: caller is the agent, not revoked, the
    /// recipient is on the approved list (a one-time approval is used up here too), the
    /// policy has not expired, and the amount fits the cap, the daily limit and the
    /// balance. The difference is that the cap, daily limit, window and balance are the
    /// wNEAR ones (`set_token_policy`), separate from the NEAR ones. The fee works the
    /// same way: `fee_bps` of the amount, in wNEAR, on top of the payment, to the same
    /// treasury, counted toward the wNEAR cap, limit and balance.
    ///
    /// The recipient (and the treasury, if there is a fee) must be registered on
    /// `wrap.testnet`. If a transfer fails, that amount goes back on the vault.
    /// Give the agent about 100 Tgas for this call.
    pub fn execute_ft_payment(
        &mut self,
        owner: AccountId,
        recipient: AccountId,
        amount: U128,
    ) -> Promise {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let vault = self.vault_mut(&owner);

        require!(
            caller == vault.agent,
            "capkey: caller is not the agent for this vault"
        );
        require!(!vault.revoked, "capkey: agent has been revoked");
        // The approved list and the expiry come from the NEAR policy.
        let policy = vault
            .policy
            .clone()
            .unwrap_or_else(|| env::panic_str("capkey: no policy set for this vault"));
        let token_policy = vault
            .token
            .policy
            .clone()
            .unwrap_or_else(|| env::panic_str("capkey: no token policy set for this vault"));
        require!(now < policy.expires_at, "capkey: policy has expired");
        require!(amount.0 > 0, "capkey: amount must be above zero");
        let on_permanent_list = policy.allowed_recipients.contains(&recipient);
        let one_time_slot = vault
            .one_time_recipients
            .iter()
            .position(|r| *r == recipient);
        require!(
            on_permanent_list || one_time_slot.is_some(),
            "capkey: recipient is not on the approved list"
        );

        // Same fee as for NEAR payments, in wNEAR, on top of the amount.
        let fee_config = vault.fee.clone();
        let fee = fee_on(amount.0, &fee_config);
        let total = amount
            .0
            .checked_add(fee)
            .unwrap_or_else(|| env::panic_str("capkey: amount is too large"));
        require!(
            total <= token_policy.per_tx_cap,
            "capkey: amount is over the per-transaction cap"
        );

        // The wNEAR daily window starts at the first wNEAR payment and lasts 24 hours.
        if vault.token.spent_in_window > 0 && now >= vault.token.window_start + DAY_NS {
            vault.token.spent_in_window = 0;
        }
        if vault.token.spent_in_window == 0 {
            vault.token.window_start = now;
        }
        require!(
            vault.token.spent_in_window + total <= token_policy.daily_limit,
            "capkey: payment would go over the daily limit"
        );
        require!(
            total <= vault.token.balance,
            "capkey: vault token balance is too low"
        );

        // Update the books first, then send the tokens. A one-time approval is used up
        // here, once every rule has passed.
        vault.token.balance -= total;
        vault.token.spent_in_window += total;
        vault.token.fees_paid += fee;
        let window_start = vault.token.window_start;
        let used_one_time_approval = match one_time_slot {
            Some(i) if !on_permanent_list => {
                vault.one_time_recipients.remove(i);
                true
            }
            _ => false,
        };

        log_event(
            "ft_payment_executed",
            json!({
                "owner": owner,
                "agent": caller,
                "token": WNEAR_TOKEN,
                "recipient": recipient,
                "amount": amount.0.to_string(),
                "fee": fee.to_string(),
                "one_time_approval_used": used_one_time_approval,
            }),
        );

        let payment = ft_transfer(recipient, amount.0);
        let transfers = match fee_config {
            // The fee is sent only when it did not round down to nothing.
            Some(f) if fee > 0 => payment.and(ft_transfer(f.treasury, fee)),
            _ => payment,
        };
        transfers.then(
            Self::ext(env::current_account_id())
                .with_static_gas(FT_CALLBACK_GAS)
                .on_ft_payment_resolved(owner, amount, U128(fee), U64(window_start)),
        )
    }

    // -------------------------------------------------------------- callback

    /// Runs after a transfer. If the transfer failed (for example the recipient account
    /// does not exist), put the money back in the vault and undo the daily spend.
    #[private]
    pub fn on_transfer_resolved(
        &mut self,
        owner: AccountId,
        amount: U128,
        counts_toward_limit: bool,
        window_start: U64,
    ) -> bool {
        require!(
            env::promise_results_count() == 1,
            "capkey: expected one promise result"
        );
        match env::promise_result_checked(0, 0) {
            Ok(_) => true,
            Err(PromiseError::Failed) => {
                let vault = self.vault_mut(&owner);
                vault.balance += amount.0;
                if counts_toward_limit && vault.window_start == window_start.0 {
                    vault.spent_in_window = vault.spent_in_window.saturating_sub(amount.0);
                }
                log_event(
                    "transfer_failed_refunded",
                    json!({ "owner": owner, "amount": amount.0.to_string() }),
                );
                false
            }
            Err(_) => env::panic_str("capkey: unexpected transfer result"),
        }
    }

    /// Runs after a payment that carried a fee: result 0 is the payment, result 1 is the
    /// fee. Each transfer that failed (for example the recipient or the treasury account
    /// does not exist) goes back to the vault, and its daily spend is undone. Returns
    /// whether the payment itself went through.
    #[private]
    pub fn on_payment_with_fee_resolved(
        &mut self,
        owner: AccountId,
        amount: U128,
        fee: U128,
        window_start: U64,
    ) -> bool {
        require!(
            env::promise_results_count() == 2,
            "capkey: expected two promise results"
        );
        let payment_failed = transfer_failed(0);
        let fee_failed = transfer_failed(1);
        if payment_failed || fee_failed {
            let vault = self.vault_mut(&owner);
            let same_window = vault.window_start == window_start.0;
            if payment_failed {
                vault.balance += amount.0;
                if same_window {
                    vault.spent_in_window = vault.spent_in_window.saturating_sub(amount.0);
                }
                log_event(
                    "transfer_failed_refunded",
                    json!({ "owner": owner, "amount": amount.0.to_string() }),
                );
            }
            if fee_failed {
                vault.balance += fee.0;
                vault.fees_paid = vault.fees_paid.saturating_sub(fee.0);
                if same_window {
                    vault.spent_in_window = vault.spent_in_window.saturating_sub(fee.0);
                }
                log_event(
                    "fee_transfer_failed_refunded",
                    json!({ "owner": owner, "fee": fee.0.to_string() }),
                );
            }
        }
        !payment_failed
    }

    /// Runs after a wNEAR payment: result 0 is the payment and, when there was a fee,
    /// result 1 is the fee. Each transfer that failed (for example the recipient or the
    /// treasury is not registered on the token contract) goes back to the vault's wNEAR
    /// balance, and its daily spend is undone. Returns whether the payment itself went
    /// through.
    #[private]
    pub fn on_ft_payment_resolved(
        &mut self,
        owner: AccountId,
        amount: U128,
        fee: U128,
        window_start: U64,
    ) -> bool {
        let has_fee = fee.0 > 0;
        require!(
            env::promise_results_count() == if has_fee { 2 } else { 1 },
            "capkey: unexpected number of promise results"
        );
        let payment_failed = ft_transfer_failed(0);
        let fee_failed = has_fee && ft_transfer_failed(1);
        if payment_failed || fee_failed {
            let vault = self.vault_mut(&owner);
            let same_window = vault.token.window_start == window_start.0;
            if payment_failed {
                vault.token.balance += amount.0;
                if same_window {
                    vault.token.spent_in_window =
                        vault.token.spent_in_window.saturating_sub(amount.0);
                }
                log_event(
                    "ft_transfer_failed_refunded",
                    json!({ "owner": owner, "token": WNEAR_TOKEN, "amount": amount.0.to_string() }),
                );
            }
            if fee_failed {
                vault.token.balance += fee.0;
                vault.token.fees_paid = vault.token.fees_paid.saturating_sub(fee.0);
                if same_window {
                    vault.token.spent_in_window = vault.token.spent_in_window.saturating_sub(fee.0);
                }
                log_event(
                    "ft_fee_transfer_failed_refunded",
                    json!({ "owner": owner, "token": WNEAR_TOKEN, "fee": fee.0.to_string() }),
                );
            }
        }
        !payment_failed
    }

    /// Runs after `withdraw_token`. If the transfer failed, the amount goes back on the
    /// vault's wNEAR balance.
    #[private]
    pub fn on_ft_withdraw_resolved(&mut self, owner: AccountId, amount: U128) -> bool {
        require!(
            env::promise_results_count() == 1,
            "capkey: expected one promise result"
        );
        if ft_transfer_failed(0) {
            let vault = self.vault_mut(&owner);
            vault.token.balance += amount.0;
            log_event(
                "token_withdraw_failed_refunded",
                json!({ "owner": owner, "token": WNEAR_TOKEN, "amount": amount.0.to_string() }),
            );
            return false;
        }
        true
    }

    // ----------------------------------------------------------------- views

    pub fn get_vault(&self, owner: AccountId) -> Option<VaultView> {
        let vault = self.vaults.get(&owner)?;
        let now = env::block_timestamp();
        let policy_view = vault.policy.as_ref().map(|p| PolicyView {
            per_tx_cap: U128(p.per_tx_cap),
            daily_limit: U128(p.daily_limit),
            allowed_recipients: p.allowed_recipients.clone(),
            expires_at: U64(p.expires_at),
        });
        let remaining = match &vault.policy {
            None => 0,
            Some(p) => {
                let window_open = vault.spent_in_window > 0 && now < vault.window_start + DAY_NS;
                let spent = if window_open {
                    vault.spent_in_window
                } else {
                    0
                };
                p.daily_limit.saturating_sub(spent)
            }
        };
        let token = &vault.token;
        let token_remaining = match &token.policy {
            None => 0,
            Some(p) => {
                let window_open = token.spent_in_window > 0 && now < token.window_start + DAY_NS;
                let spent = if window_open {
                    token.spent_in_window
                } else {
                    0
                };
                p.daily_limit.saturating_sub(spent)
            }
        };
        let token_view = TokenView {
            token_id: wnear(),
            balance: U128(token.balance),
            policy: token.policy.as_ref().map(|p| TokenPolicyView {
                per_tx_cap: U128(p.per_tx_cap),
                daily_limit: U128(p.daily_limit),
            }),
            spent_in_window: U128(token.spent_in_window),
            window_start: U64(token.window_start),
            remaining_today: U128(token_remaining),
            total_fees_paid: U128(token.fees_paid),
        };
        Some(VaultView {
            agent: vault.agent.clone(),
            balance: U128(vault.balance),
            revoked: vault.revoked,
            policy: policy_view,
            one_time_recipients: vault.one_time_recipients.clone(),
            fee_bps: vault.fee.as_ref().map_or(0, |f| f.bps),
            fee_treasury: vault.fee.as_ref().map(|f| f.treasury.clone()),
            total_fees_paid: U128(vault.fees_paid),
            spent_in_window: U128(vault.spent_in_window),
            window_start: U64(vault.window_start),
            remaining_today: U128(remaining),
            token: token_view,
        })
    }

    // --------------------------------------------------------------- helpers

    fn vault_mut(&mut self, owner: &AccountId) -> &mut Vault {
        self.vaults
            .get_mut(owner)
            .unwrap_or_else(|| env::panic_str("capkey: no vault for this owner"))
    }
}

/// True if the transfer behind promise result `index` failed.
fn transfer_failed(index: u64) -> bool {
    match env::promise_result_checked(index, 0) {
        Ok(_) => false,
        Err(PromiseError::Failed) => true,
        Err(_) => env::panic_str("capkey: unexpected transfer result"),
    }
}

/// True if the transfer behind promise result `index` failed. A transfer that
/// succeeded and returned data of any length still counts as a success.
fn ft_transfer_failed(index: u64) -> bool {
    matches!(
        env::promise_result_checked(index, 0),
        Err(PromiseError::Failed)
    )
}

/// The wNEAR token contract.
fn wnear() -> AccountId {
    WNEAR_TOKEN
        .parse()
        .unwrap_or_else(|_| env::panic_str("capkey: bad token account"))
}

/// The fee on `amount` for this fee setting: `bps` basis points, rounded down.
fn fee_on(amount: u128, fee: &Option<Fee>) -> u128 {
    match fee {
        Some(f) => {
            amount
                .checked_mul(f.bps as u128)
                .unwrap_or_else(|| env::panic_str("capkey: amount is too large"))
                / BPS_DENOMINATOR
        }
        None => 0,
    }
}

/// Send `amount` wNEAR from this contract to `receiver` (NEP-141 `ft_transfer`, which
/// needs exactly 1 yoctoNEAR attached).
fn ft_transfer(receiver: AccountId, amount: u128) -> Promise {
    Promise::new(wnear()).function_call(
        "ft_transfer".to_string(),
        json!({ "receiver_id": receiver, "amount": amount.to_string() })
            .to_string()
            .into_bytes(),
        NearToken::from_yoctonear(1),
        FT_TRANSFER_GAS,
    )
}

fn log_event(event: &str, data: Value) {
    let line = json!({
        "standard": "capkey",
        "version": "1.0.0",
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{line}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;
    use near_sdk::PromiseResult;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    /// An arbitrary "now" in nanoseconds.
    const T0: u64 = 1_000_000_000_000_000_000;

    fn owner() -> AccountId {
        accounts(0)
    }
    fn agent() -> AccountId {
        accounts(1)
    }
    /// An approved recipient.
    fn shop() -> AccountId {
        accounts(2)
    }
    /// An account that is NOT on the approved list.
    fn stranger() -> AccountId {
        accounts(3)
    }
    fn contract() -> AccountId {
        accounts(4)
    }

    fn ctx(caller: AccountId, deposit: u128, now: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(contract())
            .predecessor_account_id(caller)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(now)
            .build());
    }

    /// Vault with 10 NEAR, a cap of 1 NEAR per payment, 3 NEAR per day,
    /// `shop()` as the only approved recipient, expiring in 7 days.
    fn setup() -> Capkey {
        ctx(owner(), 0, T0);
        let mut c = Capkey::new();
        c.create_vault(agent());
        ctx(owner(), 10 * NEAR, T0);
        c.fund_vault();
        ctx(owner(), 0, T0);
        c.set_policy(
            U128(NEAR),
            U128(3 * NEAR),
            vec![shop()],
            U64(T0 + 7 * DAY_NS),
        );
        c
    }

    fn pay(c: &mut Capkey, who: AccountId, to: AccountId, amount: u128, now: u64) {
        ctx(who, 0, now);
        let _ = c.execute_payment(owner(), to, U128(amount));
    }

    fn view(c: &Capkey) -> VaultView {
        c.get_vault(owner()).unwrap()
    }

    // 1. create vault
    #[test]
    fn create_vault_stores_the_agent() {
        ctx(owner(), 0, T0);
        let mut c = Capkey::new();
        c.create_vault(agent());
        let v = view(&c);
        assert_eq!(v.agent, agent());
        assert_eq!(v.balance.0, 0);
        assert!(!v.revoked);
        assert!(v.policy.is_none());
    }

    #[test]
    #[should_panic(expected = "you already have a vault")]
    fn create_vault_twice_is_blocked() {
        let mut c = setup();
        ctx(owner(), 0, T0);
        c.create_vault(agent());
    }

    // 2. fund vault
    #[test]
    fn fund_vault_adds_the_deposit() {
        let c = setup();
        assert_eq!(view(&c).balance.0, 10 * NEAR);
    }

    // 3. in-policy payment goes through
    #[test]
    fn payment_inside_the_policy_succeeds() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0);
        let v = view(&c);
        assert_eq!(v.balance.0, 9 * NEAR);
        assert_eq!(v.spent_in_window.0, NEAR);
        assert_eq!(v.remaining_today.0, 2 * NEAR);
    }

    // 4. over the per-transaction cap is blocked
    #[test]
    #[should_panic(expected = "over the per-transaction cap")]
    fn payment_over_the_cap_is_blocked() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), 2 * NEAR, T0);
    }

    // 5. recipient not on the approved list is blocked
    #[test]
    #[should_panic(expected = "recipient is not on the approved list")]
    fn payment_to_unapproved_recipient_is_blocked() {
        let mut c = setup();
        pay(&mut c, agent(), stranger(), NEAR, T0);
    }

    // 6. daily limit is blocked
    #[test]
    #[should_panic(expected = "over the daily limit")]
    fn payment_over_the_daily_limit_is_blocked() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0);
        pay(&mut c, agent(), shop(), NEAR, T0 + 1);
        pay(&mut c, agent(), shop(), NEAR, T0 + 2);
        pay(&mut c, agent(), shop(), NEAR, T0 + 3);
    }

    #[test]
    fn daily_limit_resets_after_24_hours() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0);
        pay(&mut c, agent(), shop(), NEAR, T0 + 1);
        pay(&mut c, agent(), shop(), NEAR, T0 + 2);
        pay(&mut c, agent(), shop(), NEAR, T0 + DAY_NS + 10);
        assert_eq!(view(&c).balance.0, 6 * NEAR);
    }

    // 7. revoke is a kill switch
    #[test]
    #[should_panic(expected = "agent has been revoked")]
    fn revoked_agent_cannot_pay() {
        let mut c = setup();
        ctx(owner(), 0, T0);
        c.revoke_agent();
        pay(&mut c, agent(), shop(), NEAR, T0);
    }

    // 8. owner can still withdraw after a revoke
    #[test]
    fn owner_can_withdraw_after_revoke() {
        let mut c = setup();
        ctx(owner(), 0, T0);
        c.revoke_agent();
        let _ = c.withdraw(U128(10 * NEAR));
        assert_eq!(view(&c).balance.0, 0);
        assert!(view(&c).revoked);
    }

    // extra safety checks
    #[test]
    #[should_panic(expected = "caller is not the agent")]
    fn only_the_agent_can_pay() {
        let mut c = setup();
        pay(&mut c, stranger(), shop(), NEAR, T0);
    }

    #[test]
    #[should_panic(expected = "policy has expired")]
    fn expired_policy_blocks_payments() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0 + 8 * DAY_NS);
    }

    #[test]
    #[should_panic(expected = "no policy set")]
    fn payment_without_a_policy_is_blocked() {
        ctx(owner(), 0, T0);
        let mut c = Capkey::new();
        c.create_vault(agent());
        ctx(owner(), 10 * NEAR, T0);
        c.fund_vault();
        pay(&mut c, agent(), shop(), NEAR, T0);
    }

    #[test]
    #[should_panic(expected = "vault balance is too low")]
    fn payment_bigger_than_the_balance_is_blocked() {
        ctx(owner(), 0, T0);
        let mut c = Capkey::new();
        c.create_vault(agent());
        ctx(owner(), NEAR / 2, T0);
        c.fund_vault();
        ctx(owner(), 0, T0);
        c.set_policy(U128(NEAR), U128(3 * NEAR), vec![shop()], U64(T0 + DAY_NS));
        pay(&mut c, agent(), shop(), NEAR, T0);
    }

    #[test]
    #[should_panic(expected = "more than the vault balance")]
    fn withdrawing_more_than_the_balance_is_blocked() {
        let mut c = setup();
        ctx(owner(), 0, T0);
        let _ = c.withdraw(U128(11 * NEAR));
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn only_the_owner_controls_a_vault() {
        let mut c = setup();
        ctx(stranger(), 0, T0);
        c.revoke_agent();
    }

    #[test]
    fn rotate_agent_switches_spending_back_on_for_the_new_agent() {
        let mut c = setup();
        ctx(owner(), 0, T0);
        c.revoke_agent();
        c.rotate_agent(stranger());
        pay(&mut c, stranger(), shop(), NEAR, T0);
        assert_eq!(view(&c).balance.0, 9 * NEAR);
    }

    #[test]
    #[should_panic(expected = "caller is not the agent")]
    fn old_agent_is_blocked_after_rotation() {
        let mut c = setup();
        ctx(owner(), 0, T0);
        c.rotate_agent(stranger());
        pay(&mut c, agent(), shop(), NEAR, T0);
    }

    // a failed transfer puts the money back
    #[test]
    #[allow(deprecated)]
    fn failed_transfer_is_refunded_to_the_vault() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0);
        assert_eq!(view(&c).balance.0, 9 * NEAR);

        near_sdk::test_utils::testing_env_with_promise_results(
            VMContextBuilder::new()
                .current_account_id(contract())
                .predecessor_account_id(contract())
                .block_timestamp(T0)
                .build(),
            PromiseResult::Failed,
        );
        let ok = c.on_transfer_resolved(owner(), U128(NEAR), true, U64(T0));
        assert!(!ok);
        let v = view(&c);
        assert_eq!(v.balance.0, 10 * NEAR);
        assert_eq!(v.spent_in_window.0, 0);
    }

    #[test]
    #[allow(deprecated)]
    fn successful_transfer_keeps_the_vault_as_it_is() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0);

        near_sdk::test_utils::testing_env_with_promise_results(
            VMContextBuilder::new()
                .current_account_id(contract())
                .predecessor_account_id(contract())
                .block_timestamp(T0)
                .build(),
            PromiseResult::Successful(vec![]),
        );
        let ok = c.on_transfer_resolved(owner(), U128(NEAR), true, U64(T0));
        assert!(ok);
        let v = view(&c);
        assert_eq!(v.balance.0, 9 * NEAR);
        assert_eq!(v.spent_in_window.0, NEAR);
    }

    #[test]
    #[should_panic(expected = "agent must be a different account")]
    fn agent_cannot_be_the_owner() {
        ctx(owner(), 0, T0);
        let mut c = Capkey::new();
        c.create_vault(owner());
    }

    // ------------------------------------------- changing the approved list

    /// A valid account name for the Nth extra recipient.
    fn recipient_n(n: usize) -> AccountId {
        format!("recipient{n}.testnet").parse().unwrap()
    }

    /// Same as `setup()` but with `n` approved recipients (recipient0 ... recipientN-1).
    /// Leaves the context set to the owner.
    fn setup_with_recipients(n: usize) -> Capkey {
        ctx(owner(), 0, T0);
        let mut c = Capkey::new();
        c.create_vault(agent());
        ctx(owner(), 10 * NEAR, T0);
        c.fund_vault();
        ctx(owner(), 0, T0);
        c.set_policy(
            U128(NEAR),
            U128(3 * NEAR),
            (0..n).map(recipient_n).collect(),
            U64(T0 + 7 * DAY_NS),
        );
        c
    }

    fn as_owner(now: u64) {
        ctx(owner(), 0, now);
    }

    // add_recipient

    #[test]
    fn add_recipient_lets_the_agent_pay_the_new_recipient() {
        let mut c = setup();
        as_owner(T0);
        c.add_recipient(stranger());
        assert_eq!(
            view(&c).policy.unwrap().allowed_recipients,
            vec![shop(), stranger()]
        );
        pay(&mut c, agent(), stranger(), NEAR, T0);
        assert_eq!(view(&c).balance.0, 9 * NEAR);
    }

    #[test]
    fn add_recipient_keeps_the_daily_window_and_what_was_spent() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0);
        let before = view(&c);
        as_owner(T0 + 1_000);
        c.add_recipient(stranger());
        let after = view(&c);
        assert_eq!(after.spent_in_window.0, NEAR);
        assert_eq!(after.window_start.0, before.window_start.0);
        assert_eq!(after.remaining_today.0, 2 * NEAR);
    }

    #[test]
    #[should_panic(expected = "over the daily limit")]
    fn daily_limit_still_applies_after_add_recipient() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0);
        pay(&mut c, agent(), shop(), NEAR, T0 + 1);
        as_owner(T0 + 2);
        c.add_recipient(stranger());
        // 3 NEAR in total is the daily limit, so this one is fine ...
        pay(&mut c, agent(), stranger(), NEAR, T0 + 3);
        // ... and this one is the fourth NEAR.
        pay(&mut c, agent(), stranger(), NEAR, T0 + 4);
    }

    // set_policy is the old way and still restarts the window: this is the reason
    // add_recipient exists.
    #[test]
    fn set_policy_still_restarts_the_daily_window() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0);
        as_owner(T0 + 1);
        c.set_policy(
            U128(NEAR),
            U128(3 * NEAR),
            vec![shop(), stranger()],
            U64(T0 + 7 * DAY_NS),
        );
        assert_eq!(view(&c).spent_in_window.0, 0);
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn add_recipient_is_owner_only() {
        let mut c = setup();
        ctx(stranger(), 0, T0);
        c.add_recipient(stranger());
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn the_agent_cannot_add_recipients() {
        let mut c = setup();
        ctx(agent(), 0, T0);
        c.add_recipient(stranger());
    }

    #[test]
    #[should_panic(expected = "no policy set")]
    fn add_recipient_needs_a_policy() {
        ctx(owner(), 0, T0);
        let mut c = Capkey::new();
        c.create_vault(agent());
        c.add_recipient(shop());
    }

    #[test]
    #[should_panic(expected = "already on the approved list")]
    fn add_recipient_twice_is_blocked() {
        let mut c = setup();
        as_owner(T0);
        c.add_recipient(shop());
    }

    #[test]
    fn add_recipient_can_fill_the_list_to_twenty() {
        let mut c = setup_with_recipients(19);
        c.add_recipient(stranger());
        assert_eq!(view(&c).policy.unwrap().allowed_recipients.len(), 20);
    }

    #[test]
    #[should_panic(expected = "limit is 20")]
    fn add_recipient_stops_at_twenty() {
        let mut c = setup_with_recipients(20);
        c.add_recipient(stranger());
    }

    #[test]
    #[should_panic(expected = "limit is 20")]
    fn the_limit_counts_one_time_approvals_too() {
        let mut c = setup_with_recipients(19);
        c.approve_once(recipient_n(50));
        c.add_recipient(stranger());
    }

    #[test]
    #[should_panic(expected = "limit is 20")]
    fn approve_once_stops_at_twenty() {
        let mut c = setup_with_recipients(20);
        c.approve_once(stranger());
    }

    #[test]
    fn removing_a_recipient_frees_a_slot() {
        let mut c = setup_with_recipients(20);
        c.remove_recipient(recipient_n(0));
        c.add_recipient(stranger());
        assert_eq!(view(&c).policy.unwrap().allowed_recipients.len(), 20);
    }

    #[test]
    fn add_recipient_promotes_a_one_time_approval() {
        let mut c = setup();
        as_owner(T0);
        c.approve_once(stranger());
        c.add_recipient(stranger());
        let v = view(&c);
        assert!(v.one_time_recipients.is_empty());
        assert_eq!(
            v.policy.unwrap().allowed_recipients,
            vec![shop(), stranger()]
        );
        // it is permanent now, so it can be paid more than once
        pay(&mut c, agent(), stranger(), NEAR, T0);
        pay(&mut c, agent(), stranger(), NEAR, T0 + 1);
        assert_eq!(view(&c).balance.0, 8 * NEAR);
    }

    // approve_once (single-use approval)

    #[test]
    fn a_one_time_approval_pays_once_and_is_then_used_up() {
        let mut c = setup();
        as_owner(T0);
        c.approve_once(stranger());
        assert_eq!(view(&c).one_time_recipients, vec![stranger()]);

        pay(&mut c, agent(), stranger(), NEAR, T0);
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains("\"one_time_approval_used\":true")));

        let v = view(&c);
        assert!(v.one_time_recipients.is_empty());
        assert_eq!(v.balance.0, 9 * NEAR);
        // the permanent list is untouched
        assert_eq!(v.policy.unwrap().allowed_recipients, vec![shop()]);
    }

    #[test]
    #[should_panic(expected = "recipient is not on the approved list")]
    fn a_one_time_approval_cannot_be_used_twice() {
        let mut c = setup();
        as_owner(T0);
        c.approve_once(stranger());
        pay(&mut c, agent(), stranger(), NEAR, T0);
        pay(&mut c, agent(), stranger(), NEAR, T0 + 1);
    }

    #[test]
    fn approve_once_keeps_the_daily_window_and_the_limit_still_applies() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0);
        let before = view(&c);
        as_owner(T0 + 1_000);
        c.approve_once(stranger());
        let after = view(&c);
        assert_eq!(after.spent_in_window.0, NEAR);
        assert_eq!(after.window_start.0, before.window_start.0);

        // the payment to the one-time recipient counts toward the same daily limit
        pay(&mut c, agent(), stranger(), NEAR, T0 + 2_000);
        assert_eq!(view(&c).spent_in_window.0, 2 * NEAR);
    }

    #[test]
    fn a_blocked_payment_does_not_use_up_the_approval() {
        let mut c = setup();
        as_owner(T0);
        c.approve_once(stranger());

        // 2 NEAR is over the per-transaction cap, so the contract refuses it
        let result = catch_unwind(AssertUnwindSafe(|| {
            pay(&mut c, agent(), stranger(), 2 * NEAR, T0);
        }));
        assert!(result.is_err());
        assert_eq!(view(&c).one_time_recipients, vec![stranger()]);

        // the approval still works for a payment that follows the rules
        pay(&mut c, agent(), stranger(), NEAR, T0);
        assert!(view(&c).one_time_recipients.is_empty());
    }

    #[test]
    #[should_panic(expected = "already on the approved list")]
    fn approve_once_for_a_permanent_recipient_is_blocked() {
        let mut c = setup();
        as_owner(T0);
        c.approve_once(shop());
    }

    #[test]
    #[should_panic(expected = "already has a one-time approval")]
    fn approve_once_twice_is_blocked() {
        let mut c = setup();
        as_owner(T0);
        c.approve_once(stranger());
        c.approve_once(stranger());
    }

    #[test]
    #[should_panic(expected = "no policy set")]
    fn approve_once_needs_a_policy() {
        ctx(owner(), 0, T0);
        let mut c = Capkey::new();
        c.create_vault(agent());
        c.approve_once(shop());
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn approve_once_is_owner_only() {
        let mut c = setup();
        ctx(stranger(), 0, T0);
        c.approve_once(stranger());
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn the_agent_cannot_approve_recipients() {
        let mut c = setup();
        ctx(agent(), 0, T0);
        c.approve_once(stranger());
    }

    #[test]
    fn set_policy_clears_one_time_approvals() {
        let mut c = setup();
        as_owner(T0);
        c.approve_once(stranger());
        c.set_policy(
            U128(NEAR),
            U128(3 * NEAR),
            vec![shop()],
            U64(T0 + 7 * DAY_NS),
        );
        assert!(view(&c).one_time_recipients.is_empty());
    }

    #[test]
    fn revoke_agent_cancels_one_time_approvals() {
        let mut c = setup();
        as_owner(T0);
        c.approve_once(stranger());
        c.revoke_agent();
        assert!(view(&c).one_time_recipients.is_empty());
    }

    // a bounced transfer returns the money but not the approval
    #[test]
    #[allow(deprecated)]
    fn a_bounced_transfer_returns_the_money_but_not_the_approval() {
        let mut c = setup();
        as_owner(T0);
        c.approve_once(stranger());
        pay(&mut c, agent(), stranger(), NEAR, T0);

        near_sdk::test_utils::testing_env_with_promise_results(
            VMContextBuilder::new()
                .current_account_id(contract())
                .predecessor_account_id(contract())
                .block_timestamp(T0)
                .build(),
            PromiseResult::Failed,
        );
        let ok = c.on_transfer_resolved(owner(), U128(NEAR), true, U64(T0));
        assert!(!ok);
        let v = view(&c);
        assert_eq!(v.balance.0, 10 * NEAR);
        assert_eq!(v.spent_in_window.0, 0);
        assert!(v.one_time_recipients.is_empty());
    }

    // remove_recipient

    #[test]
    fn remove_recipient_takes_a_permanent_recipient_off_the_list() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0);
        as_owner(T0 + 5);
        c.add_recipient(stranger());
        c.remove_recipient(stranger());

        let v = view(&c);
        assert_eq!(v.policy.unwrap().allowed_recipients, vec![shop()]);
        // the daily window was not touched
        assert_eq!(v.spent_in_window.0, NEAR);

        let blocked = catch_unwind(AssertUnwindSafe(|| {
            pay(&mut c, agent(), stranger(), NEAR, T0 + 6);
        }));
        assert!(blocked.is_err());
    }

    #[test]
    fn remove_recipient_cancels_an_unused_one_time_approval() {
        let mut c = setup();
        as_owner(T0);
        c.approve_once(stranger());
        c.remove_recipient(stranger());
        assert!(view(&c).one_time_recipients.is_empty());
    }

    #[test]
    #[should_panic(expected = "recipient is not on the approved list")]
    fn removing_an_unknown_recipient_is_blocked() {
        let mut c = setup();
        as_owner(T0);
        c.remove_recipient(stranger());
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn the_agent_cannot_remove_recipients() {
        let mut c = setup();
        ctx(agent(), 0, T0);
        c.remove_recipient(shop());
    }

    // ------------------------------------------------------------------ fee

    /// The account that receives the fee.
    fn treasury() -> AccountId {
        "treasury.testnet".parse().unwrap()
    }

    /// Same as `setup()` with a fee of `bps` basis points going to `treasury()`.
    /// Leaves the context set to the owner.
    fn setup_with_fee(bps: u16) -> Capkey {
        let mut c = setup();
        as_owner(T0);
        c.set_fee(bps, treasury());
        c
    }

    /// Run the callback of a payment that carried a fee, with these two transfer results
    /// (payment first, fee second).
    fn resolve_with_fee(
        c: &mut Capkey,
        payment: PromiseResult,
        fee_result: PromiseResult,
        amount: u128,
        fee: u128,
    ) -> bool {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(contract())
                .predecessor_account_id(contract())
                .block_timestamp(T0)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![payment, fee_result]
        );
        c.on_payment_with_fee_resolved(owner(), U128(amount), U128(fee), U64(T0))
    }

    // a vault with no fee behaves exactly as before

    #[test]
    fn a_new_vault_has_no_fee() {
        let c = setup();
        let v = view(&c);
        assert_eq!(v.fee_bps, 0);
        assert!(v.fee_treasury.is_none());
        assert_eq!(v.total_fees_paid.0, 0);
    }

    #[test]
    fn a_payment_without_a_fee_pays_no_fee() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0);
        let v = view(&c);
        assert_eq!(v.balance.0, 9 * NEAR);
        assert_eq!(v.spent_in_window.0, NEAR);
        assert_eq!(v.total_fees_paid.0, 0);
    }

    // set_fee

    #[test]
    fn set_fee_shows_up_in_the_vault_view() {
        let c = setup_with_fee(50);
        let v = view(&c);
        assert_eq!(v.fee_bps, 50);
        assert_eq!(v.fee_treasury, Some(treasury()));
        assert_eq!(v.total_fees_paid.0, 0);
    }

    #[test]
    fn set_fee_allows_exactly_two_percent() {
        let c = setup_with_fee(200);
        assert_eq!(view(&c).fee_bps, 200);
    }

    #[test]
    #[should_panic(expected = "over the limit of 200 basis points")]
    fn set_fee_over_two_percent_is_blocked() {
        let _ = setup_with_fee(201);
    }

    #[test]
    fn set_fee_to_zero_turns_the_fee_off() {
        let mut c = setup_with_fee(50);
        as_owner(T0);
        c.set_fee(0, treasury());
        let v = view(&c);
        assert_eq!(v.fee_bps, 0);
        assert!(v.fee_treasury.is_none());
        pay(&mut c, agent(), shop(), NEAR, T0);
        assert_eq!(view(&c).balance.0, 9 * NEAR);
    }

    #[test]
    #[should_panic(expected = "treasury cannot be the vault contract itself")]
    fn the_treasury_cannot_be_the_contract() {
        let mut c = setup();
        as_owner(T0);
        c.set_fee(50, contract());
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn set_fee_is_owner_only() {
        let mut c = setup();
        ctx(stranger(), 0, T0);
        c.set_fee(50, treasury());
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn the_agent_cannot_set_the_fee() {
        let mut c = setup();
        ctx(agent(), 0, T0);
        c.set_fee(0, treasury());
    }

    #[test]
    fn set_fee_does_not_touch_the_daily_window() {
        let mut c = setup();
        pay(&mut c, agent(), shop(), NEAR, T0);
        let before = view(&c);
        as_owner(T0 + 1_000);
        c.set_fee(50, treasury());
        let after = view(&c);
        assert_eq!(after.spent_in_window.0, NEAR);
        assert_eq!(after.window_start.0, before.window_start.0);
    }

    #[test]
    fn set_policy_and_revoke_keep_the_fee() {
        let mut c = setup_with_fee(50);
        as_owner(T0);
        c.set_policy(
            U128(NEAR),
            U128(3 * NEAR),
            vec![shop()],
            U64(T0 + 7 * DAY_NS),
        );
        assert_eq!(view(&c).fee_bps, 50);
        c.revoke_agent();
        assert_eq!(view(&c).fee_bps, 50);
    }

    // the fee is taken inside execute_payment

    #[test]
    fn a_payment_with_a_fee_takes_the_fee_on_top() {
        let mut c = setup_with_fee(50);
        let amount = NEAR / 2;
        pay(&mut c, agent(), shop(), amount, T0);

        // 0.5% of 0.5 NEAR is 0.0025 NEAR
        let fee = NEAR / 400;
        let v = view(&c);
        assert_eq!(v.total_fees_paid.0, fee);
        assert_eq!(v.balance.0, 10 * NEAR - amount - fee);
        assert_eq!(v.spent_in_window.0, amount + fee);
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains(&format!("\"fee\":\"{fee}\""))));
    }

    #[test]
    fn the_fee_goes_out_in_the_same_call_as_the_payment() {
        let mut c = setup_with_fee(50);
        pay(&mut c, agent(), shop(), NEAR / 2, T0);

        // one receipt batch: a transfer to the shop and a transfer to the treasury
        let receipts = near_sdk::test_utils::get_created_receipts();
        let text = format!("{receipts:?}");
        assert!(text.contains(shop().as_str()));
        assert!(text.contains(treasury().as_str()));
    }

    #[test]
    fn the_fee_is_rounded_down() {
        let mut c = setup_with_fee(50);
        // 0.5% of 399 yoctoNEAR is 1.995, which rounds down to 1
        pay(&mut c, agent(), shop(), 399, T0);
        assert_eq!(view(&c).total_fees_paid.0, 1);
    }

    #[test]
    fn a_fee_that_rounds_to_nothing_sends_no_fee() {
        let mut c = setup_with_fee(50);
        // 0.5% of 100 yoctoNEAR is 0.5, which rounds down to 0
        pay(&mut c, agent(), shop(), 100, T0);
        let v = view(&c);
        assert_eq!(v.total_fees_paid.0, 0);
        assert_eq!(v.balance.0, 10 * NEAR - 100);
        let text = format!("{:?}", near_sdk::test_utils::get_created_receipts());
        assert!(!text.contains(treasury().as_str()));
    }

    #[test]
    fn the_treasury_does_not_need_to_be_on_the_approved_list() {
        let mut c = setup_with_fee(100);
        assert!(!view(&c)
            .policy
            .unwrap()
            .allowed_recipients
            .contains(&treasury()));
        pay(&mut c, agent(), shop(), NEAR / 2, T0);
        // 1% of 0.5 NEAR
        assert_eq!(view(&c).total_fees_paid.0, NEAR / 200);
    }

    #[test]
    #[should_panic(expected = "over the per-transaction cap")]
    fn the_fee_counts_toward_the_per_transaction_cap() {
        // the cap is 1 NEAR: 1 NEAR plus a fee is more than that
        let mut c = setup_with_fee(50);
        pay(&mut c, agent(), shop(), NEAR, T0);
        pay(&mut c, agent(), shop(), NEAR, T0 + 1);
    }

    #[test]
    fn a_payment_that_fits_under_the_cap_with_its_fee_goes_through() {
        // 0.99 NEAR plus 0.5% (0.00495) is 0.99495, under the 1 NEAR cap
        let mut c = setup_with_fee(50);
        pay(&mut c, agent(), shop(), NEAR / 100 * 99, T0);
        assert_eq!(view(&c).total_fees_paid.0, NEAR / 100 * 99 / 200);
    }

    #[test]
    #[should_panic(expected = "over the daily limit")]
    fn the_fee_counts_toward_the_daily_limit() {
        // The daily limit is 3 NEAR. With a 2% fee, three payments of 0.9 NEAR cost
        // 0.918 NEAR each, 2.754 in total, which leaves 0.246 NEAR for the day.
        let mut c = setup_with_fee(200);
        for i in 0..3 {
            pay(&mut c, agent(), shop(), NEAR / 10 * 9, T0 + i);
        }
        assert_eq!(
            view(&c).spent_in_window.0,
            3 * (NEAR / 10 * 9 + NEAR / 500 * 9)
        );
        assert_eq!(view(&c).remaining_today.0, NEAR / 1000 * 246);
        // 0.245 NEAR alone would fit in the 0.246 left, but 0.245 plus its fee
        // (0.0049 NEAR) does not, so this is refused.
        pay(&mut c, agent(), shop(), NEAR / 1000 * 245, T0 + 3);
    }

    #[test]
    fn a_payment_whose_fee_still_fits_in_the_daily_limit_goes_through() {
        // Same day as above, but 0.24 NEAR plus its 0.0048 fee is 0.2448: it fits.
        let mut c = setup_with_fee(200);
        for i in 0..3 {
            pay(&mut c, agent(), shop(), NEAR / 10 * 9, T0 + i);
        }
        pay(&mut c, agent(), shop(), NEAR / 100 * 24, T0 + 3);
        // 0.246 left, minus 0.24 and 0.0048, leaves 0.0012
        assert_eq!(view(&c).remaining_today.0, NEAR / 10_000 * 12);
    }

    #[test]
    #[should_panic(expected = "vault balance is too low")]
    fn the_fee_counts_toward_the_balance_check() {
        // 1 NEAR in the vault and a 1 NEAR payment: the fee on top does not fit
        ctx(owner(), 0, T0);
        let mut c = Capkey::new();
        c.create_vault(agent());
        ctx(owner(), NEAR, T0);
        c.fund_vault();
        ctx(owner(), 0, T0);
        c.set_policy(
            U128(2 * NEAR),
            U128(3 * NEAR),
            vec![shop()],
            U64(T0 + DAY_NS),
        );
        c.set_fee(50, treasury());
        pay(&mut c, agent(), shop(), NEAR, T0);
    }

    #[test]
    fn a_refused_payment_pays_no_fee() {
        let mut c = setup_with_fee(50);
        let result = catch_unwind(AssertUnwindSafe(|| {
            pay(&mut c, agent(), stranger(), NEAR / 2, T0);
        }));
        assert!(result.is_err());
        let v = view(&c);
        assert_eq!(v.total_fees_paid.0, 0);
        assert_eq!(v.balance.0, 10 * NEAR);
    }

    #[test]
    fn a_one_time_approval_still_works_with_a_fee() {
        let mut c = setup_with_fee(50);
        as_owner(T0);
        c.approve_once(stranger());
        pay(&mut c, agent(), stranger(), NEAR / 2, T0);
        let v = view(&c);
        assert!(v.one_time_recipients.is_empty());
        assert_eq!(v.total_fees_paid.0, NEAR / 2 / 200);
    }

    #[test]
    fn fees_add_up_across_payments() {
        let mut c = setup_with_fee(100);
        pay(&mut c, agent(), shop(), NEAR / 2, T0);
        pay(&mut c, agent(), shop(), NEAR / 2, T0 + 1);
        assert_eq!(view(&c).total_fees_paid.0, 2 * (NEAR / 2 / 100));
    }

    // the callback for a payment with a fee: each transfer that bounces goes back

    // In these four tests a payment of 0.5 NEAR carries a 0.5% fee of 0.0025 NEAR.

    #[test]
    fn both_transfers_succeeding_changes_nothing() {
        let mut c = setup_with_fee(50);
        let amount = NEAR / 2;
        let fee = NEAR / 400;
        pay(&mut c, agent(), shop(), amount, T0);
        let ok = resolve_with_fee(
            &mut c,
            PromiseResult::Successful(vec![]),
            PromiseResult::Successful(vec![]),
            amount,
            fee,
        );
        assert!(ok);
        let v = view(&c);
        assert_eq!(v.balance.0, 10 * NEAR - amount - fee);
        assert_eq!(v.total_fees_paid.0, fee);
        assert_eq!(v.spent_in_window.0, amount + fee);
    }

    #[test]
    fn a_bounced_payment_is_refunded_but_the_fee_stays_paid() {
        let mut c = setup_with_fee(50);
        let amount = NEAR / 2;
        let fee = NEAR / 400;
        pay(&mut c, agent(), shop(), amount, T0);
        let ok = resolve_with_fee(
            &mut c,
            PromiseResult::Failed,
            PromiseResult::Successful(vec![]),
            amount,
            fee,
        );
        assert!(!ok);
        let v = view(&c);
        assert_eq!(v.balance.0, 10 * NEAR - fee);
        assert_eq!(v.total_fees_paid.0, fee);
        assert_eq!(v.spent_in_window.0, fee);
    }

    #[test]
    fn a_bounced_fee_is_refunded_and_the_payment_stays_paid() {
        let mut c = setup_with_fee(50);
        let amount = NEAR / 2;
        let fee = NEAR / 400;
        pay(&mut c, agent(), shop(), amount, T0);
        let ok = resolve_with_fee(
            &mut c,
            PromiseResult::Successful(vec![]),
            PromiseResult::Failed,
            amount,
            fee,
        );
        assert!(ok);
        let v = view(&c);
        assert_eq!(v.balance.0, 10 * NEAR - amount);
        assert_eq!(v.total_fees_paid.0, 0);
        assert_eq!(v.spent_in_window.0, amount);
    }

    #[test]
    fn if_both_bounce_everything_goes_back() {
        let mut c = setup_with_fee(50);
        let amount = NEAR / 2;
        let fee = NEAR / 400;
        pay(&mut c, agent(), shop(), amount, T0);
        let ok = resolve_with_fee(
            &mut c,
            PromiseResult::Failed,
            PromiseResult::Failed,
            amount,
            fee,
        );
        assert!(!ok);
        let v = view(&c);
        assert_eq!(v.balance.0, 10 * NEAR);
        assert_eq!(v.total_fees_paid.0, 0);
        assert_eq!(v.spent_in_window.0, 0);
    }

    // ---------------------------------------------------------------- wNEAR
    //
    // wNEAR has the same 24 decimals as NEAR, so these tests count in `NEAR` units too.

    /// The wNEAR token contract.
    fn wrap() -> AccountId {
        "wrap.testnet".parse().unwrap()
    }

    /// What happens when `sender` sends wNEAR with `ft_transfer_call`: the token contract
    /// calls `ft_on_transfer` on the vault contract. Returns the amount reported unused.
    fn deposit_wnear(c: &mut Capkey, sender: AccountId, amount: u128) -> u128 {
        ctx(wrap(), 0, T0);
        match c.ft_on_transfer(sender, U128(amount), String::new()) {
            PromiseOrValue::Value(unused) => unused.0,
            PromiseOrValue::Promise(_) => panic!("expected a plain value"),
        }
    }

    /// `setup()` plus `balance` wNEAR deposited by the owner and a wNEAR policy of 1 per
    /// payment and 3 per day. Leaves the context set to the owner.
    fn setup_with_wnear(balance: u128) -> Capkey {
        let mut c = setup();
        if balance > 0 {
            deposit_wnear(&mut c, owner(), balance);
        }
        as_owner(T0);
        c.set_token_policy(U128(NEAR), U128(3 * NEAR));
        c
    }

    /// 10 wNEAR in the vault.
    fn setup_wnear() -> Capkey {
        setup_with_wnear(10 * NEAR)
    }

    /// Same as `setup_with_wnear` with a fee of `bps` basis points going to `treasury()`.
    fn setup_wnear_with_fee(balance: u128, bps: u16) -> Capkey {
        let mut c = setup_with_wnear(balance);
        as_owner(T0);
        c.set_fee(bps, treasury());
        c
    }

    fn pay_wnear(c: &mut Capkey, who: AccountId, to: AccountId, amount: u128, now: u64) {
        ctx(who, 0, now);
        let _ = c.execute_ft_payment(owner(), to, U128(amount));
    }

    fn token(c: &Capkey) -> TokenView {
        view(c).token
    }

    /// Every `ft_transfer` call the last contract call sent, as
    /// (contract it was sent to, JSON arguments, attached yoctoNEAR).
    fn ft_transfers() -> Vec<(AccountId, Value, u128)> {
        let mut out = Vec::new();
        for receipt in near_sdk::test_utils::get_created_receipts() {
            let to = receipt.receiver_id.clone();
            for action in receipt.actions {
                if let near_sdk::mock::MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    ..
                } = action
                {
                    if method_name == b"ft_transfer" {
                        out.push((
                            to.clone(),
                            near_sdk::serde_json::from_slice(&args).unwrap(),
                            attached_deposit.as_yoctonear(),
                        ));
                    }
                }
            }
        }
        out
    }

    /// How many plain NEAR transfers the last contract call sent.
    fn near_transfer_count() -> usize {
        near_sdk::test_utils::get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter(|a| matches!(a, near_sdk::mock::MockAction::Transfer { .. }))
            .count()
    }

    /// Run the callback of a wNEAR payment with these transfer results (payment first,
    /// fee second when there was a fee).
    fn resolve_wnear(c: &mut Capkey, results: Vec<PromiseResult>, amount: u128, fee: u128) -> bool {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(contract())
                .predecessor_account_id(contract())
                .block_timestamp(T0)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
        c.on_ft_payment_resolved(owner(), U128(amount), U128(fee), U64(T0))
    }

    /// Run the callback of `withdraw_token` with this transfer result.
    fn resolve_wnear_withdraw(c: &mut Capkey, result: PromiseResult, amount: u128) -> bool {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(contract())
                .predecessor_account_id(contract())
                .block_timestamp(T0)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
        c.on_ft_withdraw_resolved(owner(), U128(amount))
    }

    // deposits

    #[test]
    fn a_new_vault_has_no_wnear_and_no_wnear_policy() {
        let c = setup();
        let t = token(&c);
        assert_eq!(t.token_id, wrap());
        assert_eq!(t.balance.0, 0);
        assert!(t.policy.is_none());
        assert_eq!(t.spent_in_window.0, 0);
        assert_eq!(t.remaining_today.0, 0);
        assert_eq!(t.total_fees_paid.0, 0);
    }

    #[test]
    fn a_wnear_deposit_is_credited_to_the_senders_vault() {
        let mut c = setup();
        let unused = deposit_wnear(&mut c, owner(), 5 * NEAR);
        assert_eq!(unused, 0);
        assert_eq!(token(&c).balance.0, 5 * NEAR);
    }

    #[test]
    fn wnear_deposits_add_up() {
        let mut c = setup();
        deposit_wnear(&mut c, owner(), 3 * NEAR);
        deposit_wnear(&mut c, owner(), 4 * NEAR);
        assert_eq!(token(&c).balance.0, 7 * NEAR);
    }

    #[test]
    fn a_wnear_deposit_leaves_the_near_side_alone() {
        let mut c = setup();
        deposit_wnear(&mut c, owner(), 5 * NEAR);
        let v = view(&c);
        assert_eq!(v.balance.0, 10 * NEAR);
        assert_eq!(v.spent_in_window.0, 0);
        assert_eq!(v.policy.unwrap().per_tx_cap.0, NEAR);
    }

    #[test]
    fn a_wnear_deposit_works_before_any_policy_is_set() {
        ctx(owner(), 0, T0);
        let mut c = Capkey::new();
        c.create_vault(agent());
        assert_eq!(deposit_wnear(&mut c, owner(), 2 * NEAR), 0);
        assert_eq!(token(&c).balance.0, 2 * NEAR);
    }

    #[test]
    fn a_wnear_deposit_is_logged() {
        let mut c = setup();
        deposit_wnear(&mut c, owner(), 5 * NEAR);
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains("token_deposit")));
    }

    #[test]
    fn a_deposit_from_an_account_without_a_vault_is_handed_back() {
        let mut c = setup();
        let unused = deposit_wnear(&mut c, stranger(), 5 * NEAR);
        // the whole amount is reported as unused, so the token contract refunds it
        assert_eq!(unused, 5 * NEAR);
        assert_eq!(token(&c).balance.0, 0);
    }

    #[test]
    fn a_deposit_only_goes_to_the_senders_own_vault() {
        let mut c = setup();
        // the stranger has a vault of their own
        ctx(stranger(), 0, T0);
        c.create_vault(agent());
        deposit_wnear(&mut c, stranger(), 5 * NEAR);
        assert_eq!(c.get_vault(stranger()).unwrap().token.balance.0, 5 * NEAR);
        assert_eq!(token(&c).balance.0, 0);
    }

    #[test]
    #[should_panic(expected = "only wNEAR (wrap.testnet) is accepted")]
    fn another_token_cannot_be_deposited() {
        let mut c = setup();
        ctx("usdt.testnet".parse().unwrap(), 0, T0);
        let _ = c.ft_on_transfer(owner(), U128(NEAR), String::new());
    }

    #[test]
    #[should_panic(expected = "only wNEAR (wrap.testnet) is accepted")]
    fn nobody_but_the_token_contract_can_credit_a_deposit() {
        let mut c = setup();
        // the owner calling it directly would be a free top-up
        ctx(owner(), 0, T0);
        let _ = c.ft_on_transfer(owner(), U128(NEAR), String::new());
    }

    #[test]
    #[should_panic(expected = "amount is too large")]
    fn a_deposit_that_overflows_the_balance_is_blocked() {
        let mut c = setup();
        deposit_wnear(&mut c, owner(), u128::MAX);
        deposit_wnear(&mut c, owner(), 1);
    }

    // the wNEAR policy

    #[test]
    fn set_token_policy_shows_up_in_the_vault_view() {
        let c = setup_with_wnear(0);
        let t = token(&c);
        let p = t.policy.unwrap();
        assert_eq!(p.per_tx_cap.0, NEAR);
        assert_eq!(p.daily_limit.0, 3 * NEAR);
        assert_eq!(t.remaining_today.0, 3 * NEAR);
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn only_a_vault_owner_can_set_a_token_policy() {
        let mut c = setup();
        ctx(stranger(), 0, T0);
        c.set_token_policy(U128(NEAR), U128(3 * NEAR));
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn the_agent_cannot_set_the_token_policy() {
        let mut c = setup();
        ctx(agent(), 0, T0);
        c.set_token_policy(U128(100 * NEAR), U128(1000 * NEAR));
    }

    #[test]
    #[should_panic(expected = "per-transaction cap must be above zero")]
    fn a_zero_token_cap_is_blocked() {
        let mut c = setup();
        as_owner(T0);
        c.set_token_policy(U128(0), U128(NEAR));
    }

    #[test]
    #[should_panic(expected = "daily limit must be at least the per-transaction cap")]
    fn a_token_daily_limit_below_the_cap_is_blocked() {
        let mut c = setup();
        as_owner(T0);
        c.set_token_policy(U128(2 * NEAR), U128(NEAR));
    }

    #[test]
    fn set_token_policy_does_not_touch_the_near_policy_or_window() {
        let mut c = setup();
        as_owner(T0);
        c.approve_once(stranger());
        pay(&mut c, agent(), shop(), NEAR, T0);
        as_owner(T0 + 5);
        c.set_token_policy(U128(NEAR / 2), U128(NEAR));
        let v = view(&c);
        assert_eq!(v.spent_in_window.0, NEAR);
        assert_eq!(v.window_start.0, T0);
        assert_eq!(v.balance.0, 9 * NEAR);
        assert_eq!(v.one_time_recipients, vec![stranger()]);
        let p = v.policy.unwrap();
        assert_eq!(p.per_tx_cap.0, NEAR);
        assert_eq!(p.daily_limit.0, 3 * NEAR);
    }

    #[test]
    fn set_policy_does_not_touch_the_wnear_side() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        as_owner(T0 + 5);
        c.set_policy(
            U128(NEAR),
            U128(3 * NEAR),
            vec![shop()],
            U64(T0 + 7 * DAY_NS),
        );
        let t = token(&c);
        assert_eq!(t.balance.0, 9 * NEAR);
        assert_eq!(t.spent_in_window.0, NEAR);
        assert_eq!(t.window_start.0, T0);
        assert_eq!(t.policy.unwrap().daily_limit.0, 3 * NEAR);
    }

    #[test]
    fn set_token_policy_restarts_the_wnear_window() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        as_owner(T0 + 5);
        c.set_token_policy(U128(NEAR), U128(3 * NEAR));
        let t = token(&c);
        assert_eq!(t.spent_in_window.0, 0);
        assert_eq!(t.window_start.0, 0);
        // the balance is not touched
        assert_eq!(t.balance.0, 9 * NEAR);
    }

    #[test]
    fn get_vault_still_has_every_old_field_and_adds_the_token_info() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 50);
        as_owner(T0);
        c.approve_once(stranger());
        let json = near_sdk::serde_json::to_value(view(&c)).unwrap();
        for key in [
            "agent",
            "balance",
            "revoked",
            "policy",
            "one_time_recipients",
            "fee_bps",
            "fee_treasury",
            "total_fees_paid",
            "spent_in_window",
            "window_start",
            "remaining_today",
            "token",
        ] {
            assert!(json.get(key).is_some(), "get_vault is missing `{key}`");
        }
        // the old fields keep their old meaning and format
        assert_eq!(json["balance"], (10 * NEAR).to_string());
        assert_eq!(json["policy"]["per_tx_cap"], NEAR.to_string());
        assert_eq!(json["one_time_recipients"][0], stranger().as_str());
        assert_eq!(json["fee_bps"], 50);
        assert_eq!(json["fee_treasury"], treasury().as_str());
        // the token info sits next to them
        let t = &json["token"];
        assert_eq!(t["token_id"], "wrap.testnet");
        assert_eq!(t["balance"], (10 * NEAR).to_string());
        assert_eq!(t["policy"]["per_tx_cap"], NEAR.to_string());
        assert_eq!(t["policy"]["daily_limit"], (3 * NEAR).to_string());
        for key in [
            "spent_in_window",
            "window_start",
            "remaining_today",
            "total_fees_paid",
        ] {
            assert!(t.get(key).is_some(), "token info is missing `{key}`");
        }
    }

    // paying wNEAR

    #[test]
    fn a_wnear_payment_inside_the_policy_succeeds() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        let t = token(&c);
        assert_eq!(t.balance.0, 9 * NEAR);
        assert_eq!(t.spent_in_window.0, NEAR);
        assert_eq!(t.remaining_today.0, 2 * NEAR);
        assert_eq!(t.window_start.0, T0);
    }

    #[test]
    fn a_wnear_payment_leaves_the_near_side_alone() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        let v = view(&c);
        assert_eq!(v.balance.0, 10 * NEAR);
        assert_eq!(v.spent_in_window.0, 0);
        assert_eq!(v.window_start.0, 0);
        assert_eq!(v.remaining_today.0, 3 * NEAR);
    }

    #[test]
    fn a_wnear_payment_sends_an_ft_transfer_to_the_token_contract() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR / 2, T0);
        let sent = ft_transfers();
        assert_eq!(sent.len(), 1);
        let (to, args, attached) = &sent[0];
        assert_eq!(*to, wrap());
        assert_eq!(
            *args,
            json!({ "receiver_id": shop(), "amount": (NEAR / 2).to_string() })
        );
        // NEP-141 requires exactly 1 yoctoNEAR on ft_transfer
        assert_eq!(*attached, 1);
        // and no NEAR goes to the recipient
        assert_eq!(near_transfer_count(), 0);
    }

    #[test]
    fn a_near_payment_sends_no_token_transfer() {
        let mut c = setup_wnear();
        pay(&mut c, agent(), shop(), NEAR, T0);
        assert!(ft_transfers().is_empty());
        assert_eq!(near_transfer_count(), 1);
        assert_eq!(token(&c).balance.0, 10 * NEAR);
        assert_eq!(token(&c).spent_in_window.0, 0);
    }

    #[test]
    fn a_wnear_payment_is_logged_with_the_token() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        assert!(near_sdk::test_utils::get_logs().iter().any(|l| {
            l.contains("ft_payment_executed") && l.contains("\"token\":\"wrap.testnet\"")
        }));
    }

    #[test]
    #[should_panic(expected = "caller is not the agent")]
    fn only_the_agent_can_pay_wnear() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, stranger(), shop(), NEAR, T0);
    }

    #[test]
    #[should_panic(expected = "caller is not the agent")]
    fn the_owner_cannot_pay_wnear_through_the_agent_method() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, owner(), shop(), NEAR, T0);
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn paying_wnear_from_a_missing_vault_is_blocked() {
        let mut c = setup_wnear();
        ctx(agent(), 0, T0);
        let _ = c.execute_ft_payment(stranger(), shop(), U128(NEAR));
    }

    #[test]
    #[should_panic(expected = "agent has been revoked")]
    fn a_revoked_agent_cannot_pay_wnear() {
        let mut c = setup_wnear();
        as_owner(T0);
        c.revoke_agent();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
    }

    #[test]
    #[should_panic(expected = "no policy set for this vault")]
    fn wnear_payments_need_the_near_policy_too() {
        // the approved list and the expiry live in the NEAR policy
        ctx(owner(), 0, T0);
        let mut c = Capkey::new();
        c.create_vault(agent());
        deposit_wnear(&mut c, owner(), 5 * NEAR);
        as_owner(T0);
        c.set_token_policy(U128(NEAR), U128(3 * NEAR));
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
    }

    #[test]
    #[should_panic(expected = "no token policy set for this vault")]
    fn wnear_payments_need_a_token_policy() {
        let mut c = setup();
        deposit_wnear(&mut c, owner(), 5 * NEAR);
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
    }

    #[test]
    #[should_panic(expected = "policy has expired")]
    fn an_expired_policy_blocks_wnear_payments() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0 + 7 * DAY_NS + 1);
    }

    #[test]
    #[should_panic(expected = "recipient is not on the approved list")]
    fn wnear_to_an_unapproved_recipient_is_blocked() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), stranger(), NEAR, T0);
    }

    #[test]
    #[should_panic(expected = "amount must be above zero")]
    fn a_zero_wnear_payment_is_blocked() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), 0, T0);
    }

    #[test]
    #[should_panic(expected = "over the per-transaction cap")]
    fn a_wnear_payment_over_the_token_cap_is_blocked() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR + 1, T0);
    }

    #[test]
    fn a_wnear_payment_exactly_at_the_token_cap_goes_through() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        assert_eq!(token(&c).balance.0, 9 * NEAR);
    }

    #[test]
    #[should_panic(expected = "over the daily limit")]
    fn wnear_payments_over_the_token_daily_limit_are_blocked() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        pay_wnear(&mut c, agent(), shop(), NEAR, T0 + 1);
        pay_wnear(&mut c, agent(), shop(), NEAR, T0 + 2);
        pay_wnear(&mut c, agent(), shop(), NEAR, T0 + 3);
    }

    #[test]
    fn the_wnear_daily_limit_resets_after_24_hours() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        pay_wnear(&mut c, agent(), shop(), NEAR, T0 + 1);
        pay_wnear(&mut c, agent(), shop(), NEAR, T0 + 2);
        pay_wnear(&mut c, agent(), shop(), NEAR, T0 + DAY_NS + 10);
        let t = token(&c);
        assert_eq!(t.balance.0, 6 * NEAR);
        assert_eq!(t.spent_in_window.0, NEAR);
    }

    #[test]
    fn the_wnear_view_shows_the_full_limit_again_after_24_hours() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        assert_eq!(token(&c).remaining_today.0, 2 * NEAR);
        ctx(owner(), 0, T0 + DAY_NS + 10);
        assert_eq!(token(&c).remaining_today.0, 3 * NEAR);
    }

    #[test]
    #[should_panic(expected = "vault token balance is too low")]
    fn a_wnear_payment_over_the_token_balance_is_blocked() {
        // the vault holds 10 NEAR, but only 0.5 wNEAR: the NEAR balance does not count
        let mut c = setup_with_wnear(NEAR / 2);
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
    }

    #[test]
    #[should_panic(expected = "vault token balance is too low")]
    fn a_wnear_payment_with_no_wnear_deposited_is_blocked() {
        let mut c = setup_with_wnear(0);
        pay_wnear(&mut c, agent(), shop(), NEAR / 10, T0);
    }

    #[test]
    fn a_refused_wnear_payment_changes_nothing() {
        let mut c = setup_wnear();
        let result = catch_unwind(AssertUnwindSafe(|| {
            pay_wnear(&mut c, agent(), stranger(), NEAR, T0);
        }));
        assert!(result.is_err());
        assert!(ft_transfers().is_empty());
        let t = token(&c);
        assert_eq!(t.balance.0, 10 * NEAR);
        assert_eq!(t.spent_in_window.0, 0);
        assert_eq!(t.total_fees_paid.0, 0);
    }

    // wNEAR and NEAR limits are separate

    #[test]
    fn using_up_the_near_limits_leaves_the_wnear_limits_alone() {
        let mut c = setup_wnear();
        pay(&mut c, agent(), shop(), NEAR, T0);
        pay(&mut c, agent(), shop(), NEAR, T0 + 1);
        pay(&mut c, agent(), shop(), NEAR, T0 + 2);
        // the NEAR daily limit is gone, the wNEAR one is not
        pay_wnear(&mut c, agent(), shop(), NEAR, T0 + 3);
        assert_eq!(token(&c).balance.0, 9 * NEAR);
        assert_eq!(view(&c).remaining_today.0, 0);
    }

    #[test]
    fn using_up_the_wnear_limits_leaves_the_near_limits_alone() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        pay_wnear(&mut c, agent(), shop(), NEAR, T0 + 1);
        pay_wnear(&mut c, agent(), shop(), NEAR, T0 + 2);
        assert_eq!(token(&c).remaining_today.0, 0);
        pay(&mut c, agent(), shop(), NEAR, T0 + 3);
        assert_eq!(view(&c).balance.0, 9 * NEAR);
    }

    #[test]
    fn the_wnear_cap_can_be_lower_than_the_near_cap() {
        let mut c = setup_wnear();
        as_owner(T0);
        c.set_token_policy(U128(NEAR / 4), U128(NEAR / 2));
        // 0.25 is fine in both
        pay_wnear(&mut c, agent(), shop(), NEAR / 4, T0);
        pay(&mut c, agent(), shop(), NEAR / 4, T0);
        // 0.3 is under the NEAR cap (1)
        pay(&mut c, agent(), shop(), 3 * NEAR / 10, T0 + 1);
        assert_eq!(view(&c).balance.0, 10 * NEAR - NEAR / 4 - 3 * NEAR / 10);
    }

    #[test]
    #[should_panic(expected = "over the per-transaction cap")]
    fn a_payment_the_near_cap_allows_can_still_break_the_wnear_cap() {
        let mut c = setup_wnear();
        as_owner(T0);
        c.set_token_policy(U128(NEAR / 4), U128(NEAR / 2));
        // 0.3 is under the NEAR cap (1) but over the wNEAR cap (0.25)
        pay_wnear(&mut c, agent(), shop(), 3 * NEAR / 10, T0);
    }

    // revoke and rotate

    #[test]
    fn revoking_keeps_the_wnear_balance_and_policy() {
        let mut c = setup_wnear();
        as_owner(T0);
        c.revoke_agent();
        let t = token(&c);
        assert_eq!(t.balance.0, 10 * NEAR);
        assert_eq!(t.policy.unwrap().per_tx_cap.0, NEAR);
    }

    #[test]
    fn a_rotated_agent_can_pay_wnear() {
        let mut c = setup_wnear();
        as_owner(T0);
        c.revoke_agent();
        c.rotate_agent(stranger());
        pay_wnear(&mut c, stranger(), shop(), NEAR, T0);
        assert_eq!(token(&c).balance.0, 9 * NEAR);
    }

    #[test]
    #[should_panic(expected = "caller is not the agent")]
    fn the_old_agent_cannot_pay_wnear_after_a_rotation() {
        let mut c = setup_wnear();
        as_owner(T0);
        c.rotate_agent(stranger());
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
    }

    // one-time approvals work for wNEAR too

    #[test]
    fn a_one_time_approval_works_for_a_wnear_payment_and_is_used_up() {
        let mut c = setup_wnear();
        as_owner(T0);
        c.approve_once(stranger());
        pay_wnear(&mut c, agent(), stranger(), NEAR / 2, T0);
        assert!(view(&c).one_time_recipients.is_empty());
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains("\"one_time_approval_used\":true")));
        // the approval is gone, so a second payment is blocked
        let again = catch_unwind(AssertUnwindSafe(|| {
            pay_wnear(&mut c, agent(), stranger(), NEAR / 2, T0 + 1);
        }));
        assert!(again.is_err());
    }

    #[test]
    fn a_blocked_wnear_payment_does_not_use_up_the_approval() {
        let mut c = setup_wnear();
        as_owner(T0);
        c.approve_once(stranger());
        // 2 is over the wNEAR cap, so the contract refuses it
        let result = catch_unwind(AssertUnwindSafe(|| {
            pay_wnear(&mut c, agent(), stranger(), 2 * NEAR, T0);
        }));
        assert!(result.is_err());
        assert_eq!(view(&c).one_time_recipients, vec![stranger()]);
        pay_wnear(&mut c, agent(), stranger(), NEAR, T0);
        assert!(view(&c).one_time_recipients.is_empty());
    }

    #[test]
    fn a_permanent_recipient_keeps_the_list_after_a_wnear_payment() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR / 2, T0);
        assert_eq!(view(&c).policy.unwrap().allowed_recipients, vec![shop()]);
    }

    // the fee on wNEAR payments

    #[test]
    fn a_wnear_payment_without_a_fee_sends_no_fee() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        assert_eq!(ft_transfers().len(), 1);
        assert_eq!(token(&c).total_fees_paid.0, 0);
    }

    #[test]
    fn the_fee_is_charged_on_wnear_payments_on_top_of_the_amount() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 50);
        let amount = NEAR / 2;
        let fee = NEAR / 400; // 0.5% of 0.5
        pay_wnear(&mut c, agent(), shop(), amount, T0);
        let t = token(&c);
        assert_eq!(t.balance.0, 10 * NEAR - amount - fee);
        assert_eq!(t.spent_in_window.0, amount + fee);
        assert_eq!(t.total_fees_paid.0, fee);
        // the NEAR side is not charged
        let v = view(&c);
        assert_eq!(v.balance.0, 10 * NEAR);
        assert_eq!(v.total_fees_paid.0, 0);
        assert_eq!(v.spent_in_window.0, 0);
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains(&format!("\"fee\":\"{fee}\""))));
    }

    #[test]
    fn the_wnear_fee_goes_out_in_the_same_call_as_the_payment() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 50);
        let amount = NEAR / 2;
        let fee = NEAR / 400;
        pay_wnear(&mut c, agent(), shop(), amount, T0);
        let sent = ft_transfers();
        assert_eq!(sent.len(), 2);
        assert!(sent
            .iter()
            .all(|(to, _, attached)| *to == wrap() && *attached == 1));
        let args: Vec<&Value> = sent.iter().map(|(_, a, _)| a).collect();
        assert!(args.contains(&&json!({ "receiver_id": shop(), "amount": amount.to_string() })));
        assert!(args.contains(&&json!({ "receiver_id": treasury(), "amount": fee.to_string() })));
        assert_eq!(near_transfer_count(), 0);
    }

    #[test]
    fn the_wnear_fee_is_rounded_down() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 50);
        // 0.5% of 399 is 1.995, which rounds down to 1
        pay_wnear(&mut c, agent(), shop(), 399, T0);
        assert_eq!(token(&c).total_fees_paid.0, 1);
    }

    #[test]
    fn a_wnear_fee_that_rounds_to_nothing_sends_no_fee() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 50);
        // 0.5% of 100 is 0.5, which rounds down to 0
        pay_wnear(&mut c, agent(), shop(), 100, T0);
        let t = token(&c);
        assert_eq!(t.total_fees_paid.0, 0);
        assert_eq!(t.balance.0, 10 * NEAR - 100);
        let sent = ft_transfers();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].1, json!({ "receiver_id": shop(), "amount": "100" }));
    }

    #[test]
    #[should_panic(expected = "over the per-transaction cap")]
    fn the_fee_counts_toward_the_wnear_cap() {
        // the cap is 1: 1 plus a fee is more than that
        let mut c = setup_wnear_with_fee(10 * NEAR, 50);
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
    }

    #[test]
    #[should_panic(expected = "over the daily limit")]
    fn the_fee_counts_toward_the_wnear_daily_limit() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 200);
        // 0.9 + 2% = 0.918 each, three of them make 2.754
        for i in 0..3 {
            pay_wnear(&mut c, agent(), shop(), 9 * NEAR / 10, T0 + i);
        }
        // 0.245 + 2% = 0.2499 is too much for the 0.246 that is left
        pay_wnear(&mut c, agent(), shop(), 245 * NEAR / 1000, T0 + 3);
    }

    #[test]
    fn a_wnear_payment_that_fits_the_daily_limit_with_its_fee_goes_through() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 200);
        for i in 0..3 {
            pay_wnear(&mut c, agent(), shop(), 9 * NEAR / 10, T0 + i);
        }
        // 0.24 + 2% = 0.2448 fits in the 0.246 that is left
        pay_wnear(&mut c, agent(), shop(), 24 * NEAR / 100, T0 + 3);
        assert!(token(&c).remaining_today.0 > 0);
    }

    #[test]
    #[should_panic(expected = "vault token balance is too low")]
    fn the_fee_counts_toward_the_wnear_balance_check() {
        let mut c = setup_wnear_with_fee(NEAR / 2, 200);
        // 0.495 + 2% = 0.5049 is more than the 0.5 in the vault
        pay_wnear(&mut c, agent(), shop(), 495 * NEAR / 1000, T0);
    }

    #[test]
    fn a_wnear_payment_that_fits_the_balance_with_its_fee_goes_through() {
        let mut c = setup_wnear_with_fee(NEAR / 2, 200);
        // 0.49 + 2% = 0.4998 fits in 0.5 and leaves 0.0002
        pay_wnear(&mut c, agent(), shop(), 49 * NEAR / 100, T0);
        assert_eq!(token(&c).balance.0, NEAR / 5000);
    }

    #[test]
    fn a_refused_wnear_payment_pays_no_fee() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 50);
        let result = catch_unwind(AssertUnwindSafe(|| {
            pay_wnear(&mut c, agent(), stranger(), NEAR / 2, T0);
        }));
        assert!(result.is_err());
        assert!(ft_transfers().is_empty());
        let t = token(&c);
        assert_eq!(t.total_fees_paid.0, 0);
        assert_eq!(t.balance.0, 10 * NEAR);
    }

    // refunds when a wNEAR transfer fails

    #[test]
    fn if_the_wnear_transfer_works_nothing_is_undone() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        let ok = resolve_wnear(&mut c, vec![PromiseResult::Successful(vec![])], NEAR, 0);
        assert!(ok);
        let t = token(&c);
        assert_eq!(t.balance.0, 9 * NEAR);
        assert_eq!(t.spent_in_window.0, NEAR);
    }

    #[test]
    fn a_transfer_that_returns_data_still_counts_as_done() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        let ok = resolve_wnear(
            &mut c,
            vec![PromiseResult::Successful(vec![1, 2, 3])],
            NEAR,
            0,
        );
        assert!(ok);
        assert_eq!(token(&c).balance.0, 9 * NEAR);
    }

    #[test]
    fn a_failed_wnear_transfer_is_refunded() {
        // for example the recipient is not registered on wrap.testnet
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        let ok = resolve_wnear(&mut c, vec![PromiseResult::Failed], NEAR, 0);
        assert!(!ok);
        let t = token(&c);
        assert_eq!(t.balance.0, 10 * NEAR);
        assert_eq!(t.spent_in_window.0, 0);
        // the NEAR side was never involved
        assert_eq!(view(&c).balance.0, 10 * NEAR);
    }

    #[test]
    fn a_refund_is_logged() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        resolve_wnear(&mut c, vec![PromiseResult::Failed], NEAR, 0);
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains("ft_transfer_failed_refunded")));
    }

    #[test]
    fn both_wnear_transfers_working_undoes_nothing() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 50);
        let amount = NEAR / 2;
        let fee = NEAR / 400;
        pay_wnear(&mut c, agent(), shop(), amount, T0);
        let ok = resolve_wnear(
            &mut c,
            vec![
                PromiseResult::Successful(vec![]),
                PromiseResult::Successful(vec![]),
            ],
            amount,
            fee,
        );
        assert!(ok);
        let t = token(&c);
        assert_eq!(t.balance.0, 10 * NEAR - amount - fee);
        assert_eq!(t.total_fees_paid.0, fee);
    }

    #[test]
    fn a_bounced_wnear_payment_is_refunded_and_the_fee_stays_paid() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 50);
        let amount = NEAR / 2;
        let fee = NEAR / 400;
        pay_wnear(&mut c, agent(), shop(), amount, T0);
        let ok = resolve_wnear(
            &mut c,
            vec![PromiseResult::Failed, PromiseResult::Successful(vec![])],
            amount,
            fee,
        );
        assert!(!ok);
        let t = token(&c);
        assert_eq!(t.balance.0, 10 * NEAR - fee);
        assert_eq!(t.total_fees_paid.0, fee);
        assert_eq!(t.spent_in_window.0, fee);
    }

    #[test]
    fn a_bounced_wnear_fee_is_refunded_and_the_payment_stays_paid() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 50);
        let amount = NEAR / 2;
        let fee = NEAR / 400;
        pay_wnear(&mut c, agent(), shop(), amount, T0);
        let ok = resolve_wnear(
            &mut c,
            vec![PromiseResult::Successful(vec![]), PromiseResult::Failed],
            amount,
            fee,
        );
        assert!(ok);
        let t = token(&c);
        assert_eq!(t.balance.0, 10 * NEAR - amount);
        assert_eq!(t.total_fees_paid.0, 0);
        assert_eq!(t.spent_in_window.0, amount);
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains("ft_fee_transfer_failed_refunded")));
    }

    #[test]
    fn if_both_wnear_transfers_bounce_everything_goes_back() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 50);
        let amount = NEAR / 2;
        let fee = NEAR / 400;
        pay_wnear(&mut c, agent(), shop(), amount, T0);
        let ok = resolve_wnear(
            &mut c,
            vec![PromiseResult::Failed, PromiseResult::Failed],
            amount,
            fee,
        );
        assert!(!ok);
        let t = token(&c);
        assert_eq!(t.balance.0, 10 * NEAR);
        assert_eq!(t.total_fees_paid.0, 0);
        assert_eq!(t.spent_in_window.0, 0);
    }

    #[test]
    fn a_late_refund_does_not_undo_spending_in_a_newer_window() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        // a day later a new window starts and the agent pays again
        pay_wnear(&mut c, agent(), shop(), NEAR, T0 + DAY_NS + 10);
        // now the first payment's callback comes back failed
        let ok = resolve_wnear(&mut c, vec![PromiseResult::Failed], NEAR, 0);
        assert!(!ok);
        let t = token(&c);
        assert_eq!(t.balance.0, 9 * NEAR);
        // the new window's spend is still counted
        assert_eq!(t.spent_in_window.0, NEAR);
    }

    #[test]
    #[should_panic(expected = "unexpected number of promise results")]
    fn a_callback_with_a_fee_needs_two_results() {
        let mut c = setup_wnear_with_fee(10 * NEAR, 50);
        pay_wnear(&mut c, agent(), shop(), NEAR / 2, T0);
        resolve_wnear(
            &mut c,
            vec![PromiseResult::Successful(vec![])],
            NEAR / 2,
            NEAR / 400,
        );
    }

    #[test]
    #[should_panic(expected = "unexpected number of promise results")]
    fn a_callback_without_a_fee_needs_one_result() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        resolve_wnear(
            &mut c,
            vec![
                PromiseResult::Successful(vec![]),
                PromiseResult::Successful(vec![]),
            ],
            NEAR,
            0,
        );
    }

    // withdraw_token

    #[test]
    fn the_owner_can_withdraw_wnear() {
        let mut c = setup_wnear();
        as_owner(T0);
        let _ = c.withdraw_token(U128(4 * NEAR));
        assert_eq!(token(&c).balance.0, 6 * NEAR);
        let sent = ft_transfers();
        assert_eq!(sent.len(), 1);
        let (to, args, attached) = &sent[0];
        assert_eq!(*to, wrap());
        assert_eq!(
            *args,
            json!({ "receiver_id": owner(), "amount": (4 * NEAR).to_string() })
        );
        assert_eq!(*attached, 1);
        // the NEAR side is not touched
        assert_eq!(view(&c).balance.0, 10 * NEAR);
        assert_eq!(near_transfer_count(), 0);
    }

    #[test]
    fn withdrawing_wnear_does_not_touch_the_daily_spend() {
        let mut c = setup_wnear();
        pay_wnear(&mut c, agent(), shop(), NEAR, T0);
        as_owner(T0 + 1);
        let _ = c.withdraw_token(U128(2 * NEAR));
        let t = token(&c);
        assert_eq!(t.balance.0, 7 * NEAR);
        assert_eq!(t.spent_in_window.0, NEAR);
    }

    #[test]
    fn withdrawing_near_does_not_touch_the_wnear_balance() {
        let mut c = setup_wnear();
        as_owner(T0);
        let _ = c.withdraw(U128(2 * NEAR));
        assert_eq!(view(&c).balance.0, 8 * NEAR);
        assert_eq!(token(&c).balance.0, 10 * NEAR);
        assert!(ft_transfers().is_empty());
    }

    #[test]
    fn the_owner_can_withdraw_wnear_after_revoking_the_agent() {
        let mut c = setup_wnear();
        as_owner(T0);
        c.revoke_agent();
        let _ = c.withdraw_token(U128(10 * NEAR));
        assert_eq!(token(&c).balance.0, 0);
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn only_the_owner_can_withdraw_wnear() {
        let mut c = setup_wnear();
        ctx(stranger(), 0, T0);
        let _ = c.withdraw_token(U128(NEAR));
    }

    #[test]
    #[should_panic(expected = "no vault for this owner")]
    fn the_agent_cannot_withdraw_wnear() {
        let mut c = setup_wnear();
        ctx(agent(), 0, T0);
        let _ = c.withdraw_token(U128(NEAR));
    }

    #[test]
    #[should_panic(expected = "amount is more than the vault token balance")]
    fn withdrawing_more_wnear_than_the_balance_is_blocked() {
        // 10 NEAR is in the vault but only 1 wNEAR
        let mut c = setup_with_wnear(NEAR);
        as_owner(T0);
        let _ = c.withdraw_token(U128(NEAR + 1));
    }

    #[test]
    #[should_panic(expected = "amount must be above zero")]
    fn withdrawing_zero_wnear_is_blocked() {
        let mut c = setup_wnear();
        as_owner(T0);
        let _ = c.withdraw_token(U128(0));
    }

    #[test]
    fn a_failed_wnear_withdrawal_goes_back_on_the_balance() {
        let mut c = setup_wnear();
        as_owner(T0);
        let _ = c.withdraw_token(U128(4 * NEAR));
        let ok = resolve_wnear_withdraw(&mut c, PromiseResult::Failed, 4 * NEAR);
        assert!(!ok);
        assert_eq!(token(&c).balance.0, 10 * NEAR);
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.contains("token_withdraw_failed_refunded")));
    }

    #[test]
    fn a_wnear_withdrawal_that_works_stays_withdrawn() {
        let mut c = setup_wnear();
        as_owner(T0);
        let _ = c.withdraw_token(U128(4 * NEAR));
        let ok = resolve_wnear_withdraw(&mut c, PromiseResult::Successful(vec![]), 4 * NEAR);
        assert!(ok);
        assert_eq!(token(&c).balance.0, 6 * NEAR);
    }
}
