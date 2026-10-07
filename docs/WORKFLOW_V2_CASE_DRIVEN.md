# Mule Network Hunter V2 — Complaint-Driven Workflow

Status: **authoritative spec** for the V2 upgrade. `docs/UPGRADE_STATUS.md`
tracks what is actually implemented and verified against this document.

## 1. Purpose

V1 answers "is there a mule ring in this synthetic flow?". V2 answers the
question a bank actually gets asked: a customer says "I was defrauded" — what do
we do in the next 60 seconds, what can we prove we did, and what did it change?

The upgrade is therefore **case-driven**: a complaint creates a case, the case
protects the victim, traces the stolen money through retained history, analyses
the reachable subgraph, scores candidate mules, and applies holds that are
observable as **rejected debits** and **honest outcome numbers**.

## 2. Constraints (do not violate)

| Area | Decision |
| --- | --- |
| Runtime | Keep Next.js + React + TypeScript + Tailwind. No Vite, no Python service, no Kafka, no Neo4j for this workflow. |
| Existing features | `/hunt`, the attack simulator, the live d3-force graph, existing motifs, the report fallback and SSE must keep working. New code adapts to them behind compatible interfaces; it never forks them. |
| Durability | SQLite (`node:sqlite`, Node >= 24) behind repository interfaces. Postgres is only reconsidered if the process model becomes multi-node on purpose. |
| Money | Integer **minor units (paise)** named `amountMinor` everywhere in the durable domain. Legacy rupee `amount` fields convert only at the versioned boundary in `lib/contracts/money.ts`. |
| Time | All durable timestamps are integer ms epoch. |
| Syntax | Code that must run under `node --test` stays **erasable-syntax-only** (`erasableSyntaxOnly: true`): no enums, no namespaces, no parameter properties, and relative imports carry the `.ts` extension. |

## 3. Steps 1 to 3

### Step 1 — Report the fraud

`POST /api/cases` (complaint intake).

* Required: `victimAccountId`, `incidentStartTs`, `incidentEndTs`,
  `disputedTxnIds[]`, `narrative`.
* Optional: `declaredLossMinor`, `protectVictim` (default true),
  `idempotencyKey`.
* Invariants: the disputed transaction ids must exist in the retained ledger and
  the victim must be the sender of at least one of them, otherwise the case is
  rejected with a coded `DomainError`, never silently accepted.
* Idempotency: `(idempotencyKey, payloadHash)` is unique. Replaying the same key
  with the same payload returns the same case id; replaying it with a different
  payload is a conflict, not a second case.
* Result: a case pinned to revision 1, plus an audit event.

### Step 2 — Protect the victim

Creating a case creates a **victim protection hold**, not a "victim freeze":

* `account_holds.type = 'VICTIM_PROTECTION'`, one row per case, with the reason
  and actor recorded and `status = 'ACTIVE'`.
* The hold stops the victim's account from **debit** while they are on the phone
  with the bank. Credits are unaffected.
* Holds are **independent**: releasing case A's hold never releases case B's
  hold on the same account. An account is debit-blocked while **any** hold is
  `ACTIVE`.

### Step 3 — Trace the money (historical)

Tracing reads **retained history**, not the 90-second live window.

* Seeds: the victim account plus every disputed transaction.
* Defaults: 5 hops, 500 nodes, 2000 edges, 200 paths, a runtime budget, and a
  cutoff of 24 h before the incident end.
* Cycles: visited state is **path-specific**, so a cycle is cut per path instead
  of globally hiding reachable money.
* The run is recorded (`case_trace_runs`) with the limits actually used, the
  cutoff window, whether it was truncated, and any error — so a truncated trace
  is visible, never silently presented as complete.

## 4. Steps 4 to 8

### Step 4 — Analyse the reachable subgraph

Analysis runs only on what the trace actually reached, and records:

* **findings** (motif, member accounts, contributing txn ids, heuristic score,
  human-readable explanation) stamped with `detectorVersion` and
  `configVersion`;
* **candidate scores** per account with explicit `contributions[]` (feature,
  points, note) so every point is explainable.

