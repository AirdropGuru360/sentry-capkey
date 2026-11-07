// Store: payees (name->account) and receipts (append-only JSONL).
// Data directory holds payees.json and receipts.jsonl.
// Name: lowercase /^[a-z][a-z0-9_-]{1,19}$/; 20 payees max.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isValidAccountId } from "./amount.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".sentry");

function dataDir() {
  return process.env.SENTRY_DATA_DIR || DEFAULT_DATA_DIR;
}

function payeesPath(dir) {
  return path.join(dir, "payees.json");
}

function receiptsPath(dir) {
  return path.join(dir, "receipts.jsonl");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESERVED = new Set([
  "pay", "send", "to", "near", "the", "for", "status",
  "payee", "payees", "receipts", "quote", "treasury",
]);

function isValidName(name) {
  return /^[a-z][a-z0-9_-]{1,19}$/.test(name);
}

// Never throw: caller must guard.
function warn(msg) {
  // In production this would log; tests capture console.warn.
  // We just write to stderr so tests can inspect it, but don't crash.
  try { console.warn("store: " + msg); } catch {}
}

// checkAccount returns reason string or null.
function checkAccount(account, blocklist, selfIds) {
  if (!isPayeeAccount(account)) {
    return "account is not a valid NEAR account id";
  }
  if (blocklist && blocklist.includes(account)) {
    return "account is on the blocklist";
  }
  if (selfIds && selfIds.includes(account)) {
    return "account is one of the bot's own accounts";
  }
  return null;
}

// isPayeeAccount: valid account id AND either contains a dot (fully-qualified)
// or is a 64-char hex implicit account.
export function isPayeeAccount(account) {
  if (!isValidAccountId(account)) return false;
  if (account.includes(".")) return true;
  // 64-char hex implicit account
  return /^[0-9a-f]{64}$/.test(account);
}

// ---------------------------------------------------------------------------
// loadPayees
// ---------------------------------------------------------------------------

export function loadPayees(dir) {
  const p = payeesPath(dir);
  try {
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, "utf8");
    const obj = JSON.parse(raw);
    // Must be a plain object.
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
      warn("payees.json is malformed; ignoring");
      return {};
    }
    // Every entry: name must be valid, account must be valid.
    // Any bad entry makes the whole load return {}.
    for (const [name, account] of Object.entries(obj)) {
      if (typeof name !== "string" || typeof account !== "string") {
        warn("payees.json has an invalid entry; ignoring entire file");
        return {};
      }
      // name format
      const clean = name.toLowerCase();
      if (!isValidName(clean)) {
        warn("payees.json has an invalid entry; ignoring entire file");
        return {};
      }
      // account validity via isPayeeAccount (cannot disagree with checkAccount)
      if (isPayeeAccount(account) === false) {
        warn("payees.json has an invalid entry; ignoring entire file");
        return {};
      }
      // reserved word check (names are already lowered)
      if (RESERVED.has(clean)) {
        warn("payees.json has a reserved-word entry; ignoring entire file");
        return {};
      }
      // built-in alias check
      if (clean === "shop") {
        warn("payees.json has a built-in alias entry; ignoring entire file");
        return {};
      }
    }
    return obj; // { [name]: account }
  } catch (e) {
    // Bad JSON or any other read error.
    warn("payees.json could not be read; starting empty");
    return {};
  }
}

// ---------------------------------------------------------------------------
// addPayee
// ---------------------------------------------------------------------------

export function addPayee(dir, name, account, { blocklist, selfIds }) {
  // lowercase first, then validate format
  const clean = String(name).toLowerCase();
  if (!isValidName(clean)) {
    return { ok: false, reason: "name must be lowercase and match /^[a-z][a-z0-9_-]{1,19}$/" };
  }
  // reserved word check
  if (RESERVED.has(clean)) {
    return { ok: false, reason: "name is reserved" };
  }
  // built-in alias check
  if (clean === "shop") {
    return { ok: false, reason: "name conflicts with a built-in alias" };
  }
  // account validity
  const acctCheck = checkAccount(account, blocklist, selfIds);
  if (acctCheck) {
    return { ok: false, reason: acctCheck };
  }
  // Ensure data directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Load current payees to check count and duplicate
  const existing = loadPayees(dir);
  // Duplicate check
  if (existing && Object.hasOwn(existing, clean)) {
    return { ok: false, reason: "name already exists" };
  }
  // Max 20 payees
  const count = existing ? Object.keys(existing).length : 0;
  if (count >= 20) {
    return { ok: false, reason: "maximum of 20 payees reached" };
  }
  // Atomic write: write temp file then rename
  const newPayees = { ...existing, [clean]: account };
  const newRaw = JSON.stringify(newPayees, null, 2);
  const tmpPath = payeesPath(dir) + ".tmp";
  try {
    fs.writeFileSync(tmpPath, newRaw, "utf8");
    fs.renameSync(tmpPath, payeesPath(dir));
    return { ok: true, reason: null };
  } catch {
    // cleanup temp file if it exists
    try { fs.rmSync(tmpPath); } catch {}
    return { ok: false, reason: "could not write payees file" };
  }
}

// ---------------------------------------------------------------------------
// removePayee
// ---------------------------------------------------------------------------

export function removePayee(dir, name) {
  // lowercase first, then validate format
  const clean = String(name).toLowerCase();
  if (!isValidName(clean)) {
    return { ok: false, reason: "name must be lowercase and match /^[a-z][a-z0-9_-]{1,19}$/" };
  }
  // Ensure data directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const existing = loadPayees(dir);
  if (!existing || !Object.hasOwn(existing, clean)) {
    return { ok: false, reason: "name not found" };
  }
  const { [clean]: _, ...rest } = existing;
  const newPayees = rest;
  const newRaw = JSON.stringify(newPayees, null, 2);
  const tmpPath = payeesPath(dir) + ".tmp";
  try {
    fs.writeFileSync(tmpPath, newRaw, "utf8");
    fs.renameSync(tmpPath, payeesPath(dir));
    return { ok: true, reason: null };
  } catch {
    try { fs.rmSync(tmpPath); } catch {}
    return { ok: false, reason: "could not write payees file" };
  }
}

// ---------------------------------------------------------------------------
// appendReceipt
// ---------------------------------------------------------------------------

export function appendReceipt(dir, receipt) {
  const p = receiptsPath(dir);
  try {
    // Ensure dir exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Append JSON line
    const line = JSON.stringify(receipt) + "\n";
    fs.appendFileSync(p, line, "utf8");
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: "could not write receipt" };
  }
}

// ---------------------------------------------------------------------------
// readReceipts
// ---------------------------------------------------------------------------

export function readReceipts(dir, n) {
  const p = receiptsPath(dir);
  const lines = [];
  try {
    if (!fs.existsSync(p)) return lines;
    const raw = fs.readFileSync(p, "utf8");
    const allLines = raw.split("\n").filter((l) => l.trim() !== "");
    // Parse from the end, collect n valid ones
    const parsed = [];
    for (const line of allLines) {
      try {
        const obj = JSON.parse(line);
        if (typeof obj === "object" && obj !== null) {
          parsed.push(obj);
        }
        // skip bad lines silently
      } catch {
        // skip this line
      }
    }
    // Return the last n, newest first (without mutating)
    const sorted = [...parsed].reverse();
    return sorted.slice(0, n);
  } catch {
    return lines;
  }
}