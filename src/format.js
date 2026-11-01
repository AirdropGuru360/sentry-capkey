// Turn a yoctoNEAR string into readable NEAR. BigInt only, never floats.
const YOCTO = 10n ** 24n;

export function formatNear(value, decimals = 4) {
  const v = BigInt(value); // throws on bad input (fails closed)
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0");
  const shown = frac.slice(0, decimals).replace(/0+$/, "");
  return shown ? `${whole}.${shown} NEAR` : `${whole} NEAR`;
}
