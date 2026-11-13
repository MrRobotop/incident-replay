import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { loadLabels, validateLabels } from "../eval/labels.ts";
import { pairedRequests, runEvaluation } from "../eval/run.ts";
import { loadScenarios } from "../src/replay/scenario.ts";
import { estimateTokens, PRICE_USD_PER_TOKEN } from "../src/subq/contract.ts";
import type { SubqRequest } from "../src/subq/contract.ts";

const entries = loadLabels(loadScenarios());
const flagship = entries.find(({ scenario }) => scenario.id === "checkout-pool-pressure")!;
const key = "evaluation-test-key";

function mockAnswer(request: SubqRequest, inputTokens = 50) {
  const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
    const ids = Object.keys(question.criteria);
    const choice = name === "next_step" ? "insufficient_evidence" : "no_evidence";
    return [name, { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(ids.map((id) => [id, Number(id === choice)])) }];
  }));
  return Response.json({ model: request.model, answers, usage: { input_tokens: inputTokens, output_tokens: 0 } });
}

test("evaluation labels match visible events, scenario revisions, and all checkpoints", () => {
  const { scenario, labels } = flagship;
  assert.throws(() => validateLabels({ ...labels, scenarioVersion: scenario.version + 1 }, scenario), /version/);
  assert.throws(() => validateLabels({ ...labels, checkpoints: {} }, scenario), /cover all checkpoints/);
  const invalid = structuredClone(labels);
  invalid.checkpoints["deploy-visible"].evidenceIds = ["evt_003"];
  assert.throws(() => validateLabels(invalid, scenario), /invalid evidence/);
  invalid.checkpoints["deploy-visible"].evidenceIds = ["evt_002"];
  invalid.checkpoints["initial-alert"].evidenceIds = ["evt_001"];
  assert.throws(() => validateLabels(invalid, scenario), /must be the only action and use no_evidence/);
});

test("demo evaluation checks recorded product decisions and makes no provider calls", async (t) => {
  const fetcher = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider call"); });
  const report = await runEvaluation(entries, { mode: "demo", split: "all" });
  assert.equal(report.source, "Demo fixture");
  assert.equal(report.model, null);
  assert.equal(report.complete, true);
  assert.equal(report.pairedContext, null);
  assert.equal(report.metrics.product.jointActionAndEvidenceAccuracy.value, 1);
  assert.equal(report.metrics.product.attempts, 0);
  assert.equal(fetcher.mock.callCount(), 0);
});

test("paired requests isolate history and retain the same visible runbook context and action questions", () => {
  const { scenario } = flagship;
  const fixture = structuredClone(scenario);
  const point = fixture.checkpoints[1];
  const runbook = { ...fixture.events[0], id: "evt_004", kind: "runbook" };
  fixture.events.push(runbook);
  point.observationEventId = "evt_001";
  const { latest, history } = pairedRequests(fixture, point);
  assert.deepEqual(latest.questions, history.questions);
  assert.equal(latest.questions.supporting_event, undefined);
  assert.equal(latest.state.observationEventId, "evt_002");
  assert.equal(history.state.observationEventId, latest.state.observationEventId);
  assert.deepEqual(latest.state.events.map(({ id }) => id), ["evt_004", "evt_002"]);
  assert.deepEqual(history.state.events.map(({ id }) => id), ["evt_001", "evt_004", "evt_002"]);
  fixture.events.find(({ id }) => id === "evt_003")!.text = "FUTURE_CONTENT";
  fixture.debrief.summary = "OUTCOME_CONTENT";
  assert.deepEqual(pairedRequests(fixture, point), { latest, history });
});

test("live-shaped evaluation scores paired and product arms and preserves only normalized responses", async () => {
  const requests: SubqRequest[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as SubqRequest;
    requests.push(request);
    return mockAnswer(request);
  };
  const report = await runEvaluation([flagship], { mode: "live", split: "development", key, fetcher, maxAttempts: 10, maxCostUsd: 1 });
  assert.equal(report.source, "Offline mock");
  assert.equal(report.complete, true);
  assert.equal(report.metrics.product.checkpoints, 3);
  assert.equal(report.metrics.product.abstentionRecall.value, 1);
  assert.equal(report.metrics.product.abstentionPrecision.value, 1 / 3);
  assert.equal(report.metrics.product.jointActionAndEvidenceAccuracy.value, 1 / 3);
  assert.equal(report.metrics.product.meteredInputTokens, 150);
  assert.equal(report.pairedContext?.pairedCheckpoints, 3);
  assert.equal(report.pairedContext?.acceptedAccuracyDifference, 0);
  assert.equal(requests.length, 9);
  assert.equal(requests.filter((request) => request.questions.supporting_event).length, 3);
  assert.ok(report.budget && report.budget.reservedCostUsd > 0);
  assert.equal(report.budget.attempts, 9);
  assert.equal(report.budget.meteredInputTokens, 450);
  assert.equal(report.budget.attemptsWithoutUsage, 0);
  assert.ok(!JSON.stringify(report).includes(key));
  assert.ok(!JSON.stringify(report).includes(flagship.scenario.events[0].text));
});

test("attempt and spend caps reject retries before egress and retain the partial report", async () => {
  const { scenario } = flagship;
  const estimate = estimateTokens(pairedRequests(scenario, scenario.checkpoints[0]).latest);
  for (const limit of [{ maxAttempts: 1, maxCostUsd: 1 }, { maxAttempts: 10, maxCostUsd: (estimate + 0.5) * PRICE_USD_PER_TOKEN }]) {
    let sends = 0;
    const fetcher: typeof fetch = async () => {
      sends++;
      return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
    };
    const report = await runEvaluation([flagship], { mode: "live", split: "all", key, fetcher, ...limit });
    assert.equal(sends, 1);
    assert.equal(report.complete, false);
    assert.equal(report.stopCode, "budget");
    assert.equal(report.metrics.latest.attempts, 1);
    assert.equal(report.metrics.latest.attemptsWithoutUsage, 1);
    assert.equal(report.budget?.reservedInputTokens, estimate);
    assert.equal(report.metrics.product.attempts, 0);
  }
});

test("eval CLI requires explicit mode even when live mode is configured", () => {
  assert.throws(() => execFileSync(process.execPath, ["eval/cli.ts"], {
    env: { ...process.env, SUBQ_API_KEY: key, INCIDENT_REPLAY_MODE: "live" },
    stdio: "pipe",
  }), (error: unknown) => typeof error === "object" && error !== null && "status" in error && error.status === 2);
});
