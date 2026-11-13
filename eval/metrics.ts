import { ABSTAIN } from "../src/replay/scenario.ts";
import { PRICE_USD_PER_TOKEN } from "../src/subq/contract.ts";
import type { ErrorCode } from "../src/replay/errors.ts";
import type { LabelSet } from "./labels.ts";

export const ARMS = ["latest", "history", "product"] as const;
export type Arm = typeof ARMS[number];

export type Row = {
  arm: Arm;
  scenarioId: string;
  scenarioVersion: number;
  labelVersion: number;
  family: string;
  split: LabelSet["split"];
  checkpointId: string;
  canonicalActionId: string;
  evidenceInContext: boolean | null;
  submittedEvents: number;
  availableEvents: number;
  attempts: number;
  elapsedMs: number | null;
  inputTokens: number | null;
  error: ErrorCode | "prior_provider_error" | null;
  actionId: string | null;
  modelActionId: string | null;
  modelEvidenceId: string | null;
  evidenceId: string | null;
  probabilities: Record<string, number> | null;
  canonicalCorrect: boolean;
  actionAccepted: boolean;
  evidenceAccepted: boolean | null;
  brierScore: number | null;
};

function rate(numerator: number, denominator: number) {
  return { numerator, denominator, value: denominator ? numerator / denominator : null };
}

function percentile(sorted: number[], fraction: number): number | null {
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
}

export function summarize(rows: Row[]) {
  const succeeded = rows.filter(({ error }) => error === null);
  const sent = rows.filter(({ attempts }) => attempts > 0);
  const predictedAbstention = succeeded.filter(({ actionId }) => actionId === ABSTAIN);
  const expectedAbstention = rows.filter(({ canonicalActionId }) => canonicalActionId === ABSTAIN);
  const abstainedCorrectly = predictedAbstention.filter(({ canonicalActionId }) => canonicalActionId === ABSTAIN).length;
  const recommended = succeeded.filter(({ actionId }) => actionId !== ABSTAIN);
  const evidenceScored = rows.filter(({ evidenceAccepted }) => evidenceAccepted !== null);
  const acceptedEvidence = evidenceScored.filter(({ evidenceAccepted }) => evidenceAccepted).length;
  const evidenceEligible = rows.filter(({ evidenceInContext }) => evidenceInContext !== null);
  const brier = rows.flatMap(({ brierScore }) => brierScore === null ? [] : [brierScore]);
  const durations = sent.flatMap(({ elapsedMs }) => elapsedMs === null ? [] : [elapsedMs]).sort((a, b) => a - b);
  const inputTokens = rows.reduce((total, row) => total + (row.inputTokens ?? 0), 0);
  const attempts = rows.reduce((total, row) => total + row.attempts, 0);
  return {
    checkpoints: rows.length,
    completed: rate(succeeded.length, rows.length),
    canonicalAccuracy: rate(rows.filter(({ canonicalCorrect }) => canonicalCorrect).length, rows.length),
    acceptedActionAccuracy: rate(rows.filter(({ actionAccepted }) => actionAccepted).length, rows.length),
    abstentionPrecision: rate(abstainedCorrectly, predictedAbstention.length),
    abstentionRecall: rate(abstainedCorrectly, expectedAbstention.length),
    unsupportedRecommendations: recommended.filter(({ canonicalActionId }) => canonicalActionId === ABSTAIN).length,
    modelAbstentions: succeeded.filter(({ modelActionId }) => modelActionId === ABSTAIN).length,
    policyAbstentions: succeeded.filter(({ modelActionId, actionId }) =>
      modelActionId !== null && modelActionId !== ABSTAIN && actionId === ABSTAIN).length,
    recommendationAccuracy: rate(recommended.filter(({ actionAccepted }) => actionAccepted).length, recommended.length),
    evidenceCandidateCoverage: rate(evidenceEligible.filter(({ evidenceInContext }) => evidenceInContext).length, evidenceEligible.length),
    evidenceAccuracyGivenAcceptedAction: rate(acceptedEvidence, evidenceScored.filter(({ actionAccepted }) => actionAccepted).length),
    jointActionAndEvidenceAccuracy: rate(acceptedEvidence, evidenceScored.length),
    invalidResponses: rows.filter(({ error }) => error === "invalid_response").length,
    calibration: {
      unambiguousScoredCheckpoints: brier.length,
      meanMulticlassBrier: brier.length ? brier.reduce((total, value) => total + value, 0) / brier.length : null,
    },
    latencyMs: { count: durations.length, p50: percentile(durations, 0.50), p95: percentile(durations, 0.95) },
    attempts,
    retries: attempts - sent.length,
    meteredInputTokens: inputTokens,
    meteredCostUsd: inputTokens * PRICE_USD_PER_TOKEN,
    attemptsWithoutUsage: attempts - rows.filter(({ inputTokens: tokens }) => tokens !== null).length,
  };
}

export function pairedComparison(rows: Row[]) {
  const key = ({ scenarioId, checkpointId }: Row) => `${scenarioId}/${checkpointId}`;
  const latest = new Map(rows.filter(({ arm }) => arm === "latest").map((row) => [key(row), row]));
  const history = rows.filter(({ arm }) => arm === "history");
  let compared = 0;
  let historyOnlyCorrect = 0;
  let latestOnlyCorrect = 0;
  let completedPairs = 0;
  let completedDifference = 0;
  for (const row of history) {
    const other = latest.get(key(row));
    if (!other) continue;
    compared += 1;
    if (row.actionAccepted && !other.actionAccepted) historyOnlyCorrect += 1;
    if (!row.actionAccepted && other.actionAccepted) latestOnlyCorrect += 1;
    if (!row.error && !other.error) {
      completedPairs += 1;
      completedDifference += Number(row.actionAccepted) - Number(other.actionAccepted);
    }
  }
  return {
    pairedCheckpoints: compared,
    historyOnlyCorrect,
    latestOnlyCorrect,
    acceptedAccuracyDifference: compared ? (historyOnlyCorrect - latestOnlyCorrect) / compared : null,
    completedPairs,
    completedPairsAcceptedAccuracyDifference: completedPairs ? completedDifference / completedPairs : null,
  };
}
