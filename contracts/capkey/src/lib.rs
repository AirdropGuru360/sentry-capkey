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
//! Amounts are in yoctoNEAR (1 NEAR = 10^24 yoctoNEAR). Timestamps are nanoseconds.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

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
}
