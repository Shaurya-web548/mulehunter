/**
 * Versioned boundary between the durable paise ledger and the legacy live
 * detector (lib/engine/detect.ts), whose thresholds are expressed in rupees.
 *
 * Direction is one-way: durable `amountMinor` (integer paise) → legacy rupee
 * `amount`, divided by 100 exactly once, here. Nothing converts a legacy rupee
 * value back into paise except `rupeesToMinor` in money.ts, which refuses
 * sub-paise input.
 */
import { PAISE_PER_RUPEE, assertMinor } from "./money.ts";

export const LEGACY_ADAPTER_VERSION = "legacy-rupee-view/v1";

/** Rupee view of an integer paise amount, for the 90 s live graph only. */
export function minorToLegacyRupees(amountMinor: number): number {
  return assertMinor(amountMinor, "amountMinor") / PAISE_PER_RUPEE;
}

export interface LegacyTxnView {
  id: string;
  ts: number;
  from: string;
  to: string;
  /** rupees (legacy unit) — derived, never persisted */
  amount: number;
  amountMinor: number;
}

export function toLegacyTxn(t: { txnId: string; ts: number; fromId: string; toId: string; amountMinor: number }): LegacyTxnView {
  return { id: t.txnId, ts: t.ts, from: t.fromId, to: t.toId, amount: minorToLegacyRupees(t.amountMinor), amountMinor: t.amountMinor };
}
