// Bot fee: 50 basis points (0.5%). BigInt only, never floats.

export const FEE_BPS = 50;

export function computeFee(amountYocto, bps) {
  if (typeof amountYocto !== "bigint" || amountYocto <= 0n) {
    throw new Error("invalid amount");
  }
  if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 200) {
    throw new Error("invalid bps");
  }
  return (amountYocto * BigInt(bps)) / 10000n;
}

// Fee rounded UP: never understates the cost in a preview.
export function computeFeeCeil(amountYocto, bps) {
  if (typeof amountYocto !== "bigint" || amountYocto <= 0n) {
    throw new Error("invalid amount");
  }
  if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 200) {
    throw new Error("invalid bps");
  }
  return (amountYocto * BigInt(bps) + 9999n) / 10000n;
}
