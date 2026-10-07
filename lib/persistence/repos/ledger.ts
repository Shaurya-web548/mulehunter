import type { Account, RejectReason } from "../../contracts/types.ts";

/**
 * Pure, transaction-free admission rule that decides accept/reject. It never
 * mutates state; the caller applies the verdict inside a write transaction.
 * Keeping the decision pure makes it trivially testable.
 */
export function decideAdmission(args: {
  from: Account | null;
  to: Account | null;
  amountMinor: number;
  activeHoldId: string | null;
}): { status: "ACCEPTED" | "REJECTED"; rejectReason: RejectReason | null; holdId: string | null } {
  const { from, to, amountMinor, activeHoldId } = args;
  if (!from || !to) return { status: "REJECTED", rejectReason: "INVALID", holdId: null };
  if (from.id === to.id) return { status: "REJECTED", rejectReason: "SELF_TRANSFER", holdId: null };
  if (amountMinor <= 0) return { status: "REJECTED", rejectReason: "INVALID", holdId: null };
  if (activeHoldId) return { status: "REJECTED", rejectReason: "HOLD", holdId: activeHoldId };
  if (from.balanceMinor < amountMinor) return { status: "REJECTED", rejectReason: "INSUFFICIENT_FUNDS", holdId: null };
  return { status: "ACCEPTED", rejectReason: null, holdId: null };
}