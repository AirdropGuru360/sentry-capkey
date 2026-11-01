// Sentry entry point (milestone 1, step 2).
// Minimal Telegram bot. Every update is owner-only; strangers are ignored silently.
// Secrets come only from process.env. This file never reads a .env file.

import { Telegraf } from "telegraf";
import { isOwner, parseOwnerId } from "./owner.js";

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