A heuristic score is **not** a probability and is never presented as one.

### Step 5 — Score candidates

Candidate output is a ranked, explained list with `suspectMule` as an explicit
threshold decision. The threshold is configuration, and the config version is
stored with the result so an old decision can be re-explained later.

### Step 6 — Freeze the mules

Enforcement is one auditable batch action:

* Idempotency key `(case_id, action_key)` — re-running the same enforcement never
  creates duplicate holds.
* Each mule account gets its own `MULE_DEBIT_FREEZE` hold with its own reason and
  actor, so any single one can be released and explained.
* The action row records the requested account ids, the hold ids it created, and
  `REQUESTED → APPLIED | FAILED`, plus an audit event per action.

### Step 7 — Reject debits

**Every** payment path goes through one admission service — the simulator, bulk
runs, queued/unattended jobs and injected test traffic. Nothing may debit an
account by writing balances directly.

Admission, inside a single write transaction:

1. replay check on `attemptId` (idempotent);
2. load both accounts and the oldest active hold on the payer;
3. pure verdict, ordered: `INVALID` / `SELF_TRANSFER` / `HOLD` /
   `INSUFFICIENT_FUNDS`;
4. on accept: record the attempt, move the money, append the accepted
   transaction with a per-run `seq`;
5. on reject: record the attempt **with its reason and the responsible hold id**,
   and move nothing.

Consequence: a hold that commits first rejects the next debit; a payment that
commits first stays accepted. Both are recorded, so the case can report exactly
which attempts it blocked.

### Step 8 — Show the outcomes

Outcome reporting uses **strict definitions**:

| Metric | Definition |
| --- | --- |
| `uniqueBlockedAttemptCount` | Distinct `payment_attempts` with `status='REJECTED'` and `reject_reason='HOLD'` for accounts held by this case. Retries of the same `attemptId` count once. |
| `blockedAttemptAmountMinor` | Sum of the amounts of those attempts. |
| `activeHoldCount` / `muleHoldCount` | Holds created by this case that are still `ACTIVE`. |
| `heldBalanceMinor` | Sum of the current balances of accounts held by this case — **frozen money, not recovered money**. |
| `reportedLossMinor` | What the victim declared. Not a verified figure. |
| `disputedPaymentTotalMinor` | Sum of the disputed transactions validated against the ledger. |
| `observedDownstreamFlowMinor` | Sum of traced outflows from the reachable subgraph. |
| `recoveredOrRefundedMinor` | **Always 0** until an explicit refund/credit ledger operation exists. |
| `caseAttributableHeldMinor` | **`null`** unless an attribution model exists. Never guess a share of a balance. |

Hard rules: never call a hold "recovery"; never report a derived label
("recovered") as a fact; if a number cannot be computed from a stored record,
report `null`, not an estimate.

## 5. States

Investigation stage (durable, ordered):
`REPORTED → VALIDATED → TRACING → ANALYZED → UNDER_REVIEW → CLOSED`
with the side state `NEEDS_EVIDENCE` for a case that cannot proceed.

Protection state lives in `account_holds` (ACTIVE/RELEASED) and is deliberately
**not** a case status: a case can be closed while a hold stays active, and a hold
can be released while the case stays open.

Outcome state is factual fields read from the ledger and hold tables, plus
derived display labels — never stored as truth.

## 6. Interfaces to existing functionality

| Existing thing | V2 relationship |
| --- | --- |
| `lib/engine/*` (simulator, graph, detect) | Kept. Its simulation loop is re-pointed at the admission service so holds are enforced there too. |
| `/hunt` console | Kept as the operator console; case views are added alongside, not instead of. |
| Live graph + d3-force | Kept for the live view; case views render traced history from the trace tables. |
| `POST /api/attack` | Kept; its injected transfers must pass admission so a held account is genuinely blocked in the demo. |
| `POST /api/report`, `POST /api/freeze` | Kept as the legacy fallback path and mapped onto the case workflow where possible. |
| `GET /api/stream` (SSE) | Kept; new case events are appended to the same stream. |

## 7. Acceptance script (must run end to end)

