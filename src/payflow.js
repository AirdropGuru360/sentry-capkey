// Payment flow: /pay -> confirmation buttons -> single-use confirm -> execute_payment.
// Telegram-free on purpose: the clock, the id generator and executePayment are
// injected, so this file can be tested without a bot or the network.

import { randomUUID } from "node:crypto";
import { parseNear, isValidAccountId } from "./amount.js";
import { formatNear } from "./format.js";
import { FEE_BPS, computeFee } from "./fee.js";

export const TTL_MS = 60_000;
const USAGE =
  "Usage: /pay <amount> <recipient> [wnear|near], e.g. /pay 0.5 shop.wavecapkey.testnet wnear";

// Accepts "/pay 0.5 shop.testnet" or a bare "0.5 shop.testnet", with an
// optional trailing token word: "wnear" for wNEAR (wrap.testnet), "near" for
// NEAR (the default). Fails closed on anything unclear.
export function parsePayCommand(text) {
  const parts = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length > 0 && /^\/pay(@\w+)?$/i.test(parts[0])) parts.shift();
  if (parts.length < 2 || parts.length > 3) return { ok: false, text: USAGE };

  let token;
  if (parts.length === 3) {
    const word = parts[2].toLowerCase();
    if (word === "wnear") token = "wnear";
    else if (word === "near") token = undefined;
    else return { ok: false, text: `Unknown token "${parts[2]}". ${USAGE}` };
  }

  const [rawAmount, recipient] = parts;
  let amountYocto;
  try {
    amountYocto = parseNear(rawAmount);
  } catch {
    return { ok: false, text: "Invalid amount. Use a number like 0.5" };
  }
  if (!isValidAccountId(recipient)) {
    return { ok: false, text: "Invalid recipient account ID." };
  }
  return { ok: true, amountYocto, recipient, token };
}

// formatNear adds " NEAR"; the confirmation sentence adds the token itself.
function nearText(amountYocto) {
  return formatNear(amountYocto, 24).replace(/ NEAR$/, "");
}

function tokenLabel(token) {
  return token === "wnear" ? "wNEAR" : "NEAR";
}

function txLink(hash) {
  return `https://explorer.testnet.near.org/transactions/${hash}`;
}

// Binds config and the account to the executor, so payflow stays config-free.
// executePayment always receives { vaultId, ownerId, recipient, amountYocto }.
export function bindExecutor({ getAgent, vaultId, ownerId, executePayment }) {
  return (payment) => executePayment(getAgent(), { ...payment, vaultId, ownerId });
}

