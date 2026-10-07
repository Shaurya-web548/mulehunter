/**
 * Payment admission service — the one entry point for moving simulated money.
 *
 * Base-load traffic, scheduled scenario payouts, the demo fixture and manual
 * operator payments all come through here and end in
 * `AccountRepository.admit()`, which checks active holds and the balance at
 * execution time inside a BEGIN IMMEDIATE transaction.
 */
import crypto from "node:crypto";
import { DomainError } from "../../contracts/types.ts";
import { assertMinor } from "../../contracts/money.ts";
import type { AttemptResult } from "../../persistence/repos/accounts.ts";
import { serialTx, type Store } from "../../persistence/store.ts";

export type PaymentChannel = "BASE_LOAD" | "SCHEDULED" | "DEMO" | "MANUAL";

export interface PaymentInput {
  attemptId?: string;
  txnId?: string;
  runId: string;
  fromId: string;
  toId: string;
  amountMinor: number;
  ts: number;
  channel: PaymentChannel;
}

export interface AdmittedPayment extends AttemptResult {
  input: Required<Omit<PaymentInput, "attemptId" | "txnId">> & { attemptId: string; txnId: string };
}

const newId = (p: string) => `${p}_${crypto.randomBytes(9).toString("hex")}`;

function normalize(p: PaymentInput): AdmittedPayment["input"] {
  if (!p.fromId || !p.toId) throw new DomainError("INVALID_PAYMENT", "fromId and toId are required", 400);
  assertMinor(p.amountMinor, "amountMinor");
  if (!Number.isInteger(p.ts)) throw new DomainError("INVALID_PAYMENT", "ts must be an integer ms timestamp", 400);
  return {
    attemptId: p.attemptId ?? newId("att"),
    txnId: p.txnId ?? newId("tx"),
    runId: p.runId,
    fromId: p.fromId,
    toId: p.toId,
    amountMinor: p.amountMinor,
    ts: p.ts,
    channel: p.channel,
  };
}

/** Admit one payment in its own serialized transaction. */
export function admitPayment(store: Store, p: PaymentInput): AdmittedPayment {
  const input = normalize(p);
  const r = serialTx(store, () => store.accounts.admit(input));
  return { ...r, input };
}

/**
 * Admit a batch in ONE serialized transaction (one engine tick). Each payment
 * is still decided individually against the state left by the previous one.
 * Malformed items are rejected-and-recorded by the gate rather than aborting
 * the batch. Each admission runs in its own savepoint (admit() nests), so an
 * unexpected storage error on one payment rolls back only that payment — it is
 * reported as not executed and logged, and the rest of the tick still commits.
 */
export function admitBatch(store: Store, payments: PaymentInput[]): AdmittedPayment[] {
  return serialTx(store, () =>
    payments.map((p) => {
      const input = {
        attemptId: p.attemptId ?? newId("att"),
        txnId: p.txnId ?? newId("tx"),
        runId: p.runId,
        fromId: p.fromId,
        toId: p.toId,
        amountMinor: Number.isInteger(p.amountMinor) && p.amountMinor > 0 ? p.amountMinor : 0,
        ts: p.ts,
        channel: p.channel,
      };
      try {
        return { ...store.accounts.admit(input), input };
      } catch (err) {
        store.accounts.invalidateSeq();
        console.error("[payments] admission failed; payment not executed", { attemptId: input.attemptId, txnId: input.txnId, channel: input.channel }, err);
        return {
          attemptId: input.attemptId,
          status: "REJECTED" as const,
          rejectReason: "INVALID" as const,
          holdId: null,
          txnId: null,
          balanceAfterMinor: null,
          replayed: false,
          input,
        };
      }
    }),
  );
}
