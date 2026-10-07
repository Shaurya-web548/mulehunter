/**
 * Money helpers — integer INR paise (minor units) are the single representation
 * in the durable domain. This module is the ONLY place a legacy rupee `amount`
 * may be converted, and it is dotted with a documented rounding rule. Never
 * reinterpret an old rupee figure as paise elsewhere.
 */

/** Rupees are stored as paise (minor units) — `95.00` INR → `9500`. */
export const PAISE_PER_RUPEE = 100;

/** Integer cap for safe arithmetic (safe up to 2^53; we reserve headroom). */
export const MAX_SAFE_MINOR = 9_000_000_000_000_000; // 90e12 paise

export class MoneyError extends Error {}

function assertInt(n: number, what: string): void {
  if (!Number.isFinite(n)) throw new MoneyError(`${what} must be a finite number`);
  if (!Number.isInteger(n)) throw new MoneyError(`${what} must be an integer number of paise`);
  if (n < 0) throw new MoneyError(`${what} must not be negative`);
  if (n > MAX_SAFE_MINOR) throw new MoneyError(`${what} exceeds the safe paise range`);
}

/** Validate an already-minor (paise) value. Returns it unchanged or throws. */
export function assertMinor(n: number, what = "amount"): number {
  assertInt(n, what);
  return n;
}

/**
 * Convert a legacy rupee amount to paise.
 *
 * @param rupees      legacy whole-or-decimal rupee figure
 * @param rounding    rounding mode for sub-paise remainders.
 *                    "round" (default): banker-free `Math.round`. "floor": truncate down.
 * @param precision   max decimal places accepted (default 2 = paise).
 */
export function rupeesToMinor(rupees: number, rounding: "round" | "floor" = "round", precision = 2): number {
  if (!Number.isFinite(rupees)) throw new MoneyError("rupees must be a finite number");
  if (rupees < 0) throw new MoneyError("rupees must not be negative");
  // Reject over-precise inputs that would silently round away money.
  const scale = Math.pow(10, precision);
  const scaled = rupees * scale;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
    throw new MoneyError(`rupees has more than ${precision} decimal places; refusing to round ambiguously`);
  }
  const minor = rounding === "floor" ? Math.floor(scaled) : Math.round(scaled);
  return assertMinor(minor, "converted amount");
}

/** Format paise as an INR display string (e.g. `₹9,950`, `₹99.50`, `₹1.50 Cr`). */
export function minorToInr(minor: number): string {
  const rupees = minor / PAISE_PER_RUPEE;
  if (rupees >= 10_000_000) return `₹${(rupees / 10_000_000).toFixed(2)} Cr`;
  if (rupees >= 100_000) return `₹${(rupees / 100_000).toFixed(2)} L`;
  // Two decimals only when there is a sub-rupee component, so whole-rupee
  // amounts read as `₹9,950` and not `₹9,950.00`.
  const hasSub = Math.abs(rupees - Math.round(rupees)) > 1e-9;
  const formatted = hasSub
    ? rupees.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : rupees.toLocaleString("en-IN");
  return `₹${formatted}`;
}

/** Full paise→rupee rendering with trailing paise preserved (for amounts in tables). */
export function minorToInrFull(minor: number): string {
  const neg = minor < 0 ? "-" : "";
  const rupees = Math.floor(Math.abs(minor) / PAISE_PER_RUPEE);
  const paise = (Math.abs(minor) % PAISE_PER_RUPEE)
    .toString()
    .padStart(2, "0");
  return `${neg}₹${rupees.toLocaleString("en-IN")}.${paise}`;
}

/** Sum an array of minor values safely (throws if the total overflows). */
export function sumMinor(xs: number[]): number {
  let t = 0;
  for (const x of xs) {
    t += x;
    if (t > MAX_SAFE_MINOR) throw new MoneyError("sum exceeds the safe paise range");
  }
  return t;
}