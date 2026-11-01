// Sentry entry point (milestone 1, step 2).
// Minimal Telegram bot. Every update is owner-only; strangers are ignored silently.
// Secrets come only from process.env. This file never reads a .env file.

import { Telegraf } from "telegraf";
import { isOwner, parseOwnerId } from "./owner.js";
import { getVault } from "./vault.js";
import { formatNear } from "./format.js";

function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

// Fail closed: refuse to start on missing or invalid config.
const rawOwnerId = readEnv("OWNER_TELEGRAM_ID");
const ownerId = parseOwnerId(rawOwnerId);
if (ownerId === null) {
  console.error(
    rawOwnerId === ""
      ? "Sentry cannot start: OWNER_TELEGRAM_ID is empty."
      : "Sentry cannot start: OWNER_TELEGRAM_ID must be a numeric Telegram user ID.",
  );
  process.exit(1);
}

const botToken = readEnv("TELEGRAM_BOT_TOKEN");
if (botToken === "") {
  console.error("Sentry cannot start: TELEGRAM_BOT_TOKEN is empty.");
  process.exit(1);
}

const vaultId = readEnv("VAULT_CONTRACT_ID");
const ownerAccount = readEnv("OWNER_ACCOUNT_ID");
if (vaultId === "" || ownerAccount === "") {
  console.error("Sentry cannot start: VAULT_CONTRACT_ID or OWNER_ACCOUNT_ID is empty.");
  process.exit(1);
}

console.log("Sentry starting");

const bot = new Telegraf(botToken);

// Owner-only gate. Runs before every handler, for commands and plain messages.
// Non-owners get no reply and no further processing.
bot.use((ctx, next) => {
  const senderId = ctx.from?.id;
  if (!isOwner(senderId, ownerId)) {
    console.log(`Ignored update from non-owner user ${senderId ?? "unknown"}`);
    return;
  }
  return next();
});

bot.start((ctx) => ctx.reply("Sentry online"));

bot.command("status", async (ctx) => {
  try {
    const v = await getVault(vaultId, ownerAccount);
    const lines = [
      `Vault: ${vaultId}`,
      `Agent: ${v.agent}${v.revoked ? " (REVOKED)" : ""}`,
      `Balance: ${formatNear(v.balance)}`,
      `Spent today: ${formatNear(v.spent_in_window)}`,
      `Remaining today: ${formatNear(v.remaining_today)}`,
    ];
    if (v.policy) {
      lines.push(
        `Max per payment: ${formatNear(v.policy.per_tx_cap)}`,
        `Daily limit: ${formatNear(v.policy.daily_limit)}`,
        `Approved: ${v.policy.allowed_recipients.join(", ") || "none"}`,
      );
    } else {
      lines.push("No policy set.");
    }
    const once = v.one_time_recipients ?? [];
    lines.push(`One-time approvals: ${once.join(", ") || "none"}`);
    await ctx.reply(lines.join("\n"));
  } catch (err) {
    console.error("/status failed:", err.message);
    await ctx.reply("Could not read the vault. Try again.");
  }
});

// Graceful stop, as shown in the Telegraf docs.
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

try {
  await bot.launch();
  console.log(`Sentry online as @${bot.botInfo.username}`);
} catch (err) {
  // Fail closed: if Telegram cannot be reached, exit instead of running half-alive.
  console.error("Sentry failed to start:", err.message);
  process.exit(1);
}
