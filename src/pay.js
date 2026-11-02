import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider } from "near-api-js";
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
  return m ? m[1].trim() : "payment failed";
}

export async function executePayment(account, { vaultId, ownerId, recipient, amountYocto }) {
  if (isValidAccountId(recipient) === false) {
    return { ok: false, reason: "invalid recipient" };
  }
  if (typeof amountYocto !== "bigint" || amountYocto <= 0n) {
    return { ok: false, reason: "invalid amount" };
  }
  try {
    const r = await account.callFunctionRaw({
      contractId: vaultId,
      methodName: "execute_payment",
      args: { owner: ownerId, recipient, amount: amountYocto.toString() },
      gas: GAS,
    });
    const txHash = r?.transaction?.hash;
    if (typeof txHash !== "string") {
      return { ok: false, reason: "no transaction hash returned" };
    }
    return { ok: true, txHash };
  } catch (err) {
    return { ok: false, reason: refusalReason(err) };
  }
}
