// Paid "site check" HTTP service.
// Binds to 127.0.0.1 only. A caller pays NEAR to SERVICE_ACCOUNT_ID, then
// calls /check with the transaction hash. We verify the payment on-chain,
// make sure the hash was never used before, fetch the URL, and report.
//
// Env: SERVICE_ACCOUNT_ID, SERVICE_PRICE_YOCTO, RPC_URL, PAYER_ACCOUNT_ID,
//      SERVICE_PORT (default 8787), SERVICE_DATA_DIR (default ~/.sentry-service).

import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import net from "node:net";
import dns from "node:dns/promises";
import { pathToFileURL } from "node:url";
import { isValidAccountId } from "../src/amount.js";
import { verifyPayment } from "./verify.js";

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function normalizeConfig(options = {}) {
  const serviceAccount = options.serviceAccount;
  if (!isValidAccountId(serviceAccount)) {
    throw new Error("SERVICE_ACCOUNT_ID must be a valid NEAR account id");
  }

  const payerAccountId = options.payerAccountId;
  if (!isValidAccountId(payerAccountId)) {
    throw new Error("PAYER_ACCOUNT_ID must be a valid NEAR account id");
  }

  let priceYocto = null;
  try {
    priceYocto =
      typeof options.priceYocto === "bigint"
        ? options.priceYocto
        : BigInt(String(options.priceYocto));
  } catch {
    priceYocto = null;
  }
  if (priceYocto === null || priceYocto <= 0n) {
    throw new Error("SERVICE_PRICE_YOCTO must be a positive integer");
  }

  const rpcUrl = options.rpcUrl;
  if (typeof rpcUrl !== "string" || rpcUrl.trim() === "") {
    throw new Error("RPC_URL is required");
  }
  let parsedRpc;
  try {
    parsedRpc = new URL(rpcUrl);
  } catch {
    throw new Error("RPC_URL must be a valid URL");
  }
  if (parsedRpc.protocol !== "https:" && parsedRpc.protocol !== "http:") {
    throw new Error("RPC_URL must be http(s)");
  }

  const dataDir =
    options.dataDir ||
    process.env.SERVICE_DATA_DIR ||
    path.join(os.homedir(), ".sentry-service");

  return {
    serviceAccount,
    payerAccountId,
    priceYocto,
    rpcUrl,
    dataDir,
    fetchFn: typeof options.fetchFn === "function" ? options.fetchFn : fetch,
    lookupFn: typeof options.lookupFn === "function" ? options.lookupFn : dns.lookup,
    timeoutMs: Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000,
    maxRedirects:
      Number.isInteger(options.maxRedirects) && options.maxRedirects >= 0
        ? options.maxRedirects
        : 3,
    now: typeof options.now === "function" ? options.now : Date.now,
  };
}

// ---------------------------------------------------------------------------
// URL safety (https only; no localhost / loopback / link-local / private)
// ---------------------------------------------------------------------------

function isBlockedIpv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // documentation
  if (a === 203 && b === 0 && c === 113) return true; // documentation
  if (a >= 224) return true; // multicast + reserved
  return false;
}

// Parse an IPv6 literal into 16 bytes. Returns null if it is not valid.
function ipv6ToBytes(input) {
  let addr = input;
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);
  addr = addr.toLowerCase();

  // Turn an embedded IPv4 tail into two hex groups.
  if (addr.includes(".")) {
    const idx = addr.lastIndexOf(":");
    if (idx === -1) return null;
    const v4 = addr.slice(idx + 1);
    const parts = v4.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    addr = `${addr.slice(0, idx + 1)}${hi}:${lo}`;
  }

  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (s) => (s === "" ? [] : s.split(":"));
  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (left.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  if (right.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;

  let groups;
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    if (left.length !== 8) return null;
    groups = left;
  }

  const bytes = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

function isBlockedIpv6(ip) {
  const b = ipv6ToBytes(ip);
  if (!b) return true;
  if (b.every((x) => x === 0)) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
  if ((b[0] & 0xfe) === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7
  if (b[0] === 0xff) return true; // multicast
  const v4mapped =
    b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  if (v4mapped) return isBlockedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  return false;
}

export async function validateUrl(raw, lookupFn = dns.lookup) {
  try {
    if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "missing url" };

    let url;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: "invalid url" };
    }

    if (url.protocol !== "https:") return { ok: false, reason: "only https urls are allowed" };
    if (url.username !== "" || url.password !== "") {
      return { ok: false, reason: "credentials in url are not allowed" };
    }

    let host = url.hostname.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (host === "") return { ok: false, reason: "invalid url" };
    if (host === "localhost" || host.endsWith(".localhost")) {
      return { ok: false, reason: "localhost is not allowed" };
    }

    const literal = net.isIP(host);
    if (literal === 4) {
      if (isBlockedIpv4(host)) return { ok: false, reason: "private addresses are not allowed" };
      return { ok: true, url: url.href };
    }
    if (literal === 6) {
      if (isBlockedIpv6(host)) return { ok: false, reason: "private addresses are not allowed" };
      return { ok: true, url: url.href };
    }

    let addrs;
    try {
      addrs = await lookupFn(host, { all: true, verbatim: true });
    } catch {
      return { ok: false, reason: "could not resolve host" };
    }
    if (!Array.isArray(addrs) || addrs.length === 0) {
      return { ok: false, reason: "could not resolve host" };
    }

    for (const entry of addrs) {
      const address = typeof entry === "string" ? entry : entry?.address;
      if (typeof address !== "string" || address === "") {
        return { ok: false, reason: "could not resolve host" };
      }
      const family = net.isIP(address);
      if (family === 4) {
        if (isBlockedIpv4(address)) return { ok: false, reason: "host resolves to a private address" };
      } else if (family === 6) {
        if (isBlockedIpv6(address)) return { ok: false, reason: "host resolves to a private address" };
      } else {
        return { ok: false, reason: "could not resolve host" };
      }
    }

    return { ok: true, url: url.href };
  } catch {
    return { ok: false, reason: "invalid url" };
  }
}

