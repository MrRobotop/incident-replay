import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readBoundedJsonWithSize } from "../src/import/files.ts";
import { createPrivateCase } from "../src/import/normalize.ts";
import { loadImportedScenarios } from "../src/server/imported.ts";

const alert = {
  occurredAt: "2026-11-13T14:02:00.125Z", availableAt: "2026-11-13T14:02:02.125Z",
  source: "alerts", kind: "alert", text: "Checkout latency is high.",
};
const loki = { status: "success", data: { resultType: "streams", result: [
  { stream: { service_name: "checkout" }, values: [["1794578521100000000", "Database timeout; Authorization: Bearer test-token-123; contact customer@example.invalid"]] },
] } };
const github = [{
  id: 123, state: "success", environment: "production", created_at: "2026-11-13T14:02:04Z",
  description: "Frontend rollout completed.", irrelevant: "PRIVATE_TOKEN_FROM_UNUSED_FIELD",
}];

test("normalizes multi-source exports, redacts text, and preserves availability boundaries", () => {
  const { incident, assumedAvailabilityCount, duplicatesRemoved } = createPrivateCase({
    title: "Checkout test",
    sources: [
      { format: "events", data: [alert, alert] },
      { format: "loki", data: loki },
      { format: "github", data: github },
    ],
  });
  assert.equal(incident.events.length, 3);
  assert.equal(assumedAvailabilityCount, 2);
  assert.equal(duplicatesRemoved, 1);
  const byKind = Object.fromEntries(incident.events.map((entry) => [entry.kind, entry]));
  assert.equal(byKind.alert.occurredAt, "2026-11-13T14:02:00Z");
  assert.equal(byKind.alert.availableAt, "2026-11-13T14:02:03Z");
  assert.equal(byKind.log.source, "Loki / checkout");
  assert.match(byKind.deploy.text, /success in production/);
  assert.doesNotMatch(JSON.stringify(incident), /test-token-123|customer@example|PRIVATE_TOKEN_FROM_UNUSED_FIELD/);
});

test("import rejects invalid clocks and refuses to read beyond a supplied byte limit", (t) => {
  assert.throws(() => createPrivateCase({
    title: "Checkout test",
    sources: [{ format: "events", data: [{ ...alert, availableAt: "2026-11-13T14:02:00.124Z" }] }],
  }), /earlier than occurredAt/);
  const dir = mkdtempSync(join(tmpdir(), "replay-import-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "events.json");
  const json = JSON.stringify([alert]);
  writeFileSync(file, json);
  assert.throws(() => readBoundedJsonWithSize(file, 10), /exceeds/);
  assert.equal(readBoundedJsonWithSize(file, Buffer.byteLength(json)).bytes, Buffer.byteLength(json));
});

test("documented CLI exports a private case that the server can replay", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "replay-import-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = spawnSync(process.execPath, [
    "src/import/cli.ts", "--title", "Checkout incident", "--events", "examples/checkout-events.json", "--output", dir,
  ], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const [file] = readdirSync(dir);
  assert.match(file, /^case-[a-f0-9-]+\.json$/);
  const path = join(dir, file);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).events.length, 3);
  const [scenario] = loadImportedScenarios(dir);
  assert.equal(scenario.title, "Checkout incident");
  assert.equal(scenario.checkpoints.length, 3);
});
