# Tracing methodology

Implementation: `lib/modules/tracing/trace.ts` (pure) and `job.ts` (persistence).
Tests: `tests/unit/trace.test.ts`, `tests/integration/case-journey.test.ts`.

## What a trace means

A trace answers: **which accounts received accepted downstream transfers after
the disputed payment, in ledger order?** That is *reachability*. It is not:

- proof that the victim's money reached an account (a mule's onward payment
  may be funded by other inflows), or
- evidence of wrongdoing by itself (analysis scores behaviour; reachability
  contributes 0 points).

The observed downstream flow is the sum of unique traced edge volumes and can
count the same money several times. **Exact per-account amounts** ("how much
of the victim's money is in this account now") come from the separate
PROPORTIONAL attribution model in `docs/recovery.md`, which conserves every paisa.

## Rules

1. **Seeds** are the case's disputed payments. Intake copied their amount, time and ledger
   sequence, so a seed stays traceable even after retention prunes its row
   (the trace then fails with `SEED_HISTORY_MISSING` only if the onward history is gone too).
2. **Time-respecting.** From an account that received money at `(ts, seq)`, the trace follows
   only accepted payments strictly after it in ledger order (`ts`, then
   `seq` for equal timestamps) and within `maxHopDelayMs` of that receipt (default 2 h).
3. **Only accepted payments.** Rejected attempts never become edges.
4. **Terminal accounts.** Merchants, cash-out sinks and the case victim are recorded but not
   expanded. Merchant settlements fan out to thousands of customers, and the
   victim's own later spending is not part of the complaint.
5. **Minimum onward amount.** Onward payments below `minEdgeAmountMinor` (default ₹1,000)
   are ignored. The filter runs in SQL before the per-account limit, so small
   payments cannot hide large ones. It is a declared parameter stored with the revision.
6. **Earliest arrival, path-aware.** Each account is expanded from its earliest arrival.
   - A later arrival over no fewer hops reads only the part of its follow window not yet read.
   - An arrival over fewer hops re-reads its whole window, so the hop budget cannot hide a shorter route.
   - Edges that reach an already-visited account are still recorded. Circular routing therefore
     stays visible; there is no global "visited ⇒ drop" rule.
7. **Deduplication and provenance.** Each transaction appears once. Its `seedTxnIds` list every seed
   that had reached its sender earlier in ledger order.
8. **Paths and cycles.** Paths are enumerated time-respectingly over the traced edges and capped at
   `maxPaths`. A path that revisits an account on itself closes a chronological cycle and stops.
9. **Budgets.** `maxHops` 5, `maxNodes` 500, `maxEdges` 2000, `maxPaths` 200,
   `maxOutPerNode` 200, `runtimeBudgetMs` 3000. Every budget that is hit is reported
   in `truncation` and the revision is marked `truncated`.
10. **Fixed cutoff.** Each revision stores its wall-clock cutoff and the ledger head sequence
    `cutoffSeq`. All reads are bounded by both, so a revision reads the same rows
    while traffic continues. The snapshot is stored as canonical JSON with a SHA-256 hash.
11. **Incomplete history.** If retention pruned history after the window start (watermark
    `history_pruned_before:<run>`), the revision is flagged `historyIncomplete`.

## Analysis on top of a trace

`lib/modules/analysis/score.ts` scores each traced person account from bounded
ledger context (its inflows/outflows within the trace window, same cutoff).
Features, points and thresholds are in `DEFAULT_ANALYSIS_CONFIG`. The config hash
(`configVersion`) and `DETECTOR_VERSION` are stored with every revision:

| Feature | Rule (defaults) | Points |
|---|---|---|
| FAN_OUT | ≥ 4 distinct recipients and ≥ ₹20,000 within 30 min of the first traced receipt | min(30, 6·n) |
| FAN_IN | ≥ 6 senders and ≥ ₹40,000 | min(25, 3·n) |
| CIRCULAR | on a chronological cycle in the trace | 30 |
| VELOCITY | ≥ 80 % of the first traced receipt sent onward within 10 min | 20–35 |
| STRUCTURING | ≥ 3 transfers in [₹8,800, ₹10,000) | min(20, 4·n) |
| CASH_OUT | ≥ 2 withdrawals to a cash-out sink (supporting only) | 10 |
| NEW_ACCOUNT | opened < 7 days ago, only with a behavioural finding | 10 |
| REACHABILITY | received downstream funds | 0 |
| LIVE_HEURISTIC_CROSSCHECK | existing live-window `scoreAccount` (informational) | 0 |

Suspected mule = score ≥ 50 **and** ≥ 1 behavioural finding (fan-out, fan-in,
cycle, velocity, structuring). Negative control: the same amounts moved at a
normal pace do not trigger velocity (`tests/unit/analysis.test.ts`).
