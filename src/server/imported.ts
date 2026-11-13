import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_CASE_BYTES, parsePrivateCase } from "../import/case.ts";
import type { PrivateCase } from "../import/case.ts";
import { readBoundedJsonWithSize } from "../import/files.ts";
import { ReplayError } from "../replay/errors.ts";
import type { ImportedScenario } from "../replay/scenario.ts";

const MAX_CASES = 50;
const MAX_LIBRARY_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINTS = 8;

const actions = [
  {
    id: "compare_changes",
    label: "Compare recent changes",
    criteria: "Use when change or deployment timing can distinguish a regression from an unrelated event.",
    instructions: "Compare the affected service, release version, and first failure against the change record. Check whether unaffected instances ran the same version.",
  },
  {
    id: "inspect_service_telemetry",
    label: "Inspect service logs and metrics",
    criteria: "Use when local logs or metrics suggest a failure inside the affected service, such as resource pressure or an application error.",
    instructions: "Inspect errors, traffic, latency, and saturation for the affected service around the supporting event. Compare with an unaffected instance or time range.",
  },
  {
    id: "trace_dependency",
    label: "Trace a failing dependency",
    criteria: "Use when traces or logs point to a failing dependency or a request crossing a service boundary.",
    instructions: "Follow a representative failing trace across service boundaries. Check the implicated dependency’s latency and errors against the first failures.",
  },
  {
    id: "verify_impact",
    label: "Verify the scope of impact",
    criteria: "Use when an alert reports a symptom and an available breakdown could distinguish affected regions, versions, or operations.",
    instructions: "Break down the alert by region, operation, and service version. Compare error counts and request volume with the pre-incident baseline.",
  },
];

export function importedScenario(data: PrivateCase): ImportedScenario {
  const events = [...data.events].sort((left, right) =>
    left.availableAt.localeCompare(right.availableAt) || left.id.localeCompare(right.id));
  const observations = Array.from(new Map(events.map((event) => [event.availableAt, event])).values());
  const count = Math.min(MAX_CHECKPOINTS, observations.length);
  const checkpoints = Array.from({ length: count }, (_, index) => {
    const observation = observations[count === 1 ? 0 : Math.floor(index * (observations.length - 1) / (count - 1))];
    return { id: `import-${index + 1}`, cutoffAt: observation.availableAt, observationEventId: observation.id };
  });
  return {
    kind: "imported",
    id: data.id,
    publicId: data.id,
    schemaVersion: 1,
    title: data.title,
    briefing: data.briefing,
    version: data.version,
    actions,
    fallback: "Add a service-level breakdown or a representative failing trace, then re-evaluate with that evidence.",
    checkpoints,
    events,
  };
}

export function loadImportedScenarios(directory: string): ImportedScenario[] {
  const root = resolve(directory);
  let totalBytes = 0;
  const ids = new Set<string>();
  try {
    const files = readdirSync(/* turbopackIgnore: true */ root, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (files.length > MAX_CASES) throw new Error();
    return files.map((entry) => {
      if (!entry.isFile()) throw new Error();
      const path = join(/* turbopackIgnore: true */ root, entry.name);
      const { value, bytes } = readBoundedJsonWithSize(path, Math.min(MAX_CASE_BYTES, MAX_LIBRARY_BYTES - totalBytes));
      const data = parsePrivateCase(value);
      if (ids.has(data.id)) throw new Error();
      ids.add(data.id);
      totalBytes += bytes;
      return importedScenario(data);
    });
  } catch {
    throw new ReplayError("configuration", "The private incident directory could not be loaded. Check its path, case files, and size limits.");
  }
}
