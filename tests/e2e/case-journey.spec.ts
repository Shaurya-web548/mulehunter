/**
 * Real browser journey on a production build with real persistence:
 * report → protect → trace → inspect → review/freeze → rejected future debit
 * → report export; plus viewer authorization and /hunt regression.
 */
import { expect, test, type Page } from "@playwright/test";

const CODE = "e2e-operator-code";

async function signIn(page: Page, role: "operator" | "viewer", name: string) {
  await page.getByLabel("Your name").fill(name);
  if (role === "viewer") await page.getByText("Viewer (read-only)").click();
  else await page.getByLabel("Operator code").fill(CODE);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("complaint → containment journey in the browser", async ({ page }) => {
  await page.goto("/cases/new");
  await signIn(page, "operator", "Asha Investigator");

  // --- seed the deterministic scenario (executed later through the gate)
  await page.getByRole("button", { name: "Seed complaint demo scenario" }).click();
  await expect(page.getByText(/Seeded\. Victim/)).toBeVisible();

  // --- load the victim's payments until the seeded ₹2,40,000 payment has executed
  const row = page.getByRole("checkbox", { name: /Dispute ₹2\.40 L/ });
  await expect(async () => {
    await page.getByRole("button", { name: "Load victim's payments" }).click();
    await expect(row).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  // nothing is pre-selected
  await expect(row).not.toBeChecked();
  await row.check();
  await expect(page.getByRole("checkbox", { name: /Protect victim account/ })).toBeChecked();

  // wait for the scenario's layering (≈11 s after seeding) so the trace has depth
  await page.waitForTimeout(12_000);
  await page.getByRole("button", { name: "File complaint" }).click();
  await page.waitForURL(/\/cases\/case_/);
  const caseId = page.url().split("/cases/")[1];

  // --- protected, from committed state
  const steps = page.getByRole("list", { name: "Case workflow" });
  await expect(steps.getByText("Victim protected")).toBeVisible();
  await expect(page.locator("section[aria-labelledby=h-holds]").getByText("Victim protection", { exact: true })).toBeVisible();

  // --- trace
  await page.getByRole("button", { name: "Trace transactions" }).click();
  await expect(page.getByRole("status")).toContainText(/Trace revision 1 committed/);
  await expect(page.getByRole("img", { name: /Money-flow graph/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Paths/ })).toBeVisible();
  await expect(page.getByText(/cycle/).first()).toBeVisible();

  // --- analyze
  await page.getByRole("button", { name: "Analyze patterns" }).click();
  await expect(page.getByRole("status")).toContainText(/Analysis revision 1: 5 suspected, 5 eligible/);
  // the victim is excluded and has no selection box
  await expect(page.getByText("case victim — never classified as a mule")).toBeVisible();
  // an innocent downstream counterparty is shown as reachability-only
  await expect(page.getByText("reachability only — not evidence").first()).toBeVisible();

  // --- review + freeze two selected accounts
  const boxes = page.getByRole("checkbox", { name: /Select .* for a simulated debit freeze/ });
  await expect(boxes).toHaveCount(5);
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByLabel(/Reason \(recorded on each hold/).fill("Reviewed fan-out, velocity and cycle evidence in r1");
  await page.getByRole("button", { name: /Freeze 2 selected/ }).click();
  await expect(page.getByRole("status")).toContainText(/Applied: simulated debit freeze on 2 account/);
  await expect(steps.getByText("Mule accounts frozen")).toBeVisible();

  // --- a subsequent outgoing debit from a frozen account is rejected at the gate
  const analysis = await (await page.request.get(`/api/cases/${caseId}/analysis`)).json();
  const frozen = analysis.data.candidates.find((c: { caseHold: string | null }) => c.caseHold);
  expect(frozen).toBeTruthy();
  const pay = await page.request.post("/api/payments", {
    headers: { "x-netra-csrf": "1" },
    data: { fromId: frozen.accountId, toId: analysis.data.candidates.find((c: { role: string }) => c.role === "VICTIM").accountId, amountMinor: 100_000, attemptId: "e2e-after-freeze-1" },
  });
  const payBody = await pay.json();
  expect(payBody.data.status).toBe("REJECTED");
  expect(payBody.data.rejectReason).toBe("HOLD");
  // the outcome panel shows the observed rejection (polled from the ledger)
  await expect(page.getByText(/Blocked attempt observed/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Rejected payment attempts (0)")).toHaveCount(0);

  // retrying the SAME payment with the same attempt id replays — no second attempt
  const victimId = analysis.data.candidates.find((c: { role: string }) => c.role === "VICTIM").accountId;
  const again = await page.request.post("/api/payments", {
    headers: { "x-netra-csrf": "1" },
    data: { fromId: frozen.accountId, toId: victimId, amountMinor: 100_000, attemptId: "e2e-after-freeze-1" },
  });
  expect((await again.json()).data.replayed).toBe(true);
  // reusing the attempt id for a DIFFERENT payment is refused
  const conflict = await page.request.post("/api/payments", {
    headers: { "x-netra-csrf": "1" },
    data: { fromId: frozen.accountId, toId: victimId, amountMinor: 999, attemptId: "e2e-after-freeze-1" },
  });
  expect(conflict.status()).toBe(409);
  expect((await conflict.json()).error.code).toBe("ATTEMPT_ID_CONFLICT");

  // --- recovery: return the victim's attributed money from the frozen accounts
  const before = (await (await page.request.get(`/api/cases/${caseId}`)).json()).data.victim.balanceMinor as number;
  const recoverBtn = page.getByRole("button", { name: /^Recover ₹/ });
  await expect(recoverBtn).toBeEnabled();
  await recoverBtn.click();
  await expect(page.getByRole("status")).toContainText(/Recovered ₹.* to the victim in \d transfer/);
  const rec = (await (await page.request.get(`/api/cases/${caseId}/recoveries`)).json()).data;
  const total = rec.transfers.reduce((s: number, t: { amountMinor: number }) => s + t.amountMinor, 0);
  expect(total).toBeGreaterThan(0);
  const afterBal = (await (await page.request.get(`/api/cases/${caseId}`)).json()).data.victim.balanceMinor as number;
  expect(afterBal - before).toBe(total);
  await expect(page.getByText(/Recovered to victim: ₹/).first()).toBeVisible();

  // --- report export (deterministic, evidence-based)
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download report (.md)" }).click()]);
  const text = await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8"));
  expect(text).toContain(`NETRA case report — ${caseId}`);
  expect(text).toContain("Money trail & recovery");
  expect(text).toMatch(/Recovered to victim: ₹[1-9]/);
  expect(text).not.toMatch(/isMule|scenario/i);

  // --- SSE: a signed-in client receives a resync event on (re)connect
  const gotResync = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const es = new EventSource("/api/stream?only=cases");
        const t = setTimeout(() => {
          es.close();
          resolve(false);
        }, 10_000);
        es.addEventListener("resync", () => {
          clearTimeout(t);
          es.close();
          resolve(true);
        });
      }),
  );
  expect(gotResync).toBe(true);
});

test("a viewer can read but the server refuses protect/freeze/release", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/cases");
  await signIn(page, "viewer", "Ravi Viewer");
  await expect(page.getByRole("heading", { name: "Cases" })).toBeVisible();
  const list = await (await page.request.get("/api/cases")).json();
  expect(list.ok).toBe(true);
  const caseId = list.data.items[0]?.id;
  expect(caseId).toBeTruthy();

  await page.goto(`/cases/${caseId}`);
  await expect(page.getByText(/Read-only \(viewer\)/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Trace|Protect victim|Freeze/ })).toHaveCount(0);

  // UI hiding is not the control: the API refuses directly
  const freeze = await page.request.post(`/api/cases/${caseId}/holds`, {
    headers: { "x-netra-csrf": "1" },
    data: { kind: "MULE_DEBIT_FREEZE", analysisRevision: 1, policy: "MANUAL", accountIds: ["x"], reason: "viewer attempt", actionKey: "viewer-attempt-1" },
  });
  expect(freeze.status()).toBe(403);
  const release = await page.request.post(`/api/holds/hold_x/release`, { headers: { "x-netra-csrf": "1" }, data: { reason: "viewer attempt" } });
  expect(release.status()).toBe(403);
  // no CSRF header → refused even with a valid cookie
  const noCsrf = await page.request.post(`/api/cases/${caseId}/trace`, { data: {} });
  expect(noCsrf.status()).toBe(403);
  // case APIs do not expose simulator truth
  const trace = await (await page.request.get(`/api/cases/${caseId}/trace`)).text();
  expect(trace).not.toMatch(/isMule|is_mule|scenarioId|scenario_id/);
  await ctx.close();
});

test("regression: /hunt console streams, injects an attack and keeps the legacy API shape", async ({ page }) => {
  await page.goto("/hunt");
  await expect(page.getByText("engine live")).toBeVisible();
  await expect(page.getByText("TPS").locator("..")).not.toContainText("—", { timeout: 15_000 });
  const res = await page.request.post("/api/attack", { data: { pattern: "fanout_layering" } });
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.amount).toBe("number");
  expect(Number.isInteger(body.amountMinor)).toBe(true);
  await expect(page.getByText(/Attack scenario injected/).first()).toBeVisible();
  // unauthenticated freeze from the old console is refused with the old error shape
  const fr = await page.request.post("/api/freeze", { headers: { "x-netra-csrf": "1" }, data: { ringId: "ring_x" } });
  expect(fr.status()).toBe(401);
  expect((await fr.json()).error).toBe("unauthenticated");
  // live report fallback still works without an API key
  const rep = await page.request.post("/api/report", { data: { ringId: "missing" } });
  expect(rep.status()).toBe(404);
});
