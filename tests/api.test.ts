import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/replay/config.ts";
import { demoDecision } from "../src/replay/decision.ts";
import { ReplayError } from "../src/replay/errors.ts";
import { loadScenarios } from "../src/replay/scenario.ts";
import { createApi, jsonResponse } from "../src/server/api.ts";

const origin = "http://localhost:3000";
const scenarios = loadScenarios();
const input = { scenarioId: "checkout-01", checkpointId: "checkpoint-1" };

function request(body: unknown = input, from = origin) {
  return new Request(origin + "/api/decisions", {
    method: "POST", headers: { origin: from, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("public APIs use neutral IDs, limit events by cutoff, and expose debrief only through final reveal", async () => {
  const api = createApi(readConfig({}), scenarios, async () => { throw new Error("Demo must not call provider"); });
  const serialized = JSON.stringify(api.list());
  assert.doesNotMatch(serialized, /checkout-pool-pressure|worker-telemetry|14:02|debrief/);
  assert.deepEqual(api.checkpoint("checkout-01", "checkpoint-1").events.map(({ id }) => id), ["evt_001"]);
  assert.throws(() => api.debrief("checkout-01", "checkpoint-1"), { code: "input" });
  assert.match(api.debrief("checkout-01", "checkpoint-3").summary, /trace/);
  assert.equal((await api.decide(request())).mode, "demo");
});

test("decision endpoint rejects cross-origin, oversize and unknown inputs without egress", async () => {
  const api = createApi(readConfig({}), scenarios, async () => { throw new Error("Must not call provider"); });
  assert.equal((await jsonResponse(() => api.decide(request(input, "https://other.example")))).status, 403);
  assert.equal((await jsonResponse(() => api.decide(request({ ...input, key: "unexpected" })))).status, 400);
  assert.equal((await jsonResponse(() => api.decide(request({ ...input, checkpointId: "x".repeat(5000) })))).status, 400);
  assert.equal((await jsonResponse(() => api.decide(request({ ...input, checkpointId: "checkpoint-9" })))).status, 404);
});

test("live handler uses its own key and logs safe metadata, never the key or raw scores", async () => {
  const key = "test-host-only-credential";
  const logs: Record<string, unknown>[] = [];
  const config = readConfig({ INCIDENT_REPLAY_MODE: "live", SUBQ_API_KEY: key, INCIDENT_REPLAY_DAILY_ATTEMPTS: "1" });
  const api = createApi(config, scenarios, async (_scenario, _point, serverKey, options) => {
    assert.equal(serverKey, key);
    options?.reserveAttempt?.();
    return { ...demoDecision(scenarios[0], scenarios[0].checkpoints[0]), mode: "live", model: "subq-snap-1.2", elapsedMs: 12, inputTokens: 123, estimatedCostUsd: 0.00000492, probabilities: { insufficient_evidence: 0.9 } };
  }, (record) => logs.push(record));
  const response = await jsonResponse(() => api.decide(request()));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.text();
  assert.doesNotMatch(payload + JSON.stringify(logs), /test-host-only-credential|probabilities/);
  assert.equal(logs[0].attempts, 1);
  assert.equal((await jsonResponse(() => api.decide(request()))).status, 429);
});

test("live errors preserve the timeline and return safe recovery guidance", async () => {
  const api = createApi(readConfig({ INCIDENT_REPLAY_MODE: "live", SUBQ_API_KEY: "fake" }), scenarios, async () => {
    throw new ReplayError("credits", "Check SubQ credits.");
  }, () => {});
  const response = await jsonResponse(() => api.decide(request()));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: "credits", message: "Check SubQ credits." } });
  assert.equal(api.health().status, "ready");
  assert.equal(api.checkpoint("checkout-01", "checkpoint-1").events.length, 1);
});
