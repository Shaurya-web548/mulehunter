# Money trail and victim fund recovery

Goal: **block the mule accounts, work out exactly how much of the victim's
money is in each one, and return it to the victim.**

Implementation: `lib/modules/attribution/` (where the money is) and
`lib/modules/recovery/` (getting it back). Tests: `tests/unit/attribution.test.ts`,
`tests/integration/recovery.test.ts`, the e2e journey.

## 1. Where is the victim's money? (attribution)

Tracing (`docs/tracing-methodology.md`) answers *who received downstream
money*. Attribution answers **how much of the victim's money each account
holds right now**. It uses a disclosed fund-tracing rule:

**PROPORTIONAL (pro-rata) tracing, in exact ledger order.**
- The disputed payment is 100 % the victim's money.
- A receiving account's own earlier balance, and any inflow not traceable to the victim,
  are the holder's own ("clean") money.
- Whenever a tracked account pays X, the victim's share of that payment is
  `X × victim money in the account ÷ account balance` at that exact moment. Every outgoing
  rupee carries the same mix as the balance it left. Clean inflows dilute; victim-money
  inflows add to it.
- Balances are reconstructed exactly from the ledger. Payments are applied in ledger
  **sequence** order, which is the order balances actually changed, not the timestamp order.

Every paisa of the disputed amount lands in exactly one bucket, so split, merge
and cycle paths never double-count:

| Bucket | Meaning |
|---|---|
| In frozen accounts | held in accounts this case has frozen — **recoverable** |
| In unfrozen accounts | still movable; freeze eligible mules. Innocent recipients need a lien or legal process |
| Cashed out | reached an ATM / cash-out sink — gone |
| Spent at merchants | paid to merchants — chargeback route |
| Returned by fraudsters | flowed back into the victim's account |
| Recovered to victim | returned by recovery transfers |
| Dust / untracked | shares below ₹1, or budget/history limits (flagged) |

Budgets: 500 accounts, 5,000 events per account, 3 s. If any budget is hit the
result is flagged `truncated`, the UI and report say so, and **recovery is refused**
until the figures are complete.

## 2. Getting it back (recovery)

`POST /api/cases/:id/recoveries` (operator, with reason and idempotency key), or
the **Recover ₹X to victim** button in the case workspace:

- Only from accounts under an **active `MULE_DEBIT_FREEZE` of this case**. The freeze is
  what keeps the money in place.
- Per account it returns `min(victim's money there now, account balance)`, **never the
  account holder's own money**.
- Each return is a real ledger transfer, **frozen account → case victim**, through the
  admission gate. A recovery is the only debit the gate lets out of a frozen account.
  The gate itself checks that the payee is this case's victim and that the payer is
  frozen by this case; anything else is rejected.
- Attribution is recomputed inside the same transaction as the transfers, so the
  amounts reflect the ledger at the moment of recovery. All transfers commit, or none do.
- Idempotent: retrying with the same action key replays the same result, and reusing
  the key for a different request returns 409. A second recovery only returns money
  that is newly attributable.
- Multiple cases: a recovery for case A removes case A's money one-for-one. In case B's
  view the same transfer takes case A's money first, so B's victim share is not reduced.
  Proportional tracing is linear, so each case's figures are consistent with a joint
  model and never overlap.
- Freezes stay in place after recovery. Releasing them is a separate, reasoned action.

## 3. Worked example (the seeded demo)

The victim pays ₹2,40,000 to A. Everything below is computed by the system, not scripted.

| Account | Victim money after layering | Role |
|---|---|---|
| quickpay (A) | ₹13,500 | fan-out mule |
| rk.traders (B) | ₹1,000 (₹9,000 already cashed out) | mule |
| sunil.k (C) | ₹58,000 (₹2,000 kept + ₹56,000 back through the loop) | loop mule |
| h.loop / i.loop | ₹1,000 each | loop mules |
| deals4u (D), f.rental (F) | ₹3,000 / ₹2,000 | below threshold |
| cashpoint (G) | ₹48,000 | no behaviour yet → not frozen, cashes out later |
| anil.mehta (E) | ₹50,000 of its ₹70,000 balance (71.4 %) | innocent recipient |
| jaya.nair (J) | ₹52,000 | innocent recipient |
| merchant | ₹1,500 | spent |

Freezing the five eligible mules (A, B, C, H, I) keeps their scheduled cash-outs from
leaving. **Recover** then returns **₹74,500** to the victim in 5 transfers, and every
frozen mule ends at ₹0 because it held only victim money. G's ₹45,000 cash-out, which
happened because it was never frozen, and D's ₹3,000 show up as *cashed out*. The
₹1,02,000 with the innocent recipients E and J shows as *in unfrozen accounts*: in
practice that part goes through a lien or legal process with their banks.

## 4. Limits

- This is a simulation: recoveries are simulated ledger transfers, and no real bank or
  UPI reversal happens.
- Proportional tracing is one of several legal conventions; FIFO and LIFO are others.
  The policy name (`PROPORTIONAL/v1`) is recorded with every figure.
- Amount-limited liens on innocent recipients (blocking only the victim's share) are not
  implemented. Those amounts are reported but not recovered.
- Attribution needs the ledger history after the disputed payment. If retention has
  pruned it, the result is flagged incomplete.
