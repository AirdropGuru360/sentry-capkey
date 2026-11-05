// Sentry entry point (milestone 1, step 2).
// Minimal Telegram bot. Every update is owner-only; strangers are ignored silently.
// Secrets come only from process.env. This file never reads a .env file.

import { Markup, Telegraf } from "telegraf";
import { isOwner, parseOwnerId } from "./owner.js";
import { getVault } from "./vault.js";
import { formatNear } from "./format.js";
import { isValidAccountId, parseNear } from "./amount.js";
import { createAgentAccount, executePayment } from "./pay.js";
import { bindExecutor, createPayflow } from "./payflow.js";
import { assessRecipient } from "./risk.js";
import { BLOCKLIST } from "./blocklist.js";
import { getDryQuote } from "./intents.js";
import { proposeFromText } from "./propose.js";
import { ALIASES } from "./aliases.js";

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
if (!isValidAccountId(vaultId) || !isValidAccountId(ownerAccount)) {
  console.error(
    "Sentry cannot start: VAULT_CONTRACT_ID and OWNER_ACCOUNT_ID must be valid NEAR account IDs.",
  );
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

// --- /pay wiring (all logic lives in payflow.js and risk.js) ---
let agent = null;
const getAgent = () =>
  (agent ??= createAgentAccount({
    keyFile: readEnv("AGENT_KEY_FILE"),
    accountId: readEnv("AGENT_ACCOUNT_ID"),
    rpcUrl: readEnv("NEAR_RPC_URL") || "https://archival-rpc.testnet.fastnear.com",
  }));

// Recipients paid successfully in this run. First-time payments get a warning.
const paidBefore = new Set();
const selfIds = [vaultId, ownerAccount, readEnv("AGENT_ACCOUNT_ID")].filter(Boolean);

async function assess({ recipient, amountYocto }) {
  try {
    const vault = await getVault(vaultId, ownerAccount);
    if (!vault.policy) return { level: "block", reasons: ["risk check failed"] };
    const approved = [
      ...(vault.policy.allowed_recipients ?? []),
      ...(vault.one_time_recipients ?? []),
    ];
    return assessRecipient({
      recipient,
      amountYocto,
      approved,
      perTxCap: BigInt(vault.policy.per_tx_cap),
      selfIds,
      blocklist: BLOCKLIST,
      paidBefore,
    });
  } catch {
    return { level: "block", reasons: ["risk check failed"] };
  }
}

const payflow = createPayflow({
  clock: () => Date.now(),
  assess,
  executePayment: bindExecutor({ getAgent, vaultId, ownerId: ownerAccount, executePayment }),
});

// One payment path for /pay and for plain-language messages.
async function startPayment(ctx, payload) {
  const r = await payflow.request(payload);
  if (!r.ok) return ctx.reply(r.text);
  await ctx.reply(
    r.text,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Confirm", `confirm:${r.id}`),
        Markup.button.callback("Cancel", `cancel:${r.id}`),
      ],
    ]),
  );
}

bot.command("pay", (ctx) => startPayment(ctx, ctx.payload));

// Plain-language mode, e.g. "pay shop 0.5". Rule-based; same payflow as /pay,
// so the risk check, confirmation, expiry and vault rules all still apply.
bot.on("text", async (ctx, next) => {
  if (ctx.message.text.startsWith("/")) return next();
  const p = proposeFromText(ctx.message.text, { aliases: ALIASES });
  if (!p.ok) return ctx.reply(p.reason);
  const amount = formatNear(p.amountYocto, 24).replace(/ NEAR$/, "");
  return startPayment(ctx, `${amount} ${p.recipient}`);
});

bot.action(/^(confirm|cancel):([A-Za-z0-9-]{1,64})$/, async (ctx) => {
  const [, action, id] = ctx.match;
  await ctx.answerCbQuery();
  const r = action === "confirm" ? await payflow.confirm(id) : payflow.cancel(id);
  if (r.ok && r.recipient) paidBefore.add(r.recipient);
  await ctx.reply(r.text);
});

bot.command("quote", async (ctx) => {
  const [amount, recipient] = (ctx.payload ?? "").trim().split(/\s+/);
  const refundTo = readEnv("INTENTS_REFUND_TO");
  let amountYocto;
  try {
    amountYocto = parseNear(amount);
  } catch {
    return ctx.reply("quote unavailable");
  }
  const q = refundTo ? await getDryQuote({ amountYocto, recipient, refundTo }) : { ok: false };
  if (!q.ok) return ctx.reply("quote unavailable");
  await ctx.reply(
    `Live Intents quote (price check only, NOT executed): ${amount} NEAR (as wNEAR) -> about ${q.receive} USDC on Base, about ${q.seconds} seconds. No funds were moved.`,
  );
});

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
