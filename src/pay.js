import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, getTransactionLastResult } from "near-api-js";
import { isValidAccountId } from "./amount.js";

const GAS = 100000000000000n; // 100 TGas

export function createAgentAccount({ keyFile, accountId, rpcUrl }) {
  const privateKey = JSON.parse(readFileSync(keyFile, "utf8")).private_key;
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return new Account(accountId, provider, privateKey);
}

// The vault's own refusal text, e.g. "recipient is not on the approved list"
export function refusalReason(err) {
  const msg = String(err?.message ?? err);
  const m = msg.match(/capkey: ([^"\n]*)/);
  return m ? m[1].trim() : "result unknown, check /status before trying again";
}

// token: undefined → NEAR (execute_payment), "wnear" → wNEAR (execute_ft_payment).
// execute_ft_payment returns true when the transfer went out and false when it
// failed and was refunded: false is a failed payment, never "Paid".
export async function executePayment(account, { vaultId, ownerId, recipient, amountYocto, token }) {
  if (isValidAccountId(recipient) === false) {
    return { ok: false, reason: "invalid recipient" };
  }
  if (typeof amountYocto !== "bigint" || amountYocto <= 0n) {
    return { ok: false, reason: "invalid amount" };
  }
  if (token !== undefined && token !== "wnear") {
    return { ok: false, reason: "only wNEAR (wrap.testnet) is accepted" };
  }
  try {
    const methodName = token === "wnear" ? "execute_ft_payment" : "execute_payment";
    const r = await account.callFunctionRaw({
      contractId: vaultId,
      methodName,
      args: { owner: ownerId, recipient, amount: amountYocto.toString() },
      gas: GAS,
    });
    const txHash = r?.transaction?.hash;
    if (typeof txHash !== "string") {
      return { ok: false, reason: "no transaction hash returned" };
    }
    if (token === "wnear") {
      // The contract returns JSON (base64-encoded SuccessValue): true = paid
      // out, false = failed and refunded. Anything else is unclear, never Paid.
      const returned = getTransactionLastResult(r);
      if (returned === true) {
        return { ok: true, txHash };
      }
      if (returned === false) {
        return { ok: false, reason: "transfer failed and was refunded", txHash };
      }
      return { ok: false, reason: "result unclear, check the explorer", txHash };
    }
    return { ok: true, txHash };
  } catch (err) {
    return { ok: false, reason: refusalReason(err) };
  }
}
