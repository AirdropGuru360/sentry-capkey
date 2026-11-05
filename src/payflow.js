// Payment flow: /pay -> confirmation buttons -> single-use confirm -> execute_payment.
// Telegram-free on purpose: the clock, the id generator and executePayment are
// injected, so this file can be tested without a bot or the network.

import { randomUUID } from "node:crypto";
import { parseNear, isValidAccountId } from "./amount.js";
import { formatNear } from "./format.js";
import { FEE_BPS, computeFee } from "./fee.js";

export const TTL_MS = 60_000;
const USAGE =
  "Usage: /pay <amount> <recipient>, e.g. /pay 0.5 shop.wavecapkey.testnet";

// Accepts "/pay 0.5 shop.testnet" or a bare "0.5 shop.testnet".
// Fails closed on anything unclear.
export function parsePayCommand(text) {
  const parts = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length > 0 && /^\/pay(@\w+)?$/i.test(parts[0])) parts.shift();
  if (parts.length !== 2) return { ok: false, text: USAGE };

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
  return { ok: true, amountYocto, recipient };
}

// formatNear adds " NEAR"; the confirmation sentence adds it itself.
function nearText(amountYocto) {
  return formatNear(amountYocto, 24).replace(/ NEAR$/, "");
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
  async function safeAssess({ recipient, amountYocto }) {
    try {
      const risk = await assess({ recipient, amountYocto });
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
      expiresAt: now + ttlMs,
    });

    let prompt = `Pay ${nearText(parsed.amountYocto)} NEAR to ${parsed.recipient}? Expires in ${Math.round(
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
    if (fee > 0n) prompt += `\nFee: ${formatNear(fee, 24)} to treasury.`;
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

      let result;
      try {
        // Always the stored values, never anything from the button or a later message.
        result = await executePayment({
          recipient: entry.recipient,
          amountYocto: entry.amountYocto,
        });
      } catch {
        return { ok: false, text: "Payment failed." };
      }
      if (!result?.ok) return { ok: false, text: result?.reason ?? "Payment failed." };

      const link = (hash) => `https://explorer.testnet.near.org/transactions/${hash}`;
      const mainLink = link(result.txHash);

      // After a successful main payment nothing may throw: a fee problem is
      // reported, never retried, and never undoes the payment.
      let fee;
      try {
        fee = feeFor(entry.amountYocto);
      } catch {
        return {
          ok: true,
          txHash: result.txHash,
          recipient: entry.recipient,
          feeYocto: 0n,
          text: `Paid.\n${mainLink}\nFee not collected: fee error.`,
        };
      }

      if (fee === 0n) {
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
      try {
        const feeResult = await executePayment({ recipient: treasury, amountYocto: fee });
        if (feeResult?.ok && typeof feeResult.txHash === "string") {
          collectedFees += fee;
          feeTxHash = feeResult.txHash;
          feeText = `Fee: ${formatNear(fee, 24)} to treasury.\n${link(feeResult.txHash)}`;
        } else {
          feeText = `Fee not collected: ${feeResult?.reason ?? "payment failed"}`;
        }
      } catch {
        feeText = "Fee not collected: payment failed";
      }

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
