# Data migration and rollback

## Before V2

The pre-V2 app (commit `7db9ed2`) kept everything in memory: no database,
rupee floats, `Account.frozen: boolean`, and simulator truth on the shared
account type. There is **no persisted legacy data to migrate**. A freeze made
in the old version did not survive a restart, so no legacy freeze state exists
on disk.

## Schema (node:sqlite, `lib/persistence/migrations/`)

| Version | Name | Content |
|---|---|---|
| 1 | initial-ledger | accounts, payment_attempts, accepted_transactions |
| 2 | cases-and-holds | cases, case_idempotency, case_disputed_transactions, account_holds |
| 3 | trace-analysis-enforcement-audit | case_trace_runs/edges, case_findings, case_candidates, enforcement_actions, audit_events, ui_outbox |
| 4 | v2-runtime-truth-isolation-hold-sources | see below |

Migration 4:
- **Truth isolation.** It moves `accounts.is_mule`/`scenario_id` into `sim_truth` and drops the columns.
- **Accounts** gain `run_id`, `opening_balance_minor` (conservation check) and `base_pool`.
- **Holds.** It rebuilds `account_holds` with `source` (`CASE` | `LEGACY_RING`), a nullable `case_id`
  (legacy holds only), `source_ref` and `action_id`, plus partial unique indexes: one active hold
  per (case, account, type) and one per (legacy ring, account).
- **New tables:** runs, ledger metadata (prune watermark), trace snapshots, analysis runs, report
  snapshots, and a cursor-based `ui_outbox`.
- **Index trim** on the hot payment tables; `payment_attempts.txn_id` added.

Migrations run automatically on startup, each inside its own transaction, and
are recorded in `schema_migrations`. A failed migration rolls back completely.

## Money units

- The durable domain uses integer paise (`amountMinor`) everywhere.
- The only rupee→paise conversion is `rupeesToMinor` (`lib/contracts/money.ts`): it rounds half-up
  and refuses more than two decimals rather than silently rounding money away.
  The complaint form uses it for the declared loss.
- The live 90 s detector keeps its rupee thresholds through the versioned one-way adapter
  `lib/contracts/legacy.ts` (`legacy-rupee-view/v1`), which divides by 100 exactly once.
- Legacy API fields keep their meaning: `/api/attack` still returns `amount` (rupees) and adds `amountMinor`.
  `Metrics.intercepted` / `Ring.intercepted` now carry the *blocked attempted* rupee amount
  (renamed in the UI), alongside new `blockedAttempts` / `blockedAttemptedAmount`.

## Rollback

- **To the pre-V2 in-memory app:** check out `7db9ed2`. It ignores the database file.
- **To reset V2 state:** stop the server, then run `npm run db:reset`, which deletes
  `MNH_DB_PATH` (default `data/mulehunter.db`) and its WAL files. The next start
  creates a fresh funded run. This permanently discards cases, holds and evidence;
  export the reports you need first.
- There are no down-migrations. Migration 4 drops the truth columns from `accounts`.
  To keep an old database, copy the file before upgrading.
