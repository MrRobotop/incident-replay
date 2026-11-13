import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ABSTAIN, idSchema, NO_EVIDENCE, visibleEvents } from "../src/replay/scenario.ts";
import type { Scenario } from "../src/replay/scenario.ts";

const expected = z.strictObject({ actionId: idSchema, evidenceIds: z.array(idSchema).min(1) });
const labels = z.strictObject({
  scenarioId: idSchema,
  scenarioVersion: z.number().int().positive(),
  labelVersion: z.number().int().positive().default(1),
  split: z.enum(["development", "release"]),
  family: idSchema,
  checkpoints: z.record(idSchema, expected.extend({
    alternatives: z.array(expected).optional(),
    rationale: z.string().trim().min(1).optional(),
  })),
});

export type LabelSet = z.infer<typeof labels>;
export type Label = LabelSet["checkpoints"][string];
export type Split = LabelSet["split"] | "all";
export type LabeledScenario = { scenario: Scenario; labels: LabelSet };

export function validateLabels(input: unknown, scenario: Scenario): LabelSet {
  const parsed = labels.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid label fields for ${scenario.id}.`);
  const value = parsed.data;
  if (value.scenarioId !== scenario.id || value.scenarioVersion !== scenario.version) {
    throw new Error(`Labels must match the scenario ID and version for ${scenario.id}.`);
  }
  if (Object.keys(value.checkpoints).length !== scenario.checkpoints.length) {
    throw new Error(`Labels must cover all checkpoints for ${scenario.id}.`);
  }
  const knownActions = new Set(scenario.actions.map(({ id }) => id));
  for (const point of scenario.checkpoints) {
    const label = value.checkpoints[point.id];
    const location = `${scenario.id}/${point.id}`;
    if (!Object.hasOwn(value.checkpoints, point.id)) throw new Error(`Missing label for ${location}.`);
    const visible = new Set(visibleEvents(scenario, point.cutoffAt).map(({ id }) => id));
    const candidates = [label, ...(label.alternatives ?? [])];
    if (new Set(candidates.map(({ actionId }) => actionId)).size !== candidates.length) {
      throw new Error(`Duplicate accepted action for ${location}.`);
    }
    for (const candidate of candidates) {
      const { actionId, evidenceIds } = candidate;
      if (actionId === ABSTAIN) {
        if (candidates.length !== 1 || evidenceIds.length !== 1 || evidenceIds[0] !== NO_EVIDENCE) {
          throw new Error(`Abstention must be the only action and use no_evidence for ${location}.`);
        }
      } else if (!knownActions.has(actionId) || !evidenceIds.every((id) => visible.has(id)) ||
        new Set(evidenceIds).size !== evidenceIds.length) {
        throw new Error(`Label uses an unknown action or invalid evidence for ${location}.`);
      }
    }
  }
  return value;
}

export function loadLabels(scenarios: Scenario[], directory = join(process.cwd(), "eval", "labels")): LabeledScenario[] {
  const names = new Set(readdirSync(directory).filter((name) => name.endsWith(".json")));
  const entries = scenarios.map((scenario) => {
    const name = `${scenario.id}.json`;
    if (!names.delete(name)) throw new Error(`Missing evaluation labels for ${scenario.id}.`);
    let input: unknown;
    try {
      input = JSON.parse(readFileSync(join(directory, name), "utf8"));
    } catch {
      throw new Error(`Could not read evaluation labels for ${scenario.id}.`);
    }
    return { scenario, labels: validateLabels(input, scenario) };
  });
  if (names.size) throw new Error("Evaluation labels reference scenarios that are not bundled.");
  return entries;
}
