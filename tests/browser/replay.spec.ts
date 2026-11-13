import { expect, test } from "@playwright/test";

test("checkpoint and handoff links reopen the same evidence without evaluating", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Checkpoint 3" }).click();
  await page.getByRole("button", { name: "Copy checkpoint link" }).click();
  await expect(page.getByText("Checkpoint link copied.")).toBeVisible();
  const checkpointLink = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(Object.fromEntries(checkpointLink.searchParams)).toEqual({ scenario: "checkout-01", checkpoint: "checkpoint-3" });

  await page.getByRole("button", { name: "Reveal recommendation" }).click();
  await page.getByRole("button", { name: "Copy handoff" }).click();
  await expect(page.getByText("Handoff copied.")).toBeVisible();
  const handoff = await page.evaluate(() => navigator.clipboard.readText());
  const replayUrl = /^Replay: (.+)$/m.exec(handoff)?.[1];
  expect(replayUrl).toBe(`${checkpointLink.href}&event=evt_003`);

  const recipient = await context.newPage();
  const evaluations: string[] = [];
  recipient.on("request", (request) => {
    if (request.method() === "POST") evaluations.push(request.url());
  });
  await recipient.goto(replayUrl!);
  await expect(recipient.getByRole("button", { name: "Checkpoint 3" })).toHaveAttribute("aria-current", "step");
  await expect(recipient.locator("#event-evt_003")).toBeFocused();
  await expect(recipient.getByRole("button", { name: "Reveal recommendation" })).toBeEnabled();
  expect(evaluations).toEqual([]);

  await recipient.goto(`${checkpointLink.origin}/?scenario=checkout-01&checkpoint=checkpoint-1&event=evt_003`);
  await expect(recipient.getByRole("button", { name: "Checkpoint 1", exact: true })).toHaveAttribute("aria-current", "step");
  await expect(recipient.getByText(/completion failures reached/)).toBeVisible();
  await expect(recipient.locator("#event-evt_003")).toHaveCount(0);
});

