// Client for the owner's paid site-check service.
// All HTTP goes through an injected fetch (default: global fetch) so this
// module can be tested without the network. Fail closed: bad config or a bad
// response is a refusal, never a payment.

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8787";
const PRICE_TIMEOUT_MS = 5_000;
const CHECK_TIMEOUT_MS = 10_000;
const POSITIVE_INTEGER = /^\d+$/;

function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

export function serviceConfig() {
  return {
    serviceUrl: (readEnv("SERVICE_URL") || DEFAULT_SERVICE_URL).replace(/\/$/, ""),
    serviceAccountId: readEnv("SERVICE_ACCOUNT_ID"),
  };
}

// GET /price with a 5 s timeout. Rejects unless the account matches exactly
// and the price is a positive integer string. Never throws.
export async function fetchPrice({ fetchFn = fetch, serviceUrl, serviceAccountId } = {}) {
  if (typeof serviceAccountId !== "string" || serviceAccountId === "") {
    return { ok: false, reason: "SERVICE_ACCOUNT_ID is not configured" };
  }
  let res;
  try {
    res = await fetchFn(`${serviceUrl}/price`, { signal: AbortSignal.timeout(PRICE_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, reason: `price request failed: ${err?.message ?? String(err)}` };
  }
  if (typeof res.status !== "number" || res.status < 200 || res.status >= 300) {
    return { ok: false, reason: `price request failed: HTTP ${res.status ?? "?"}` };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: "price response is not valid JSON" };
  }
  if (typeof data.account !== "string" || data.account !== serviceAccountId) {
    return { ok: false, reason: `price account is not ${serviceAccountId}` };
  }
  if (typeof data.priceYocto !== "string" || !POSITIVE_INTEGER.test(data.priceYocto)) {
    return { ok: false, reason: "price is not a positive integer string" };
  }
  if (BigInt(data.priceYocto) <= 0n) {
    return { ok: false, reason: "price is not a positive integer string" };
  }
  return { ok: true, priceYocto: data.priceYocto };
}

// GET /check?url=...&tx=... with a 10 s timeout. Never throws.
export async function fetchCheck({ fetchFn = fetch, serviceUrl, url, tx } = {}) {
  const query = new URLSearchParams({ url, tx }).toString();
  let res;
  try {
    res = await fetchFn(`${serviceUrl}/check?${query}`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, reason: `check request failed: ${err?.message ?? String(err)}` };
  }
  if (typeof res.status !== "number" || res.status < 200 || res.status >= 300) {
    return { ok: false, reason: `check request failed: HTTP ${res.status ?? "?"}` };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: "check response is not valid JSON" };
  }
  for (const key of ["status", "finalUrl", "tlsOk", "ms", "server"]) {
    if (!(key in data)) return { ok: false, reason: `check response is missing ${key}` };
  }
  return {
    ok: true,
    status: data.status,
    finalUrl: data.finalUrl,
    tlsOk: data.tlsOk,
    ms: data.ms,
    server: data.server,
  };
}
