// Read-only treasury balance. Same RPC as src/vault.js. Never throws.

const RPC_URL =
  process.env.NEAR_RPC_URL ?? "https://archival-rpc.testnet.fastnear.com";

export async function getBalance(accountId, fetchFn = fetch) {
  try {
    if (typeof accountId !== "string" || accountId === "") return { ok: false };

    const res = await fetchFn(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "sentry",
        method: "query",
        params: {
          request_type: "view_account",
          finality: "final",
          account_id: accountId,
        },
      }),
    });

    if (res.status !== 200) return { ok: false };

    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false };
    }

    const amount = data?.result?.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) return { ok: false };

    return { ok: true, yocto: BigInt(amount) };
  } catch {
    return { ok: false };
  }
}