// ---------------------------------------------------------------------------
// Used-hash store (atomic writes)
// ---------------------------------------------------------------------------

function usedPath(dataDir) {
  return path.join(dataDir, "used.json");
}

function readUsed(dataDir) {
  try {
    const file = usedPath(dataDir);
    if (!fs.existsSync(file)) return new Set();
    const raw = fs.readFileSync(file, "utf8");
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return null;
    return new Set(list.filter((x) => typeof x === "string"));
  } catch {
    return null;
  }
}

function writeUsed(dataDir, used) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = usedPath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...used]), "utf8");
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function header(res, name) {
  const h = res?.headers;
  if (typeof h?.get === "function") return h.get(name);
  return h?.[name] ?? null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createServer(options = {}) {
  const config = normalizeConfig(options);

  // One reservation at a time, so two requests cannot claim the same hash.
  let reserveTail = Promise.resolve();

  function reserveHash(hash) {
    const run = reserveTail.then(() => {
      const used = readUsed(config.dataDir);
      if (used === null) return { ok: false, reason: "payment store unavailable" };
      if (used.has(hash)) return { ok: false, reason: "transaction already used" };
      used.add(hash);
      try {
        writeUsed(config.dataDir, used);
      } catch {
        return { ok: false, reason: "payment store unavailable" };
      }
      return { ok: true };
    });
    reserveTail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async function fetchTarget(initialUrl) {
    let current = initialUrl;
    let redirects = 0;
    const started = config.now();

    while (true) {
      const res = await config.fetchFn(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": "SentrySiteCheck/1.0" },
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      const status = Number(res?.status);
      if (REDIRECT_STATUSES.has(status)) {
        const location = header(res, "location");
        if (!location) throw new Error("bad redirect");
        if (redirects >= config.maxRedirects) throw new Error("too many redirects");

        let next;
        try {
          next = new URL(location, current).href;
        } catch {
          throw new Error("bad redirect");
        }
        const checked = await validateUrl(next, config.lookupFn);
        if (!checked.ok) throw new Error(checked.reason);
        current = checked.url;
        redirects += 1;
        try {
          await res.body?.cancel?.();
        } catch {
          // ignore: the redirect response body is not needed
        }
        continue;
      }

      return {
        status,
        finalUrl: current,
        ms: config.now() - started,
        server: header(res, "server") ?? null,
      };
    }
  }

  async function handleCheck(req, res, urlObj) {
    const rawUrl = urlObj.searchParams.get("url");
    const txHash = urlObj.searchParams.get("tx");

    if (!rawUrl) return sendJson(res, 400, { error: "missing url" });
    if (!txHash || !TX_HASH.test(txHash)) {
      return sendJson(res, 400, { error: "invalid transaction hash" });
    }

    const checked = await validateUrl(rawUrl, config.lookupFn);
    if (!checked.ok) return sendJson(res, 400, { error: checked.reason });

    const paid = await verifyPayment({
      rpcUrl: config.rpcUrl,
      txHash,
      signerId: config.payerAccountId,
      serviceAccount: config.serviceAccount,
      minYocto: config.priceYocto,
      fetchFn: config.fetchFn,
    });
    if (!paid.ok) return sendJson(res, 402, { error: paid.reason });

    const reserved = await reserveHash(txHash);
    if (!reserved.ok) {
      const status = reserved.reason === "transaction already used" ? 409 : 500;
      return sendJson(res, status, { error: reserved.reason });
    }

    let result;
    try {
      result = await fetchTarget(checked.url);
    } catch {
      return sendJson(res, 502, { error: "fetch failed" });
    }

    return sendJson(res, 200, {
      url: rawUrl,
      status: result.status,
      finalUrl: result.finalUrl,
      tlsOk: result.finalUrl.startsWith("https://"),
      ms: result.ms,
      server: result.server,
    });
  }

  async function handle(req, res) {
    let urlObj;
    try {
      urlObj = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      return sendJson(res, 400, { error: "bad request" });
    }

    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });

    if (urlObj.pathname === "/price") {
      return sendJson(res, 200, {
        account: config.serviceAccount,
        priceYocto: config.priceYocto.toString(),
      });
    }
    if (urlObj.pathname === "/check") return handleCheck(req, res, urlObj);
    return sendJson(res, 404, { error: "not found" });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch(() => {
      try {
        sendJson(res, 500, { error: "internal error" });
      } catch {
        // response is already gone
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

async function main() {
  const port = Number(readEnv("SERVICE_PORT") || "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Site check cannot start: SERVICE_PORT must be a valid port.");
    process.exit(1);
  }

  let server;
  try {
    server = createServer({
      serviceAccount: readEnv("SERVICE_ACCOUNT_ID"),
      priceYocto: readEnv("SERVICE_PRICE_YOCTO"),
      rpcUrl: readEnv("RPC_URL"),
      payerAccountId: readEnv("PAYER_ACCOUNT_ID"),
      dataDir: readEnv("SERVICE_DATA_DIR") || undefined,
    });
  } catch (err) {
    console.error("Site check cannot start:", err.message);
    process.exit(1);
  }

  server.listen(port, "127.0.0.1", () => {
    console.log(`Site check listening on http://127.0.0.1:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Site check failed:", err?.message ?? err);
    process.exit(1);
  });
}
