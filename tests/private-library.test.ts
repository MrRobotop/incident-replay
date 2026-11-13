import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parsePrivateCase } from "../src/import/case.ts";
import { readConfig } from "../src/replay/config.ts";
import { mapDecision } from "../src/replay/decision.ts";
import { loadScenarios } from "../src/replay/scenario.ts";
import { createApi, jsonResponse } from "../src/server/api.ts";
import { importedScenario, loadImportedScenarios } from "../src/server/imported.ts";
import { buildRequest } from "../src/subq/contract.ts";

const origin = "http://localhost:3000";
const id = "case-11111111-1111-1111-1111-111111111111";
const fixture = {
  schemaVersion: 1, version: 1, id,
  title: "Synthetic imported incident", briefing: "Checkout is failing.",
  events: [
    { id: "evt_a", occurredAt: "2026-11-13T14:05:00Z", availableAt: "2026-11-13T14:05:00Z", source: "alerts", kind: "alert", text: "Latency is high." },
    { id: "evt_b", occurredAt: "2026-11-13T14:02:00Z", availableAt: "2026-11-13T14:10:00Z", source: "service", kind: "log", text: "Pool wait increased; token=TEST_SECRET_VALUE." },
  ],
};
const scenario = importedScenario(parsePrivateCase(fixture));
const bundled = loadScenarios();
const key = "test-host-only-key";

function request(allowImportedEvidence?: true, from = origin) {
  return new Request(origin + "/api/decisions", {
    method: "POST", headers: { origin: from, "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: id, checkpointId: "checkpoint-1", allowImportedEvidence }),
  });
}

test("imported timeline groups events by availability and limits checkpoint count", () => {
  const events = Array.from({ length: 15 }, (_, index) => ({
    ...fixture.events[0], id: `evt-${index}`,
    availableAt: `2026-11-13T14:${String(index + 10)}:00Z`,
  }));
  const derived = importedScenario(parsePrivateCase({ ...fixture, events }));
  assert.equal(derived.checkpoints.length, 8);
  assert.equal(derived.checkpoints[0].cutoffAt, events[0].availableAt);
  assert.equal(derived.checkpoints.at(-1)?.cutoffAt, events.at(-1)?.availableAt);
  assert.equal(new Set(derived.checkpoints.map(({ cutoffAt }) => cutoffAt)).size, 8);
});

test("private incident loading masks common secrets and rejects symlinks and duplicate case IDs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "replay-private-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = join(dir, "case.json");
  const duplicate = join(dir, "duplicate.json");
  writeFileSync(first, JSON.stringify(fixture), { mode: 0o600 });
  const imported = loadImportedScenarios(dir);
  assert.equal(imported.length, 1);
  assert.doesNotMatch(JSON.stringify(imported), /TEST_SECRET_VALUE/);
  writeFileSync(duplicate, JSON.stringify(fixture));
  assert.throws(() => loadImportedScenarios(dir), { code: "configuration" });
  rmSync(duplicate);
  symlinkSync(first, duplicate);
  assert.throws(() => loadImportedScenarios(dir), { code: "configuration" });
});

test("imported replay works locally in demo and has no invented answers or debrief", async () => {
  const api = createApi(readConfig({ INCIDENT_REPLAY_IMPORT_DIR: "private-incidents" }), [...bundled, scenario],
    async () => { throw new Error("Unexpected network request"); });
  assert.equal(api.list().scenarios.at(-1)?.kind, "imported");
  assert.equal(api.list().importedEvaluationEnabled, false);
  assert.deepEqual(api.checkpoint(id, "checkpoint-1").events.map(({ id }) => id), ["evt_a"]);
  assert.deepEqual(api.checkpoint(id, "checkpoint-2").events.map(({ id }) => id), ["evt_a", "evt_b"]);
  assert.throws(() => api.debrief(id, "checkpoint-2"), { code: "not_found" });
  assert.equal((await jsonResponse(() => api.decide(request(true)))).status, 403);
});

test("imported evaluation requires host policy, per-request consent and exact origin", async () => {
  const env = { INCIDENT_REPLAY_MODE: "live", SUBQ_API_KEY: key, INCIDENT_REPLAY_IMPORT_DIR: "private-incidents" };
  let calls = 0;
  const runLive: NonNullable<Parameters<typeof createApi>[2]> = async (incident, point, secret, options) => {
    assert.equal(secret, key);
    calls++;
    options?.reserveAttempt?.();
    const { request, events, availableCount } = buildRequest(incident, point);
    assert.deepEqual(request.state.events.map(({ id }) => id), ["evt_a"]);
    assert.doesNotMatch(JSON.stringify(request), /evt_b|Synthetic imported incident|TEST_SECRET_VALUE/);
    return {
      ...mapDecision(incident, point, events, availableCount, { actionId: "verify_impact", evidenceId: "evt_a" }, "live"),
      model: "subq-snap-1.2", elapsedMs: 10, inputTokens: 100, estimatedCostUsd: 0.000004, probabilities: {},
    };
  };
  const blocked = createApi(readConfig(env), [scenario], runLive, () => {});
  assert.equal((await jsonResponse(() => blocked.decide(request(true)))).status, 403);
  const allowed = createApi(readConfig({ ...env, INCIDENT_REPLAY_ALLOW_IMPORTED_SUBQ: "true" }), [scenario], runLive, () => {});
  assert.equal((await jsonResponse(() => allowed.decide(request()))).status, 400);
  assert.equal((await jsonResponse(() => allowed.decide(request(true, "https://example.invalid")))).status, 403);
  assert.equal(calls, 0);
  const response = await jsonResponse(() => allowed.decide(request(true)));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).evidence.id, "evt_a");
  assert.equal(calls, 1);
});
