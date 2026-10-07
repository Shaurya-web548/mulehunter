# UPGRADE_STATUS — NETRA / Mule Network Hunter V2 (complaint-driven)

Source of truth for the upgrade defined in `docs/WORKFLOW_V2_CASE_DRIVEN.md`.
Nothing is marked done without a command that was actually run. To resume,
read §6.

Last full verification: **2026-09-30 23:51 IST** (Node 24.16.0, SQLite 3.53.0, Next 16.3.0).

## 1. Phase checklist

| Phase | Status | Evidence |
|---|---|---|
| U0 Audit | Done | §4 baseline; file map in `docs/case-workflow.md` |
| U1 Contracts/persistence | Done | migrations 1–4, `tests/unit/persistence.test.ts`, restart tests |
| U2 Ledger/holds/admission | Done | `tests/integration/ledger-engine.test.ts` (6), mutation check §3 |
| U3 Complaint + protection | Done | `tests/unit/intake.test.ts` (6), e2e journey |
| U4 Historical tracing | Done | `tests/unit/trace.test.ts` (14), journey test beyond the 90 s window |
| U5 Case analysis | Done | `tests/unit/analysis.test.ts` (7), journey eligibility assertions |
| U6 Mule actions/outcomes | Done | journey + multi-case + restart integration tests |
| U7 UI/report/SSE | Done | Playwright: 3 browser tests on a production build |
| U8 Regression/restart/docs | Done | §3 (HTTP restart check, /hunt regression), docs listed in §5 |

## 2. What changed (by module)

- `lib/persistence/` — migration 4:
  - truth isolation (`sim_truth`); hold `source` with a nullable case for `LEGACY_RING`;
  - opening balances, runs, ledger metadata, trace/analysis/report snapshots, cursor outbox, index trim;
  - prepared-statement cache and re-entrant (savepoint) transactions;
  - repositories for runs, meta, outbox, reports and truth (the truth repository is not in `Store`).
- `lib/persistence/repos/accounts.ts` — the single admission gate:
  - hold before balance, same-run check;
  - attempt-id replay, with 409 on reuse for a different payment.
- `lib/engine/` — simulator over a funded ledger:
  - paise, merchant settlements, no minting;
  - scenario forwards never exceed the expected balance, stable attempt ids at scheduling time;
  - the engine admits each tick in one serialized transaction;
  - `frozen` is derived from holds; legacy freeze goes through the hold service;
  - outbox relay and retention pruning.
- `lib/contracts/` — domain types, money (`rupeesToMinor` refuses sub-paise), `legacy.ts` rupee view adapter.
- `lib/modules/` — cases (intake, queries, stepper), protection, payments (admission, retention),
  tracing (pure trace + job), analysis (pure score + job), enforcement, outcomes, reports, audit, demo fixture.
- `lib/auth/session.ts`, `lib/http/api.ts` — signed session, roles, CSRF, sign-in lockout,
  rate limiting, envelope; `lib/client/*` — browser helpers.
- `app/api/**`:
  - new routes: cases, trace, analysis, holds, outcome, report, hold release, session, config,
    account search/payments, demo scenario, manual payments;
  - `/api/stream` adds case events and replay;
  - `/api/freeze` is operator-only; `/api/attack` and `/api/report` check same-origin and are rate limited;
  - the report route pseudonymizes account details before sending them to the LLM, defaults to
    `claude-opus-5-5`, and enables the server-side refusal fallback.
- UI: `app/cases/{page,new,[caseId]}`, `components/cases/*` (stepper, SVG case graph via d3-force,
  trace/analysis/outcome/holds/audit panels, sign-in, nav); `/hunt` shows auth, honest metrics and nav;
  landing copy fixes; two pre-existing React lint errors fixed.
- Tooling: `@playwright/test` 1.63 (dev), scripts `build:verify`, `test:e2e`, `verify`;
  `next.config.ts` `distDir` from `NEXT_DIST_DIR`; ESLint ignores build output.
- Docs: `case-workflow.md`, `tracing-methodology.md`, `data-migration.md`, `demo-v2.md`,
  README V2 section, `.env.example`.

