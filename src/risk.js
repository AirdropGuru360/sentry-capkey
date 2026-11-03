// Rule-based risk check for a payment recipient. Pure: no network, no env, no clock.
// Fails closed: bad input or any thrown error becomes a block.

import { isValidAccountId } from "./amount.js";

const HEX64 = /^[0-9a-f]{64}$/;
const FAILED = "risk check failed";

// Levenshtein distance, two rows, no dependencies.
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function block(reasons) {
  return { level: "block", reasons };
}

export function assessRecipient(input) {
  try {
    const { recipient, amountYocto, approved, perTxCap, selfIds, blocklist, paidBefore } =
      input ?? {};

    const inputsOk =
      typeof recipient === "string" &&
      typeof amountYocto === "bigint" &&
      typeof perTxCap === "bigint" &&
      Array.isArray(approved) &&
      approved.every((x) => typeof x === "string") &&
      Array.isArray(selfIds) &&
      selfIds.every((x) => typeof x === "string") &&
      Array.isArray(blocklist) &&
      blocklist.every((x) => typeof x === "string") &&
      paidBefore instanceof Set;
    if (!inputsOk) return block([FAILED]);

    if (!isValidAccountId(recipient)) return block(["Invalid recipient account ID."]);

    const blocks = [];
    if (blocklist.includes(recipient)) blocks.push("Recipient is on the blocklist.");
    if (selfIds.includes(recipient)) blocks.push("Recipient is one of Sentry's own accounts.");
    // An exact match is approved: skip the lookalike check entirely, so two
    // similar approved accounts do not block each other.
    if (!approved.includes(recipient)) {
      for (const account of approved) {
        const distance = levenshtein(recipient, account);
        if (distance === 1 || distance === 2) {
          blocks.push(`Recipient is a lookalike of approved account ${account}.`);
        }
      }
    }
    if (blocks.length > 0) return block(blocks);

    const warnings = [];
    if (!paidBefore.has(recipient)) warnings.push("This is the first payment to this recipient.");
    if (amountYocto > perTxCap / 2n) warnings.push("This is more than half the per-payment limit.");
    if (HEX64.test(recipient)) warnings.push("Recipient looks like a raw key, not a named account.");

    return { level: warnings.length > 0 ? "warn" : "ok", reasons: warnings };
  } catch {
    return block([FAILED]);
  }
}
