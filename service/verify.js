// Verify a NEAR payment for the site-check service.
// Read-only: it asks a NEAR RPC node for a finalized transaction and checks
// that the expected payer signed it and that the service account received
// at least the expected deposit. Never throws.
//
// Request shape (official NEAR JSON-RPC docs, EXPERIMENTAL_tx_status):
//   { jsonrpc: "2.0", id, method: "EXPERIMENTAL_tx_status",
//     params: { tx_hash, sender_account_id, wait_until: "FINAL" } }
// Response result is a FinalExecutionOutcomeWithReceiptView:
//   result.status = { SuccessValue } | { Failure } | "NotStarted" | "Started"
//   result.transaction.signer_id
//   result.receipts[].receiver_id
//   result.receipts[].receipt.Action.actions[].Transfer.deposit (string yocto)

const RPC_TIMEOUT_MS = 10_000;

function fail(reason) {
  return { ok: false, reason };
}

// Accept a bigint or a decimal string; reject everything else.
function toYocto(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

export async function verifyPayment({
  rpcUrl,
  txHash,
  signerId,
  serviceAccount,
  minYocto,
  fetchFn = fetch,
}) {
  try {
    if (typeof rpcUrl !== "string" || rpcUrl.trim() === "") return fail("rpc not configured");
    if (typeof txHash !== "string" || txHash.trim() === "") return fail("missing transaction hash");
    if (typeof signerId !== "string" || signerId.trim() === "") return fail("missing payer");
    if (typeof serviceAccount !== "string" || serviceAccount.trim() === "") {
      return fail("missing service account");
    }

    const min = toYocto(minYocto);
    if (min === null || min < 0n) return fail("invalid price");

    const body = {
      jsonrpc: "2.0",
      id: "sentry-site-check",
      method: "EXPERIMENTAL_tx_status",
      params: {
        tx_hash: txHash,
        sender_account_id: signerId,
        wait_until: "FINAL",
      },
    };

    let res;
    try {
      res = await fetchFn(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
    } catch {
      return fail("rpc unavailable");
    }

    if (!res || res.status !== 200) return fail("rpc error");

    let data;
    try {
      data = await res.json();
    } catch {
      return fail("rpc error");
    }

    if (data?.error) return fail("rpc error");
    const result = data?.result;
    if (!result || typeof result !== "object") return fail("transaction not found");

    // Only a finalized successful transaction counts.
    const status = result.status;
    if (typeof status !== "object" || status === null || !Object.hasOwn(status, "SuccessValue")) {
      return fail("transaction failed");
    }

    if (result.transaction?.signer_id !== signerId) return fail("wrong signer");

    const receipts = Array.isArray(result.receipts) ? result.receipts : null;
    if (!receipts) return fail("payment not found");

    let sawServiceReceipt = false;
    let sawTransfer = false;

    for (const receipt of receipts) {
      if (!receipt || receipt.receiver_id !== serviceAccount) continue;
      sawServiceReceipt = true;

      // Official shape nests actions under receipt.Action.actions.
      // Older/other clients may expose actions directly; accept both.
      const actions = receipt.receipt?.Action?.actions ?? receipt.actions;
      if (!Array.isArray(actions)) continue;

      for (const action of actions) {
        const deposit = action?.Transfer?.deposit;
        if (typeof deposit !== "string") continue;
        sawTransfer = true;

        let amount;
        try {
          amount = BigInt(deposit);
        } catch {
          continue;
        }
        if (amount >= min) return { ok: true };
      }
    }

    if (!sawServiceReceipt) return fail("wrong receiver");
    if (!sawTransfer) return fail("payment not found");
    return fail("payment too small");
  } catch {
    return fail("verification failed");
  }
}
