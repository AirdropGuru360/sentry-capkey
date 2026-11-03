// Payment flow: /pay -> confirmation buttons -> single-use confirm -> execute_payment.
// Telegram-free on purpose: the clock, the id generator and executePayment are
// injected, so this file can be tested without a bot or the network.

import { randomUUID } from "node:crypto";
import { parseNear, isValidAccountId } from "./amount.js";
import { formatNear } from "./format.js";

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
  ttlMs = TTL_MS,
  newId = () => randomUUID(),
}) {
  const pending = new Map();

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

  function request(text) {
    const parsed = parsePayCommand(text);
    if (!parsed.ok) return parsed;

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
    return {
      ok: true,
      id,
      text: `Pay ${nearText(parsed.amountYocto)} NEAR to ${parsed.recipient}? Expires in ${Math.round(
        ttlMs / 1000,
      )} seconds.`,
    };
  }

  function confirm(id) {
    return enqueue(async () => {
      const entry = pending.get(id);
      pending.delete(id); // single use: even a failed attempt cannot be retried
      if (!entry) return { ok: false, text: "This payment is no longer pending." };
      if (clock() > entry.expiresAt) {
        return { ok: false, text: "This payment expired. Send /pay again." };
      }

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
      return {
        ok: true,
        txHash: result.txHash,
        text: `Paid. https://explorer.testnet.near.org/transactions/${result.txHash}`,
      };
    });
  }

  function cancel(id) {
    const had = pending.delete(id);
    return { ok: true, text: had ? "Payment cancelled." : "This payment is no longer pending." };
  }

  return { request, confirm, cancel };
}