## 3. Executed verification

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npx eslint` | exit 0, no warnings (was 4 errors at baseline) |
| `npm test` | **51 pass / 0 fail**: 14 trace, 7 analysis, 6 intake, 11 persistence/admission, 5 auth/admission, 6 ledger-engine integration, 3 journey integration |
| `npm run test:e2e` | production build OK (24 routes); **3/3 Playwright pass**: complaint → protect → trace → analyze → freeze → rejected debit → report download → SSE resync; viewer refused (403) by the API; /hunt regression (stream, attack, legacy freeze/report shapes) |
| Mutation check | Disabling the hold check in `admit()` failed 10 tests; restoring it gave all green |
| HTTP restart check (`next start`, file DB, process killed and restarted) | Case, active victim hold and balance survived; the victim's next debit was `REJECTED HOLD`; intake retry `replayed=true` on the same case; a new trace after restart was DONE (13 accounts); no errors in server logs |
| Admission benchmark (node:sqlite, WAL, 12k accounts) | ≈ 5,800 admissions/s single-threaded; ≈ 260 B per accepted payment |
| Independent code review (subagent) | 0 critical/high; 5 medium, all fixed with regression tests: trace window gap, amount filter before LIMIT, rate-limit bypass via header, cross-run manual payment, attempt-id reuse and prune replay |

One e2e failure during the final run was a wrong test (it "retried" an attempt id with a
different payee). After review fix #5 that is correctly a 409. The test now asserts both the
replay and the conflict.

## 4. Baseline (before this session's changes, 22:56 IST)

`npm test` 16/16 (the other agent's scaffolding) · typecheck exit 0 · eslint 4 errors
(`HowItHunts.tsx:68`, `anim.tsx:160` set-state-in-effect; `simulator.ts:131,143` prefer-const)
and 3 warnings.

## 5. Known limitations (by design or out of scope)

- Single-process deployment only. Queued simulator payments do not resume after a restart
  (accounts, balances, holds, cases and evidence do).
- Reachability tracing only; no amount attribution, so "case-attributable held" is shown as unavailable.
- Trace and analysis jobs run synchronously inside the request (bounded to 3 s by default).
- Viewer sign-in needs only a name (demo); any visitor can read case data. The public `/api/stream`
  still carries aggregate live precision/recall computed from simulator truth (pre-V2 behaviour;
  no per-account labels).
- The case-report LLM enhancement was not added (deterministic report only). The legacy `/hunt`
  ring report keeps its optional Claude prose.
- Pre-V2 README precision/recall figures were not re-measured.
- Housekeeping, left untouched because they are the other agent's files: `_probe.txt`, `_test.txt`,
  `_test_glob.txt`, `_tsc.txt` in the repo root. `next build` with `NEXT_DIST_DIR` adds
  `.next-verify/**` type paths to `tsconfig.json` `include` (harmless).
- Nothing is committed yet. All work is uncommitted on `main`.

## 5a. Follow-up: money trail and victim fund recovery (2026-10-01)

Requested: recovering the victim's money by blocking the mule accounts, instead of
reachability only. See `docs/recovery.md`.

- **Attribution** (`lib/modules/attribution/`): PROPORTIONAL (pro-rata) tracing in ledger
  sequence order with exact balance reconstruction and BigInt arithmetic. It conserves every
  paisa into held / cashed out / merchant / returned / recovered / dust / untracked.
  Budgets are reported, and recovery is refused if the result is truncated.
- **Recovery** (`lib/modules/recovery/`, migration 5): `min(victim money, balance)` from
  accounts this case froze, sent to the case victim as ledger transfers.
  - The gate verifies victim and freeze itself (`recoveryForCase`). It is the only debit
    allowed from a frozen account.
  - Atomic, idempotent (action key + payload hash), with an audit and outbox event.
  - Recoveries for other cases don't reduce this case's share.
- Outcome, report (§7 "Money trail & recovery"), APIs (`/attribution`, `/recoveries`), UI
  (Money trail panel, "Victim money here" column, Recover button) and e2e step added.
- **Bug found on the live dev DB and fixed (migration 6):** per-account ledger reads were
  planned on the global `(run_id, seq)` index and scanned ~400k rows, about 120 ms per call.
  Attribution took 2.4 s and hit its 3 s budget on the busy dev server, so it returned
  truncated figures. The new `(run_id, from|to_id, seq)` indexes plus `INDEXED BY` bring
  calls to 0.2 ms and attribution to 5 ms, with identical results.
- **Hardening:** one payment failing with a storage error (a duplicate transaction id was seen
  once on the dev server; root cause not proven) previously rolled back the whole engine tick.
  Scheduled payments due in that tick were lost. Each payment now runs in its own savepoint
  (regression test added), and simulator ids are 72-bit. Dev hot reload now applies new
  migrations and attaches new repositories to the cached store.
- **Verification (2026-10-01):** typecheck 0 · lint 0 · `npm test` **61/61** (+8 attribution unit,
  1 recovery integration, 1 tick-isolation) · `npm run test:e2e` **3/3** (journey now includes
  Recover; the victim's balance rises by exactly the recovered total). Demo figures: ₹74,500
  recovered from 5 frozen mules; innocent recipients' ₹1,02,000 reported as in unfrozen
  accounts; cashed-out money reported as gone.
- **Not implemented:** amount-limited liens on innocent recipients; alternative
  attribution policies (FIFO/LIFO).

## 6. Next action

None required for the acceptance workflow. Optional next steps: amount-attribution
policy, a background job queue for large traces, PostgreSQL adapter for multi-process
deployment, a benchmark harness for live precision/recall at 250 TPS.