1. Seed a synthetic network with a funded victim.
2. Simulate a fraud flow victim → m1 → m2 → cash-out.
3. File a complaint for the victim's disputed transfers.
4. Observe the victim protection hold, its reason and its actor.
5. Run the historical trace and see the accepted path plus the truncated flag.
6. Run analysis and get findings with per-feature contributions.
7. Freeze the candidate mules as one idempotent action.
8. Attempt a debit from a held mule and see it rejected with
   `reject_reason = 'HOLD'` and the responsible hold id.
9. Attempt the same debit again with the same attempt id and see an idempotent
   replay, not a second decision.
10. Release one hold and confirm the account stays blocked while another case's
    hold is active.
11. Read the outcome panel and confirm every number matches the strict
    definitions table in §4.

## 8. Verification commands

```bash
npm test          # node --test on the real SQLite driver
npm run typecheck # tsc --noEmit, erasable syntax enforced
npm run db:reset  # drop the local demo database
```

Current pass/fail evidence and the phase-by-phase status live in
`docs/UPGRADE_STATUS.md`.

## 9. What is implemented today (U1–U3)

Steps 1 and 2 of the workflow are live; steps 3 to 8 are still to come. This
section documents the exact contract so the remaining work builds on it rather
than guessing.

### `POST /api/cases` — file a complaint

```jsonc
{
  "victimAccountId": "victim",          // required, must exist
  "incidentStartTs": 1699999400000,     // required, integer ms
  "incidentEndTs": 1700000000000,       // required, integer ms, >= start
  "disputedTxnIds": ["tx_1", "tx_2"],   // required, at least one, deduped
  "narrative": "…",                     // required, 8 characters or more
  "declaredLossMinor": 250000,          // optional, integer paise, default 0
  "reporterId": "self_reported",        // optional
  "protectVictim": true,                // optional, default true
  "idempotencyKey": "op-key-1",         // optional, see "Replays" below
  "actorId": "op_intake"                // optional, recorded on the hold + audit
}
```

Response `201` (or `200` for a replay):

```jsonc
{ "ok": true, "replayed": false, "case": { … }, "victimHold": { … },
  "disputed": [ … ], "warnings": ["txn_not_sent_by_victim: …"] }
```

`GET /api/cases` lists cases; `GET /api/cases?id=<caseId>` returns the case with
its disputed transactions, holds and audit trail.

### Rules the endpoint enforces

| Situation | Result |
| --- | --- |
| Unknown victim account | `422 UNKNOWN_VICTIM` |
| A disputed id is not in the retained ledger | `422 UNKNOWN_DISPUTED_TRANSACTION` |
| The victim is not the sender of any disputed payment | `422 VICTIM_NOT_SENDER` |
| Missing/blank/short fields, bad window, non-integer paise | `400 INVALID_COMPLAINT` |
| No disputed ids after dedupe | `400 NO_DISPUTED_TRANSACTIONS` |
| Same idempotency key with a different payload | `409 IDEMPOTENCY_CONFLICT` |
| Any of the above | **nothing** is written — the transaction rolled back |

### Replays

* With an explicit `idempotencyKey`, the key identifies the complaint: the same
  key and the same payload returns the first case, the same key with different
  content is a `409`.
* Without a key, the key is derived from the payload hash (`auto:<sha256>`), so a
  double-submitted form cannot file two cases, while a genuinely different
  complaint (different money, victim, window or disputed set) still can.

### What a filed case looks like

* `stage` and `status` are `VALIDATED`, `revision` is `1`: the complaint was
  checked against the ledger before it was stored, so the pre-validation
  `REPORTED` state never reaches the database.
* Each `case_disputed_transactions` row carries the ledger's own `amount_minor`,
  `ts` and `seq` — the case never stores a re-typed amount.
* `victimHold` is an `ACTIVE` `VICTIM_PROTECTION` hold owned by this case, with a
  reason naming the disputed count and total and the actor who filed it. The
  victim's debits are rejected with `reject_reason = 'HOLD'` and this hold id
  while it is active; credits into the account still settle.
* Two audit rows are written: `CASE_CREATED` and `VICTIM_HOLD_CREATED`.



