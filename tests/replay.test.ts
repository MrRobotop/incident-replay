import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { demoDecision } from "../src/replay/decision.ts";
import { loadScenarios, parseScenario, resolveCheckpoint, resolveScenario, visibleEvents } from "../src/replay/scenario.ts";

const scenario = resolveScenario(loadScenarios(), "checkout-pool-pressure");

test("replay uses availability rather than occurrence and includes the exact cutoff", () => {
  const events = scenario.checkpoints.map((point) => visibleEvents(scenario, point.cutoffAt).map((event) => event.id));
  assert.deepEqual(events, [["evt_001"], ["evt_001", "evt_002"], ["evt_001", "evt_002", "evt_003"]]);
  assert.equal(visibleEvents(scenario, "2026-11-10T14:12:59Z").some(({ id }) => id === "evt_003"), false);
  const shuffled = structuredClone(scenario);
  shuffled.events.reverse();
  shuffled.events.find(({ id }) => id === "evt_002")!.availableAt = shuffled.events.find(({ id }) => id === "evt_001")!.availableAt;
  assert.deepEqual(visibleEvents(shuffled, scenario.checkpoints[2].cutoffAt).map(({ id }) => id), events[2]);
});

test("fixture validation rejects duplicate IDs, bad timestamps, and evidence from the future", () => {
  const duplicate = structuredClone(scenario);
  duplicate.events.push(duplicate.events[0]);
  assert.throws(() => parseScenario(duplicate), /Duplicate ID/);
  const unavailable = structuredClone(scenario);
  unavailable.checkpoints[0].observationEventId = "evt_003";
  assert.throws(() => parseScenario(unavailable), /Unavailable observation/);
  const malformed = structuredClone(scenario);
  malformed.events[0].occurredAt = "not a date";
  assert.throws(() => parseScenario(malformed), /occurredAt/);
  const future = structuredClone(scenario);
  future.demo["initial-alert"] = { actionId: "inspect_pool_metrics", evidenceId: "evt_003" };
  assert.throws(() => parseScenario(future), /Invalid demo decision/);
});

test("demo returns next step and evidence from the current checkpoint with zero submitted events", () => {
  const initial = demoDecision(scenario, resolveCheckpoint(scenario, "initial-alert"));
  assert.equal(initial.status, "insufficient_evidence");
  assert.equal(initial.recommendation, scenario.fallback);
  const result = demoDecision(scenario, resolveCheckpoint(scenario, "worker-telemetry"));
  assert.equal(result.actionId, "inspect_pool_metrics");
  assert.equal(result.evidence?.id, "evt_003");
  assert.equal(result.submittedEventCount, 0);
});

test("the CLI runs the flagship progression without a key", () => {
  const expected = ["insufficient_evidence", "compare_deploy_timeline", "inspect_pool_metrics"];
  for (const [index, point] of scenario.checkpoints.entries()) {
    const child = spawnSync(process.execPath, ["src/cli/replay.ts", "--scenario", scenario.id, "--checkpoint", point.id, "--json"], {
      encoding: "utf8", env: { ...process.env, SUBQ_API_KEY: "", INCIDENT_REPLAY_MODE: "demo" },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).actionId, expected[index]);
  }
});
