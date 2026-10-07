# Complaint-driven case workflow (V2)

**Fraud reported → victim protected → disputed payments traced → case graph →
fan-out / circular / velocity analysis → explainable risk scores → suspected
mules → selected accounts frozen → later debits rejected → victim's money
located per account → recovered to the victim → factual outcome.**

Everything is simulated: no real bank, UPI or NPCI system is connected.

## 1. Flow and where each step lives

| Step | What happens | Module | API |
|---|---|---|---|
| Report | Victim lookup, incident window, disputed payments chosen explicitly from the victim's accepted outgoing payments, declared loss, narrative. Every disputed id must be an **accepted** payment **sent by the victim**. Identical resubmission replays; a different complaint about the same victim/payment is a new case flagged `SIMILAR_COMPLAINT_FLAGGED`, never merged. | `lib/modules/cases/intake.ts` | `GET /api/accounts/search`, `GET /api/accounts/:id/payments`, `POST /api/cases` |
| Protect | Optional (default on) `VICTIM_PROTECTION` debit hold, committed in the same transaction as the case, audit and outbox rows. Blocks future victim debits; credits still land; nothing is reversed. Can also be added later. | `lib/modules/protection/holds.ts` | `POST /api/cases` or `POST /api/cases/:id/holds {kind:"VICTIM_PROTECTION"}` |
| Trace | Bounded, time-respecting downstream traversal over **retained** accepted history (works long after the 90 s live window). Immutable, content-hashed revision with fixed cutoff (time + ledger sequence). | `lib/modules/tracing/{trace,job}.ts` | `POST/GET /api/cases/:id/trace` |
| Analyze | Explainable per-account risk score over one trace revision: fan-out, fan-in, chronological cycles, velocity/pass-through, structuring, cash-out, new-account bonus, plus the reused live detector as a 0-point cross-check. | `lib/modules/analysis/{score,job}.ts` | `POST/GET /api/cases/:id/analysis` |
| Freeze | `MULE_DEBIT_FREEZE` holds on operator-selected accounts (or the explicitly enabled demo auto-policy). The server re-derives eligibility from the named analysis revision. | `lib/modules/enforcement/freeze.ts` | `POST /api/cases/:id/holds {kind:"MULE_DEBIT_FREEZE"}` |
| Reject | Every payment path goes through one gate, `AccountRepository.admit()`, which checks active holds and balance at execution time. | `lib/persistence/repos/accounts.ts`, `lib/modules/payments/admission.ts` | engine tick, `POST /api/payments` |
| Money trail | Where the victim's money is now, per account (PROPORTIONAL attribution; see `docs/recovery.md`). | `lib/modules/attribution/` | `GET /api/cases/:id/attribution` |
| Recover | Return the victim's attributed money from accounts this case froze, as audited ledger transfers to the victim. | `lib/modules/recovery/recover.ts` | `POST/GET /api/cases/:id/recoveries` |
| Outcome | Factual, deduplicated accounting (§4). | `lib/modules/outcomes/outcome.ts` | `GET /api/cases/:id/outcome` |
| Report | Deterministic markdown from persisted evidence; stored snapshots are immutable and content-hashed. | `lib/modules/reports/report.ts` | `GET/POST /api/cases/:id/report` |
| Release | Releases exactly one hold with a reason; other holds on the account stay. Case closure never releases holds. | `lib/modules/protection/holds.ts` | `POST /api/holds/:id/release` |

Stages: `VALIDATED → TRACING → ANALYZED/UNDER_REVIEW → CLOSED`, with status
`NEEDS_EVIDENCE` when analysis finds no account meeting the suspect criteria.
The UI stepper is derived from persisted state only (`lib/modules/cases/queries.ts`).

## 2. Holds and the admission gate

- A hold is `{ type: VICTIM_PROTECTION | MULE_DEBIT_FREEZE, source: CASE | LEGACY_RING, case, reason, actor, created/released }`.
- An account is debit-blocked while **any** hold is `ACTIVE`. Debit holds never block credits.
- `admit()` runs inside `BEGIN IMMEDIATE`. All writes are synchronous with no `await` inside a transaction, so a hold and a payment never interleave: whichever commits first is what the other observes. A committed payment stays accepted; a committed hold rejects the next debit. Tests: `tests/integration/ledger-engine.test.ts`.
- Rejections are recorded with a stable attempt id, reason (`HOLD`, `INSUFFICIENT_FUNDS`, `INVALID`, `SELF_TRANSFER`) and the hold id. Replaying an attempt id replays the first outcome; reusing it for a different payment is a 409.
- The live `/hunt` "Freeze ring" now creates reasoned `LEGACY_RING` holds through the same service (operator only). `Account.frozen` in live snapshots is derived from active holds.

