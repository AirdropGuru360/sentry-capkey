// /buy check <url>: pay the configured site-check service for a URL check,
// then ask the service to verify the payment on-chain.
// No Telegram here: pure functions plus an explicit state object, so every
// step can be tested without a bot or the network.

import { fetchCheck } from "./service.js";

const USAGE = "Usage: /buy check <https url>";

export { USAGE };

export function parseBuyCommand(text) {
  const parts = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  // Accept both "/buy check <url>" and the raw Telegraf payload "check <url>".
  if (/^\/buy(@\w+)?$/i.test(parts[0] ?? "")) parts.shift();
  if (parts.length < 2 || parts[0] !== "check") return { ok: false, text: USAGE };
  const url = (parts.slice(1).join(" ") ?? "").trim();
  if (!url) return { ok: false, text: USAGE };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, text: "Only https URLs are supported." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, text: "Only https URLs are supported." };
  }
  return { ok: true, url: parsed.toString() };
}

export function buyState() {
  return { url: null, check: null };
}

// Hook for the bot's onPaid callback: after a successful payment to the
// service account, verify it with the service's /check endpoint. Never throws.
// check.ok === true means the service responded; check.ok === false means the
// service call itself failed (network, timeout, bad response).
export async function onPaidCheck({ state, recipient, txHash, fetchFn, serviceUrl, serviceAccountId }) {
  if (!state.url || recipient !== serviceAccountId) {
    state.check = null;
    return null;
  }
  try {
    state.check = await fetchCheck({ fetchFn, serviceUrl, url: state.url, tx: txHash });
  } catch (error) {
    state.check = { ok: false, error };
  }
  return state.check;
}

// Assemble the reply after payflow.confirm returned (onPaid has already run).
export function buyReplyText({ paid, check }) {
  const link = (hash) => `https://explorer.testnet.near.org/transactions/${hash}`;
  if (!check) return paid.text;
  if (check.ok) {
    return (
      paid.text +
      `\n\nSite check:\nstatus: ${check.status}\nfinal URL: ${check.finalUrl}\nTLS ok: ${check.tlsOk}\n${check.ms} ms\nserver: ${check.server}`
    );
  }
  return (
    paid.text +
    `\n\nPayment went through: ${paid.txHash}\n${link(paid.txHash)}\nSite check failed: ${check.reason ?? check.error ?? String(
      check.error,
    )}. Not retrying automatically.`
  );
}
