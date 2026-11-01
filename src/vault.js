// Read-only call to the vault contract (no keys needed)
const RPC_URL =
  process.env.NEAR_RPC_URL ?? "https://archival-rpc.testnet.fastnear.com";

export async function getVault(vaultId, ownerId) {
  const args = Buffer.from(JSON.stringify({ owner: ownerId })).toString("base64");
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "sentry",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: vaultId,
        method_name: "get_vault",
        args_base64: args,
      },
    }),
  });
  const data = await res.json();
  if (data.error || !data.result?.result) throw new Error("get_vault failed");
  return JSON.parse(Buffer.from(data.result.result).toString("utf8"));
}
