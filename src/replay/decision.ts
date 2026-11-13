import { ABSTAIN, NO_EVIDENCE, visibleEvents } from "./scenario.ts";
import type { Checkpoint, IncidentEvent, ReplayScenario, Scenario } from "./scenario.ts";

export const POLICY_VERSION = "1";
export type Mode = "demo" | "live";

export type Decision = {
  mode: Mode;
  scenarioId: string;
  scenarioVersion: number;
  checkpointId: string;
  policyVersion: string;
  status: "recommended" | "insufficient_evidence";
  actionId: string;
  recommendation: string;
  evidence: IncidentEvent | null;
  availableEventCount: number;
  submittedEventCount: number;
  contextReduced: boolean;
  model?: string;
  elapsedMs?: number;
  inputTokens?: number;
  estimatedCostUsd?: number;
  probabilities?: Record<string, number>;
};

export function mapDecision(
  scenario: ReplayScenario,
  point: Checkpoint,
  submitted: IncidentEvent[],
  availableEventCount: number,
  selected: { actionId: string; evidenceId: string },
  mode: Mode,
): Decision {
  const action = scenario.actions.find((entry) => entry.id === selected.actionId);
  const evidence = submitted.find((entry) => entry.id === selected.evidenceId);
  const base = {
    mode,
    scenarioId: scenario.publicId,
    scenarioVersion: scenario.version,
    checkpointId: point.id,
    policyVersion: POLICY_VERSION,
    availableEventCount,
    submittedEventCount: mode === "live" ? submitted.length : 0,
    contextReduced: submitted.length < availableEventCount,
  };
  if (action && evidence && selected.evidenceId !== NO_EVIDENCE) {
    return { ...base, status: "recommended", actionId: action.id, recommendation: action.instructions, evidence };
  }
  return {
    ...base,
    status: "insufficient_evidence",
    actionId: ABSTAIN,
    recommendation: scenario.fallback,
    evidence: null,
  };
}

export function demoDecision(scenario: Scenario, point: Checkpoint): Decision {
  const visible = visibleEvents(scenario, point.cutoffAt);
  return mapDecision(scenario, point, visible, visible.length, scenario.demo[point.id], "demo");
}
