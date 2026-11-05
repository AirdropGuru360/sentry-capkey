// Plain-language mode: turns a short sentence into exactly one amount and one
// recipient. Rule-based and deterministic: no network, no model, no guessing.

import { parseNear, isValidAccountId } from "./amount.js";

const UNREADABLE = "I can't read that. Use /pay <amount> <recipient>.";

// A recipient must look like an account: an alias, a dotted name, or an implicit
// 64-character hex account. Plain words are never treated as recipients.
const HEX64 = /^[0-9a-f]{64}$/;

function unreadable() {
  return { ok: false, reason: UNREADABLE };
}

// Drops surrounding punctuation but keeps letters, digits, dots, dashes, underscores.
function clean(token) {
  return token.replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
}

export function proposeFromText(text, { aliases } = {}) {
  try {
    if (typeof text !== "string" || !aliases || typeof aliases !== "object") {
      return unreadable();
    }

    const aliasMap = new Map();
    for (const [name, account] of Object.entries(aliases)) {
      if (typeof name === "string" && typeof account === "string" && isValidAccountId(account)) {
        aliasMap.set(name.toLowerCase(), account);
      }
    }

    const tokens = text
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .map(clean)
      .filter(Boolean);

    const amounts = [];
    const recipients = [];

    for (const token of tokens) {
      let yocto = null;
      try {
        yocto = parseNear(token);
      } catch {
        yocto = null;
      }
      if (yocto !== null) {
        amounts.push(yocto);
        continue;
      }
      if (aliasMap.has(token)) {
        recipients.push(aliasMap.get(token));
      } else if (isValidAccountId(token) && (token.includes(".") || HEX64.test(token))) {
        recipients.push(token);
      }
    }

    if (amounts.length !== 1 || recipients.length !== 1) return unreadable();

    return { ok: true, amountYocto: amounts[0], recipient: recipients[0] };
  } catch {
    return unreadable();
  }
}
