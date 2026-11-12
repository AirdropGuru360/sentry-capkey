// A reusable safety layer: any agent can pay through a Capkey vault behind a
// risk check plus a live vault-policy preview. No Telegram here.
// Reuses the existing payment pieces by import: getVault (vault.js),
// assessRecipient (risk.js) and executePayment (pay.js).
import { getVault } from "./vault.js";
import { assessRecipient } from "./risk.js";
import { executePayment } from "./pay.js";
import { BLOCKLIST } from "./blocklist.js";
import { isValidAccountId } from "./amount.js";

function block(reasons) {
  return { level: "block", reasons, allowed: false };
}

// rpcUrl is accepted for interface compatibility with the bot's config shape.
// The vault read itself is read-only and needs no key: getVault reads its RPC
// from the NEAR_RPC_URL environment variable or the public testnet RPC.
export function createGuardedPayer({ vaultId, ownerAccount, agentAccount, getAgent, rpcUrl }) {
  if (!isValidAccountId(vaultId)) throw new Error("invalid vaultId");
  if (!isValidAccountId(ownerAccount)) throw new Error("invalid ownerAccount");
  if (!isValidAccountId(agentAccount)) throw new Error("invalid agentAccount");
  if (typeof getAgent !== "function") throw new Error("getAgent must be a function");
  if (rpcUrl !== undefined && rpcUrl !== "") {
    try {
      new URL(rpcUrl); // validate, reserved for future use
    } catch {
      throw new Error("invalid rpcUrl");
    }
  }

  // Recipients paid successfully through this payer. First-time payments get a
  // warning from the risk check, mirroring the bot's payflow.
  const paidBefore = new Set();
  const selfIds = [vaultId, ownerAccount, agentAccount];

  // Risk check plus the vault policy preview. Fails closed: any vault or
  // input problem is a block, never a silent pass.
  async function quote(recipient, amountYocto) {
    try {
      const vault = await getVault(vaultId, ownerAccount);
      if (!vault || !vault.policy) return block(["no vault policy"]);
      const approved = [
        ...(vault.policy.allowed_recipients ?? []),
        ...(vault.one_time_recipients ?? []),
      ];
      const risk = assessRecipient({
        recipient,
        amountYocto,
        approved,
        perTxCap: BigInt(vault.policy.per_tx_cap),
        selfIds,
        blocklist: BLOCKLIST,
        paidBefore,
      });
      return { ...risk, allowed: risk.level !== "block" };
    } catch {
      return block(["risk check failed"]);
    }
  }

  // Execute through the existing executor, signed by the agent's locked key.
  async function pay(recipient, amountYocto) {
    const result = await executePayment(getAgent(), {
      vaultId,
      ownerId: ownerAccount,
      recipient,
      amountYocto,
    });
    if (result.ok) paidBefore.add(recipient);
    return result;
  }

  return { quote, pay };
}