export function createPayflow({
  clock,
  executePayment,
  assess,
  treasury,
  feeBps = FEE_BPS,
  ttlMs = TTL_MS,
  newId = () => randomUUID(),
  onPaid,
}) {
  const pending = new Map();
  let collectedFees = 0n;

  // A fee exists only when a treasury is configured. Without one, nothing changes.
  const feeOn = typeof treasury === "string" && treasury !== "";
  function feeFor(amountYocto) {
    return feeOn ? computeFee(amountYocto, feeBps) : 0n;
  }

  // One payment at a time. Confirmations go through this queue, so two taps
  // can never reach the vault in parallel.
  let tail = Promise.resolve();
  function enqueue(task) {
    const result = tail.then(task);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  // The risk check is injected. Any failure is a block: never pay "just in case".
  async function safeAssess(entry) {
    try {
      const risk = await assess(entry);
      const levels = ["ok", "warn", "block"];
      if (!risk || !levels.includes(risk.level) || !Array.isArray(risk.reasons)) {
        return { level: "block", reasons: ["risk check failed"] };
      }
      return risk;
    } catch {
      return { level: "block", reasons: ["risk check failed"] };
    }
  }

  function blockText(reasons) {
    return `Blocked. ${reasons.join(" ")}`;
  }

  async function request(text) {
    const parsed = parsePayCommand(text);
    if (!parsed.ok) return parsed;

    const risk = await safeAssess(parsed);
    if (risk.level === "block") return { ok: false, text: blockText(risk.reasons) };

    // Drop expired entries so the store cannot grow forever.
    const now = clock();
    for (const [key, entry] of pending) {
      if (now > entry.expiresAt) pending.delete(key);
    }

    const id = newId();
    pending.set(id, {
      amountYocto: parsed.amountYocto,
      recipient: parsed.recipient,
      token: parsed.token,
      expiresAt: now + ttlMs,
    });

    let prompt = `Pay ${nearText(parsed.amountYocto)} ${tokenLabel(parsed.token)} to ${parsed.recipient}? Expires in ${Math.round(
      ttlMs / 1000,
    )} seconds.`;
    if (risk.level === "warn") {
      prompt += `\n\nWarnings:\n${risk.reasons.map((r) => `- ${r}`).join("\n")}`;
    }
    let fee = 0n;
    try {
      fee = feeFor(parsed.amountYocto);
    } catch {
      fee = 0n; // the confirm step reports the fee error
    }
    if (fee > 0n) prompt += `\nFee: ${nearText(fee)} ${tokenLabel(parsed.token)} to treasury.`;
    return { ok: true, id, text: prompt };
  }

  function confirm(id) {
    return enqueue(async () => {
      const entry = pending.get(id);
      pending.delete(id); // single use: even a failed attempt cannot be retried
      if (!entry) return { ok: false, text: "This payment is no longer pending." };
      if (clock() > entry.expiresAt) {
        return { ok: false, text: "This payment expired. Send /pay again." };
      }

      // Check again right before paying: rules or approvals may have changed.
      const risk = await safeAssess(entry);
      if (risk.level === "block") return { ok: false, text: blockText(risk.reasons) };

      const payment = { recipient: entry.recipient, amountYocto: entry.amountYocto };
      if (entry.token) payment.token = entry.token;

      let result;
      try {
        // Always the stored values, never anything from the button or a later message.
        result = await executePayment(payment);
      } catch {
        return { ok: false, text: "Payment failed." };
      }
      if (!result?.ok) {
        const link = typeof result.txHash === "string" ? `\n${txLink(result.txHash)}` : "";
        return { ok: false, text: `${result?.reason ?? "Payment failed."}${link}` };
      }

      const mainLink = txLink(result.txHash);

      // After a successful main payment nothing may throw: a fee problem is
      // reported, never retried, and never undoes the payment.
      let fee;
      try {
        fee = feeFor(entry.amountYocto);
      } catch {
        // Fee computation failed; still report the main payment as paid.
        // onPaid is called below after the helper is defined.
        fee = null;
      }

      // Helper: call onPaid after success. Never throws, never changes the result.
      async function notifyPaid(info) {
        if (typeof onPaid !== "function") return;
        try { await onPaid(info); } catch {}
      }

      if (fee === null) {
        await notifyPaid({
          recipient: entry.recipient,
          amountYocto: entry.amountYocto,
          token: entry.token,
          txHash: result.txHash,
          feeYocto: 0n,
          feeTxHash: undefined,
        });
        return {
          ok: true,
          txHash: result.txHash,
          recipient: entry.recipient,
          feeYocto: 0n,
          text: `Paid.\n${mainLink}\nFee not collected: fee error.`,
        };
      }

      if (fee === 0n) {
        const info = {
          recipient: entry.recipient,
          amountYocto: entry.amountYocto,
          token: entry.token,
          txHash: result.txHash,
          feeYocto: 0n,
          feeTxHash: undefined,
        };
        await notifyPaid(info);
        return {
          ok: true,
          txHash: result.txHash,
          recipient: entry.recipient,
          feeYocto: 0n,
          text: `Paid.\n${mainLink}`,
        };
      }

      // The treasury is fixed configuration, so the fee skips the risk check.
      // One attempt only: a failed fee is reported and never retried.
      let feeText;
      let feeTxHash;
      const feePayment = { recipient: treasury, amountYocto: fee };
      if (entry.token) feePayment.token = entry.token;
      try {
        const feeResult = await executePayment(feePayment);
        if (feeResult?.ok && typeof feeResult.txHash === "string") {
          collectedFees += fee;
          feeTxHash = feeResult.txHash;
          feeText = `Fee: ${nearText(fee)} ${tokenLabel(entry.token)} to treasury.\n${txLink(feeResult.txHash)}`;
        } else {
          feeText = `Fee not collected: ${feeResult?.reason ?? "payment failed"}`;
        }
      } catch {
        feeText = "Fee not collected: payment failed";
      }

      const finalInfo = {
        recipient: entry.recipient,
        amountYocto: entry.amountYocto,
        token: entry.token,
        txHash: result.txHash,
        feeYocto: feeTxHash ? fee : 0n,
        feeTxHash,
      };
      await notifyPaid(finalInfo);
      return {
        ok: true,
        txHash: result.txHash,
        recipient: entry.recipient,
        feeYocto: fee,
        feeTxHash,
        text: `Paid.\n${mainLink}\n${feeText}`,
      };
    });
  }

  function cancel(id) {
    const had = pending.delete(id);
    return { ok: true, text: had ? "Payment cancelled." : "This payment is no longer pending." };
  }

  return { request, confirm, cancel, getCollectedFees: () => collectedFees };
}