test("the checkout demo exposes evidence in order and opens the supporting event", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "http://localhost:3210") externalRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Checkout errors rising" })).toBeVisible();
  await expect(page.getByText(/Repeated database connection acquisition timeouts/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Reveal recommendation" }).click();
  await expect(page.getByText(/Collect the checkout error breakdown/)).toBeVisible();
  await page.getByRole("button", { name: "Next checkpoint" }).click();
  await expect(page.getByText(/web-217/)).toBeVisible();
  await page.getByRole("button", { name: "Next checkpoint" }).click();
  await expect(page.getByText(/repeated database connection acquisition timeouts/i)).toBeVisible();
  await page.getByRole("button", { name: "Reveal recommendation" }).click();
  await expect(page.getByText(/Open the checkout worker pool dashboard/)).toBeVisible();
  await page.getByRole("button", { name: "View supporting event" }).click();
  await expect(page.getByText(/repeated database connection acquisition timeouts/i)).toBeInViewport();
  await page.getByRole("button", { name: "Reveal debrief" }).click();
  await expect(page.getByText(/The frontend release was unrelated/)).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test("live evaluation is explicit and provider failures leave the timeline usable", async ({ page }) => {
  let evaluations = 0;
  await page.route("**/api/scenarios", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), mode: "live" } });
  });
  await page.route("**/api/decisions", async (route) => {
    evaluations++;
    await route.fulfill({ status: 502, json: { error: { code: "credits", message: "Check the available credits in the SubQ Console." } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Next checkpoint" }).click();
  await expect(page.getByText(/web-217/)).toBeVisible();
  expect(evaluations).toBe(0);
  await page.getByRole("button", { name: "Evaluate with SubQ" }).click();
  await expect(page.getByText("Check the available credits in the SubQ Console.")).toBeVisible();
  await expect(page.getByText(/web-217/)).toBeVisible();
  expect(evaluations).toBe(1);
});

test("the replay fits a narrow viewport and checkpoint buttons support keyboard navigation", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  const first = page.getByRole("button", { name: "Checkpoint 1", exact: true });
  const second = page.getByRole("button", { name: "Checkpoint 2", exact: true });
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute("aria-current", "step");
  await expect(page.getByText(/web-217/)).toBeVisible();
  const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasOverflow).toBe(false);
});

test("a slow decision cannot replace the recommendation for a newer checkpoint", async ({ page }) => {
  let releaseResponse!: () => void;
  const responseReady = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/api/decisions", async (route) => {
    await responseReady;
    await route.fulfill({
      json: {
        mode: "demo", status: "insufficient_evidence", actionId: "insufficient_evidence",
        recommendation: "This belongs to the previous checkpoint.", evidence: null,
      },
    }).catch(() => {});
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Reveal recommendation" }).click();
  await expect(page.getByRole("button", { name: "Evaluating…" })).toBeVisible();
  await page.getByRole("button", { name: "Next checkpoint" }).click();
  releaseResponse();
  await expect(page.getByText(/web-217/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal recommendation" })).toBeEnabled();
  await expect(page.getByText("This belongs to the previous checkpoint.")).toHaveCount(0);
});

test("evidence search and new-event filter help isolate late evidence", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Checkpoint 3" }).click();
  await expect(page.getByText(/repeated database connection acquisition timeouts/i)).toBeVisible();
  await page.getByRole("button", { name: /New at this checkpoint/ }).click();
  await expect(page.getByText(/web-217/)).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search evidence" }).fill("missing event");
  await expect(page.getByText("No events match these filters.")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByText(/web-217/)).toBeVisible();
});

test("imported live review requires a fresh acknowledgement at each checkpoint", async ({ page }) => {
  const id = "case-11111111-1111-1111-1111-111111111111";
  const first = {
    id: "evt_a", occurredAt: "2026-11-13T14:05:00Z", availableAt: "2026-11-13T14:05:00Z",
    source: "alerts", kind: "alert", text: "Synthetic imported alert.",
  };
  const second = {
    ...first, id: "evt_b", availableAt: "2026-11-13T14:10:00Z", source: "logs", kind: "log",
    text: "Synthetic late service log.",
  };
  await page.route("**/api/scenarios", async (route) => {
    await route.fulfill({ json: { mode: "live", importsEnabled: true, importedEvaluationEnabled: true, scenarios: [{
      id, kind: "imported", title: "Imported checkout test", briefing: "Review the supplied evidence.",
      checkpoints: [
        { id: "checkpoint-1", label: "Checkpoint 1", cutoffAt: first.availableAt },
        { id: "checkpoint-2", label: "Checkpoint 2", cutoffAt: second.availableAt },
      ],
      actions: [{ id: "verify_impact", label: "Verify the scope of impact" }],
    }] } });
  });
  await page.route(`**/api/scenarios/${id}/checkpoints/*`, async (route) => {
    const isFirst = route.request().url().endsWith("checkpoint-1");
    await route.fulfill({ json: { cutoffAt: isFirst ? first.availableAt : second.availableAt, events: isFirst ? [first] : [first, second] } });
  });
  let evaluations = 0;
  await page.route("**/api/decisions", async (route) => {
    evaluations++;
    expect(route.request().postDataJSON()).toEqual({ scenarioId: id, checkpointId: "checkpoint-2", allowImportedEvidence: true });
    await route.fulfill({ json: {
      mode: "live", status: "recommended", actionId: "verify_impact", evidence: second,
      recommendation: "Compare error rates with the previous hour.", availableEventCount: 2, submittedEventCount: 2,
    } });
  });
  await page.goto("/");
  const evaluate = page.getByRole("button", { name: "Evaluate with SubQ" });
  const acknowledgement = page.getByRole("checkbox", { name: /Allow SubQ to receive/ });
  await expect(page.getByText("Synthetic imported alert.")).toBeVisible();
  await expect(evaluate).toBeDisabled();
  await acknowledgement.check();
  await expect(evaluate).toBeEnabled();
  await page.getByRole("button", { name: "Next checkpoint" }).click();
  await expect(page.getByText("Synthetic late service log.")).toBeVisible();
  await expect(acknowledgement).not.toBeChecked();
  await expect(evaluate).toBeDisabled();
  expect(evaluations).toBe(0);
  await acknowledgement.check();
  await evaluate.click();
  await expect(page.getByText("Compare error rates with the previous hour.")).toBeVisible();
  expect(evaluations).toBe(1);
  await expect(page.getByRole("button", { name: "Reveal debrief" })).toHaveCount(0);
});
