// Sentry entry point (milestone 1, step 1).
// Loads environment variables and confirms the bot can start. No network calls.

// Fail closed: if a required variable is missing, stop instead of guessing.
const required = ["OWNER_TELEGRAM_ID"];

const missing = required.filter((name) => {
  const value = process.env[name];
  return value === undefined || value.trim() === "";
});

if (missing.length > 0) {
  console.error(`Sentry cannot start: missing env var(s): ${missing.join(", ")}`);
  console.error("Copy .env.example to .env and fill in the values.");
  process.exit(1);
}

// Never print secret values. Only report which variables are present.
const optional = ["TELEGRAM_BOT_TOKEN", "VAULT_CONTRACT_ID", "AGENT_ACCOUNT_ID"];
const present = optional.filter((name) => (process.env[name] ?? "").trim() !== "");

console.log("Sentry starting");
console.log(`Owner Telegram ID set: yes`);
console.log(`Other config loaded: ${present.length > 0 ? present.join(", ") : "none yet"}`);
