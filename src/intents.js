// NEAR Intents (1Click) dry quote. Price check only: dry is hard-coded to true,
// so no parameter can ever turn this into a real quote. Never throws.

const QUOTE_URL = "https://1click.chaindefuser.com/v0/quote";
const ORIGIN_ASSET = "nep141:wrap.near";
const DESTINATION_ASSET =
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const BASE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TIMEOUT_MS = 15_000;
const DEADLINE_MS = 10 * 60 * 1000;

const UNAVAILABLE = { ok: false, reason: "quote unavailable" };

export async function getDryQuote({ fetchFn = fetch, amountYocto, recipient, refundTo }) {
  try {
    if (typeof amountYocto !== "bigint" || amountYocto <= 0n) {
      return { ok: false, reason: "invalid amount" };
    }
    if (typeof recipient !== "string" || !BASE_ADDRESS.test(recipient)) {
      return { ok: false, reason: "invalid recipient" };
    }
    if (typeof refundTo !== "string" || refundTo.trim() === "") {
      return { ok: false, reason: "invalid refund address" };
    }

    const res = await fetchFn(QUOTE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        dry: true, // hard-coded: never a real quote
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: ORIGIN_ASSET,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: DESTINATION_ASSET,
        amount: amountYocto.toString(),
        refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + DEADLINE_MS).toISOString(),
      }),
    });

    if (res.status !== 200 && res.status !== 201) return UNAVAILABLE;

    let data;
    try {
      data = await res.json();
    } catch {
      return UNAVAILABLE;
    }

    const quote = data?.quote;
    if (!quote || typeof quote.amountOut !== "string" || !/^\d+$/.test(quote.amountOut)) {
      return UNAVAILABLE;
    }
    if (
      typeof quote.amountOutFormatted !== "string" ||
      !/^\d+(\.\d+)?$/.test(quote.amountOutFormatted)
    ) {
      return UNAVAILABLE;
    }
    if (
      typeof quote.timeEstimate !== "number" ||
      !Number.isFinite(quote.timeEstimate) ||
      quote.timeEstimate < 0 ||
      quote.timeEstimate > 3600
    ) {
      return UNAVAILABLE;
    }

    return {
      ok: true,
      receive: quote.amountOutFormatted,
      seconds: quote.timeEstimate,
    };
  } catch {
    return UNAVAILABLE;
  }
}
