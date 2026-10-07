# V2 demo — complaint to containment (≈ 5 minutes)

## Start

```bash
cd mulehunter
npm install
# Windows PowerShell:  $env:MNH_OPERATOR_CODE="netra-demo-2026"; $env:MNH_DEMO_AUTO_ENFORCE="1"; npm run dev
# bash:                MNH_OPERATOR_CODE=netra-demo-2026 MNH_DEMO_AUTO_ENFORCE=1 npm run dev
```

Open http://localhost:3000. If you do not set `MNH_OPERATOR_CODE`, the server
console prints a generated operator code on the first API request.

To demo a production build without disturbing a dev server: `npm run build:verify`,
then start it with `NEXT_DIST_DIR=.next-verify npx next start -p 3100`.

## Script

1. **Live console (unchanged).** Open `/hunt`, inject "Fan-out layering" and watch the ring
   light up. "Freeze ring (simulated)" now asks for operator sign-in and creates
   durable holds. The "Blocked attempts" tile counts gate rejections, not "money saved".
2. **Report fraud.** Go to `/cases/new`, sign in as **Operator**, then click **Seed complaint demo scenario**.
   The victim `meera.iyer.*` pays ₹2,40,000. Layering finishes about 11 s later, and queued
   cash-outs start about 2 minutes later.
3. After about 11 s, click **Load victim's payments**. Tick the ₹2.40 L payment (nothing is
   pre-selected), keep **Protect victim account** checked, and click **File complaint**.
4. **Case workspace.** The stepper shows *Fraud reported ✓* and *Victim protected ✓*, both from
   committed state. Click **Trace transactions**. The graph shows
   Victim → A → B → F → G, the fan-out from A, and the C → H → I → C loop.
   The paths and transfers tables give the same data accessibly.
5. Click **Analyze patterns**. Expect 5 suspected mules and 5 eligible. Open "explain" on
   a few accounts:
   - the victim is excluded;
   - `anil.mehta.*` and `jaya.nair.*` show "reachability only — not evidence" (innocent recipients);
   - `deals4u.*` and `f.rental.*` show velocity but fall below the threshold;
   - `cashpoint.*` has no behaviour yet.
6. Select the eligible accounts, enter a reason and click **Freeze N selected**. (Or use
   **Demo auto-policy** when `MNH_DEMO_AUTO_ENFORCE=1`.)
7. Wait for the queued cash-outs, about 2 minutes after seeding. The outcome panel shows
   **Blocked attempt observed** and the rejected attempts with their ids. The attempted
   amount from `quickpay.*` exceeds its held balance, and the panel says so.
   `cashpoint.*` was not frozen, so its cash-outs succeed; the outcome shows this honestly.
   A **Re-trace** plus **Re-analyze** now flags it from its cash-out velocity (a new revision).
8. **Money trail & recovery.** The panel shows where the ₹2,40,000 is now: recoverable in
   frozen accounts, at risk in unfrozen accounts (including the innocent recipients),
   cashed out, and spent. Click **Recover ₹… to victim**: the victim's attributed money comes
   back from the frozen mules (₹74,500 when all five are frozen before the cash-outs), and
   the victim's balance rises by exactly that amount.
9. **Release** one hold with a reason. If another case also holds that account, it stays blocked.
10. **Download report (.md)**: a deterministic report built from persisted evidence.
11. **Restart the server.** The case, holds, balances, trace/analysis revisions and outcome are
    all still there. Sign in again unless `MNH_SESSION_SECRET` is set.

## Verification commands (all executed during the upgrade; see UPGRADE_STATUS.md)

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # node --test: unit + integration on real SQLite
npm run test:e2e    # isolated production build + Playwright browser journey
```