## 3. Mule eligibility

An account is **eligible** for a freeze only when, in the named analysis revision, it is:
a traced person account (not the case victim, not a merchant/sink), has at
least one behavioural finding with transaction evidence, scores at or above
the suspect threshold (50), and is not the victim of another case (that is a
`ROLE_CONFLICT`, surfaced for review). Reachability alone scores 0. Scores are
heuristic, not probabilities. A request naming a stale revision gets `409 STALE_ANALYSIS`.

## 4. Outcome definitions

| Metric | Meaning |
|---|---|
| Reported loss | Declared by the reporter; not validated |
| Disputed payment total | Sum of the unique accepted seed payments |
| Observed downstream flow | Unique traced onward edge volume; the same money can appear at several hops |
| Blocked debit attempts | Unique attempt ids rejected for a hold while **this case's** hold on that account was active |
| Blocked attempted amount | Sum of those attempts — attempted, not recovered; can exceed the funds held |
| Held balance | Current balance of accounts under this case's active mule holds; may include unrelated funds |
| Victim money in frozen accounts | PROPORTIONAL attribution of the victim's money currently in this case's frozen accounts |
| Recovered to victim | Sum of actual recovery transfers back to the victim |

"Contained" is shown only while every mule hold of the case is active;
"Blocked attempt observed" only after an actual rejection.

## 5. Authorization and API conventions

- Signed HttpOnly `SameSite=Strict` session cookie; roles `viewer` (read) and `operator` (all mutations). Operator code: `MNH_OPERATOR_CODE` (or a random code printed at startup). 10 wrong codes in 5 minutes lock operator sign-in for everyone.
- Mutations require the `x-netra-csrf: 1` header, and a matching `Origin` when the browser sends one.
- New routes answer `{ ok: true, data }` / `{ ok: false, error: { code, message } }`. Lists are keyset-paginated (`?cursor=`). Trace graphs are bounded by the revision's budgets.
- Legacy routes keep their shapes: `/api/attack` and `/api/report` are public (same-origin + rate limit); `/api/freeze` needs an operator; `/api/stream` is unchanged for `/hunt` and adds `event: case` messages (`id` = durable outbox cursor, per-case `version`). `?only=cases` serves case events only, replays events after `Last-Event-ID`, then sends `event: resync`.
- Case APIs never read the simulator's ground truth (`sim_truth` is not reachable from `Store`).

## 6. Configuration

See `.env.example`. Key settings: `MNH_DB_PATH`, `MNH_BASE_TPS` (default 250),
`MNH_HISTORY_RETENTION_MIN` (default 120), `MNH_DEMO_AUTO_ENFORCE`,
`MNH_OPERATOR_CODE`, `MNH_SESSION_SECRET`, `MNH_TRUST_PROXY`.

## 7. Deployment limits (read before deploying)

- **Single Node process.** The simulator, SQLite connection, SSE relay and rate limiter live in one process (`lib/runtime.ts`). Multiple processes or serverless instances would each run their own simulator against one file — unsupported. Scale-out means PostgreSQL + a single payment-admission service.
- Measured on this machine (node:sqlite, WAL): about 5,800 admissions/s in a single-threaded benchmark and ~260 bytes on disk per accepted payment. At the default 250 TPS that is roughly 230 MB per hour before retention. Pruning keeps it bounded, and SQLite reuses freed pages without shrinking the file.
- Trace and analysis jobs run synchronously inside the request (bounded by `runtimeBudgetMs`, default 3 s). A crash leaves the revision `FAILED` ("interrupted by process restart") and it can be retried.
- Queued simulator payments (scenario cash-outs) are in memory: they do not resume after a restart. Accounts, balances, holds, cases and evidence do.
- Without `MNH_SESSION_SECRET`, sessions end on restart.
