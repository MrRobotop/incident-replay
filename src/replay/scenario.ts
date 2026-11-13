import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ReplayError } from "./errors.ts";

export const ABSTAIN = "insufficient_evidence";
export const NO_EVIDENCE = "no_evidence";
export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const text = z.string().trim().min(1);
const utc = z.iso.datetime({ precision: 0 });
const action = z.strictObject({
  id: idSchema.refine((id) => id !== ABSTAIN && id !== NO_EVIDENCE),
  label: text,
  criteria: text,
  instructions: text,
});
const checkpoint = z.strictObject({ id: idSchema, cutoffAt: utc, observationEventId: idSchema });
const event = z.strictObject({
  id: idSchema.refine((id) => id !== NO_EVIDENCE),
  occurredAt: utc,
  availableAt: utc,
  source: text,
  kind: text,
  text,
});

const fixtureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: idSchema,
  publicId: idSchema,
  title: text,
  briefing: text,
  version: z.number().int().positive(),
  actions: z.array(action).min(1).max(254),
  fallback: text,
  checkpoints: z.array(checkpoint).min(1).max(100),
  events: z.array(event).min(1).max(10_000),
  demo: z.record(idSchema, z.strictObject({ actionId: idSchema, evidenceId: idSchema })),
  debrief: z.strictObject({ summary: text, lessons: z.array(text).min(1) }),
});

export type Scenario = z.infer<typeof fixtureSchema>;
export type ReplayScenario = Omit<Scenario, "demo" | "debrief">;
export type ImportedScenario = ReplayScenario & { kind: "imported" };
export type IncidentEvent = z.infer<typeof event>;
export type Checkpoint = z.infer<typeof checkpoint>;

function unique(ids: string[]): boolean {
  return new Set(ids).size === ids.length;
}

export function visibleEvents(scenario: Pick<ReplayScenario, "events">, cutoffAt: string): IncidentEvent[] {
  return scenario.events
    .filter((entry) => entry.availableAt <= cutoffAt)
    .sort((left, right) => left.availableAt.localeCompare(right.availableAt) || left.id.localeCompare(right.id));
}

export function parseScenario(input: unknown): Scenario {
  const parsed = fixtureSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid scenario fields: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  const scenario = parsed.data;
  const { id, actions, checkpoints, events, demo } = scenario;
  for (const entries of [actions, checkpoints, events]) {
    if (!unique(entries.map((entry) => entry.id))) throw new Error(`Duplicate ID in ${id}`);
  }
  if (events.some((entry) => entry.availableAt < entry.occurredAt)) throw new Error(`Invalid availability in ${id}`);
  if (Object.keys(demo).length !== checkpoints.length) throw new Error(`Unexpected demo records in ${id}`);
  for (const [index, point] of checkpoints.entries()) {
    if (index && point.cutoffAt <= checkpoints[index - 1].cutoffAt) throw new Error(`Unordered checkpoints in ${id}`);
    const visible = new Set(visibleEvents(scenario, point.cutoffAt).map((entry) => entry.id));
    if (!visible.has(point.observationEventId)) throw new Error(`Unavailable observation in ${id}/${point.id}`);
    const decision = demo[point.id];
    if (!decision || (decision.actionId === ABSTAIN
      ? decision.evidenceId !== NO_EVIDENCE
      : !visible.has(decision.evidenceId) || !actions.some((entry) => entry.id === decision.actionId))) {
      throw new Error(`Invalid demo decision in ${id}/${point.id}`);
    }
  }
  return scenario;
}

export function loadScenarios(directory = join(process.cwd(), "scenarios")): Scenario[] {
  const scenarios = readdirSync(/* turbopackIgnore: true */ directory).filter((name) => name.endsWith(".json")).sort()
    .map((name) => parseScenario(JSON.parse(readFileSync(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ directory, name), "utf8"))));
  if (!scenarios.length) throw new Error("No bundled scenarios found.");
  if (!unique(scenarios.flatMap(({ id, publicId }) => [id, publicId]))) throw new Error("Duplicate scenario identifiers.");
  return scenarios;
}

export function resolveScenario<T extends ReplayScenario>(scenarios: T[], id: string, publicOnly = false): T {
  const scenario = scenarios.find((entry) => entry.publicId === id || (!publicOnly && entry.id === id));
  if (!scenario) throw new ReplayError("not_found", "Choose an available incident.");
  return scenario;
}

export function resolveCheckpoint(scenario: ReplayScenario, id: string): Checkpoint {
  const point = scenario.checkpoints.find((entry) => entry.id === id);
  if (!point) throw new ReplayError("not_found", "Choose an available checkpoint.");
  return point;
}
