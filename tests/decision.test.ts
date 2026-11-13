import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createBudget } from "../src/replay/budget.ts";
import { readConfig } from "../src/replay/config.ts";
import { liveDecision } from "../src/replay/live.ts";
import { loadScenarios, resolveCheckpoint, resolveScenario } from "../src/replay/scenario.ts";
import { buildRequest, MAX_EVENTS, parseResponse } from "../src/subq/contract.ts";
import type { SubqRequest } from "../src/subq/contract.ts";

const scenario = resolveScenario(loadScenarios(), "checkout-pool-pressure");
const first = resolveCheckpoint(scenario, "initial-alert");
const last = resolveCheckpoint(scenario, "worker-telemetry");

function reply(request: SubqRequest, action = "inspect_pool_metrics", evidence = "evt_003") {
  const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
    const choice = name === "next_step" ? action : evidence;
    return [name, {
      type: "choice", choice, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, Number(key === choice)])),
    }];
  }));
  return { model: request.model, answers, usage: { input_tokens: 10_000, output_tokens: 0 } };
}

test("future events, fixture labels, and debrief are absent from and cannot change the request", () => {
  const modified = structuredClone(scenario);
  modified.events[2].text = "Modified future evidence";
  modified.demo[first.id].evidenceId = "changed";
  modified.debrief.summary = "Modified solution";
  assert.equal(JSON.stringify(buildRequest(modified, first)), JSON.stringify(buildRequest(scenario, first)));
  assert.deepEqual(Object.keys(buildRequest(scenario, first).request.questions.supporting_event!.criteria), ["evt_001", "no_evidence"]);
});

test("context trimming preserves the observation, exact options, and caps", () => {
  const expanded = structuredClone(scenario);
  expanded.events.push(...Array.from({ length: 150 }, (_, index) => ({
    ...scenario.events[0], id: `extra_${index}`, text: "Synthetic event",
  })));
  const { events, request } = buildRequest(expanded, last);
  assert.equal(events.length, MAX_EVENTS);
  assert(events.some(({ id }) => id === last.observationEventId));
  assert.equal(Object.keys(request.questions.supporting_event!.criteria).length, MAX_EVENTS + 1);
  expanded.events.find(({ id }) => id === last.observationEventId)!.text = "x".repeat(200_000);
  assert.throws(() => buildRequest(expanded, last), /exceed the input budget/);
});

test("parser rejects unknown evidence, malformed probabilities, and mismatched model", () => {
  const { request } = buildRequest(scenario, last);
  assert.throws(() => parseResponse(reply(request, "inspect_pool_metrics", "future"), request), { code: "invalid_response" });
  const invalid = reply(request);
  invalid.answers.next_step.probabilities.inspect_pool_metrics = 0.25;
  assert.throws(() => parseResponse(invalid, request), { code: "invalid_response" });
  assert.throws(() => parseResponse({ ...reply(request), model: "unexpected" }, request), { code: "invalid_response" });
});

test("the live service maps a valid result, maps no evidence to abstention, and reports provider failures", async () => {
  const { request } = buildRequest(scenario, last);
  const result = await liveDecision(scenario, last, "test-key", {
    fetcher: async () => Response.json(reply(request)),
  });
  assert.equal(result.evidence?.id, "evt_003");
  assert.equal(result.estimatedCostUsd, 0.0004);
  const abstain = await liveDecision(scenario, last, "test-key", {
    fetcher: async () => Response.json(reply(request, "inspect_pool_metrics", "no_evidence")),
  });
  assert.equal(abstain.status, "insufficient_evidence");
  assert.equal(abstain.recommendation, scenario.fallback);
  await assert.rejects(liveDecision(scenario, last, "test-key", {
    fetcher: async () => new Response(null, { status: 402 }),
  }), { code: "credits" });
});

test("web budget charges each reservation, releases failed slots, and resets at midnight UTC", async () => {
  let date = new Date("2026-11-10T23:59:59Z");
  const budget = createBudget(2, 1, () => date);
  const active = Promise.withResolvers<void>();
  const run = budget.run(async (reserve) => { reserve(); await active.promise; reserve(); throw new Error("test failure"); });
  await assert.rejects(budget.run(async () => {}), { code: "busy" });
  active.resolve();
  await assert.rejects(run, /test failure/);
  await assert.rejects(budget.run(async () => {}), { code: "budget" });
  date = new Date("2026-11-11T00:00:00Z");
  await budget.run(async (reserve) => reserve());
});

test("demo ignores the provider key and a live CLI invocation requires explicit configuration", () => {
  assert.equal(readConfig({ SUBQ_API_KEY: "fake" }).key, undefined);
  const child = spawnSync(process.execPath, ["src/cli/replay.ts", "--scenario", scenario.id, "--checkpoint", last.id, "--mode", "live"], {
    encoding: "utf8", env: { ...process.env, INCIDENT_REPLAY_MODE: "demo", SUBQ_API_KEY: "fake-key" },
  });
  assert.equal(child.status, 3);
  assert.match(child.stderr, /INCIDENT_REPLAY_MODE=live/);
  assert.doesNotMatch(child.stderr, /fake-key/);
});
