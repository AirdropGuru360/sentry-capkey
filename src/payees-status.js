// Pure helper: format the /payees status lines.
// Called with the in-memory payees map and the vault response (or an error
// signal). No network, no Telegram: easy to test in isolation.
//
// vault argument:
//   { policy: { allowed_recipients: [...], ... }, one_time_recipients: [...] }
//   null/undefined  → status unknown (getVault failed or policy missing)

export function formatPayeesLines(payees, vault) {
  const entries = Object.entries(payees);
  if (entries.length === 0) return null; // caller replies "No payees saved."

  // Build the approved set from the vault response.
  let approved = null; // null means "unknown"
  if (vault && vault.policy) {
    approved = new Set([
      ...(vault.policy.allowed_recipients ?? []),
      ...(vault.one_time_recipients ?? []),
    ]);
  }

  return entries.map(([name, account]) => {
    let status;
    if (approved === null) {
      status = "status unknown";
    } else if (approved.has(account)) {
      status = "approved";
    } else {
      status = "not approved by vault";
    }
    return `${name} -> ${account} (${status})`;
  });
}
