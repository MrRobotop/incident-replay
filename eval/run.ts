import { execFileSync } from "node:child_process";
import { demoDecision, mapDecision, POLICY_VERSION } from "../src/replay/decision.ts";
import { ReplayError } from "../src/replay/errors.ts";
import { ABSTAIN, NO_EVIDENCE } from "../src/replay/scenario.ts";
import { buildRequest, estimateTokens, MODEL, parseResponse, PRICE_USD_PER_TOKEN } from "../src/subq/contract.ts";
import { requestSubq } from "../src/subq/transport.ts";
import { ARMS, pairedComparison, summarize } from "./metrics.ts";
import type { Checkpoint, Scenario } from "../src/replay/scenario.ts";
import type { Arm, Row } from "./metrics.ts";
import type { Label, LabeledScenario, Split } from "./labels.ts";

const STOP_CODES = new Set(["budget", "configuration", "unauthorized", "credits", "model_access", "cancelled"]);
const REQUEST_VERSION = "1";
export const DEFAULT_MAX_ATTEMPTS = 120;
export const DEFAULT_MAX_COST_USD = 0.10;

type Limits = { maxAttempts: number; maxCostUsd: number };
type Options = { mode: "demo"; split: Split } | ({
  mode: "live";
  split: Split;
  key: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
} & Limits);

export function pairedRequests(scenario: Scenario, point: Checkpoint) {
  const latest = buildRequest(scenario, point, "latest").request;
  const matchedPoint = { ...point, observationEventId: latest.state.observationEventId };
  const history = buildRequest(scenario, matchedPoint, "history").request;
  const latestIds = new Set(latest.state.events.map(({ id }) => id));
  const historyIds = new Set(history.state.events.map(({ id }) => id));
  // Match static runbook context even when the independent selectors hit the context cap.
  history.state.events = history.state.events.filter(({ id, kind }) => kind !== "runbook" || latestIds.has(id));
  latest.state.events = latest.state.events.filter(({ id, kind }) => kind !== "runbook" || historyIds.has(id));
  return { latest, history };
}

function score(row: Row, label: Label) {
  const accepted = [label, ...(label.alternatives ?? [])].find(({ actionId }) => actionId === row.actionId);
  row.canonicalCorrect = row.actionId === label.actionId;
  row.actionAccepted = Boolean(accepted);
  if (row.arm === "product") row.evidenceAccepted = Boolean(accepted && row.evidenceId && accepted.evidenceIds.includes(row.evidenceId));
  if (row.probabilities && !label.alternatives?.length) {
    row.brierScore = Object.entries(row.probabilities).reduce((sum, [id, probability]) =>
      sum + (probability - Number(id === label.actionId)) ** 2, 0);
  }
}

function knownUsage(body: unknown): number | null {
  if (typeof body !== "object" || body === null || !("usage" in body)) return null;
  const { usage } = body;
  if (typeof usage !== "object" || usage === null || !("input_tokens" in usage)) return null;
  const value = usage.input_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function revision(): string | null {
  try {
    const value = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 2000 }).trim();
    return /^[a-f0-9]{40,64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function runBudget({ maxAttempts, maxCostUsd }: Limits) {
  const limitTokens = Math.floor(maxCostUsd / PRICE_USD_PER_TOKEN);
  let reservedInputTokens = 0;
  let meteredInputTokens = 0;
  let meteredAttempts = 0;
  let billedBeyondEstimate = 0;
  let attempts = 0;
  return {
    reserve(tokens: number) {
      if (attempts >= maxAttempts || reservedInputTokens + billedBeyondEstimate + tokens > limitTokens) {
        throw new ReplayError("budget", "The evaluation attempt or estimated spend limit was reached.");
      }
      attempts++;
      reservedInputTokens += tokens;
    },
    account(inputTokens: number, estimatedTokens: number) {
      meteredInputTokens += inputTokens;
      meteredAttempts++;
      billedBeyondEstimate += Math.max(0, inputTokens - estimatedTokens);
    },
    summary() {
      return {
        maxAttempts,
        maxCostUsd,
        attempts,
        attemptsWithoutUsage: attempts - meteredAttempts,
        reservedInputTokens,
        reservedCostUsd: reservedInputTokens * PRICE_USD_PER_TOKEN,
        meteredInputTokens,
        meteredCostUsd: meteredInputTokens * PRICE_USD_PER_TOKEN,
        usageAboveEstimateTokens: billedBeyondEstimate,
      };
    },
  };
}

export async function runEvaluation(entries: LabeledScenario[], options: Options) {
  const selected = entries.filter(({ labels }) => options.split === "all" || labels.split === options.split);
  if (!selected.length) throw new ReplayError("input", `No labeled scenarios found for the ${options.split} split.`);
  if (options.mode === "live" && (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 ||
    !Number.isSafeInteger(Math.floor(options.maxCostUsd / PRICE_USD_PER_TOKEN)) || options.maxCostUsd <= 0)) {
    throw new ReplayError("input", "Set valid positive attempt and estimated spend limits.");
  }
  const budget = options.mode === "live" ? runBudget(options) : null;
  const arms: readonly Arm[] = options.mode === "live" ? ARMS : ["product"];
  const rows: Row[] = [];
  let stopCode: Row["error"] = null;
  let reverseComparison = false;

  for (const { scenario, labels } of selected) {
    for (const point of scenario.checkpoints) {
      const label = labels.checkpoints[point.id];
      const product = buildRequest(scenario, point, "product");
      const requests = { ...(options.mode === "live" ? pairedRequests(scenario, point) : null), product: product.request };
      const checkpointArms: readonly Arm[] = options.mode === "live" && reverseComparison ? ["history", "latest", "product"] : arms;
      reverseComparison = !reverseComparison;
      for (const arm of checkpointArms) {
        const request = requests[arm]!;
        const choices = request.questions.supporting_event?.criteria ?? {};
        const row: Row = {
          arm,
          scenarioId: scenario.id,
          scenarioVersion: scenario.version,
          labelVersion: labels.labelVersion,
          family: labels.family,
          split: labels.split,
          checkpointId: point.id,
          canonicalActionId: label.actionId,
          evidenceInContext: options.mode === "live" && arm === "product" && label.actionId !== ABSTAIN
            ? [label, ...(label.alternatives ?? [])].some(({ evidenceIds }) => evidenceIds.some((id) => Object.hasOwn(choices, id))) : null,
          submittedEvents: 0,
          availableEvents: product.availableCount,
          attempts: 0,
          elapsedMs: null,
          inputTokens: null,
          error: null,
          actionId: null,
          modelActionId: null,
          modelEvidenceId: null,
          evidenceId: null,
          probabilities: null,
          canonicalCorrect: false,
          actionAccepted: false,
          evidenceAccepted: arm === "product" ? false : null,
          brierScore: null,
        };
        rows.push(row);
        if (stopCode) {
          row.error = stopCode === "budget" ? "budget" : "prior_provider_error";
          continue;
        }
        if (options.mode === "demo") {
          const decision = demoDecision(scenario, point);
          row.actionId = decision.actionId;
          row.evidenceId = decision.evidence?.id ?? NO_EVIDENCE;
          score(row, label);
          continue;
        }

        const started = performance.now();
        const estimate = estimateTokens(request);
        try {
          const result = await requestSubq(request, options.key, {
            signal: options.signal,
            fetcher: options.fetcher,
            reserveAttempt: () => {
              budget!.reserve(estimate);
              row.attempts++;
              row.submittedEvents = request.state.events.length;
            },
          });
          row.inputTokens = knownUsage(result.body);
          if (row.inputTokens !== null) budget!.account(row.inputTokens, estimate);
          const answer = parseResponse(result.body, request);
          row.modelActionId = answer.nextStep.choice;
          row.modelEvidenceId = answer.supportingEvent?.choice ?? null;
          row.probabilities = answer.nextStep.probabilities;
          if (arm === "product") {
            const selectedEvidence = row.modelActionId === ABSTAIN ? NO_EVIDENCE : row.modelEvidenceId ?? NO_EVIDENCE;
            const decision = mapDecision(scenario, point, product.events, product.availableCount, {
              actionId: row.modelActionId,
              evidenceId: selectedEvidence,
            }, "live");
            row.actionId = decision.actionId;
            row.evidenceId = decision.evidence?.id ?? NO_EVIDENCE;
          } else {
            row.actionId = row.modelActionId;
          }
          score(row, label);
        } catch (error) {
          row.error = error instanceof ReplayError ? error.code : "upstream";
          if (STOP_CODES.has(row.error)) stopCode = row.error;
        } finally {
          if (row.attempts) row.elapsedMs = Math.round(performance.now() - started);
        }
      }
    }
  }
  const metrics = Object.fromEntries(arms.map((arm) => [arm, summarize(rows.filter((row) => row.arm === arm))]));
  const complete = rows.every((row) => row.error === null);
  return {
    schemaVersion: 1,
    source: options.mode === "demo" ? "Demo fixture" : options.fetcher ? "Offline mock" : "Live SubQ",
    mode: options.mode,
    split: options.split,
    model: options.mode === "live" ? MODEL : null,
    gitCommit: revision(),
    evaluatedAt: new Date().toISOString(),
    requestVersion: REQUEST_VERSION,
    policyVersion: POLICY_VERSION,
    settings: {
      concurrency: options.mode === "live" ? 1 : 0,
      cache: false,
      pairedArmOrder: options.mode === "live" ? "alternating" : null,
      rateUsdPerMillionInputTokens: PRICE_USD_PER_TOKEN * 1_000_000,
    },
    complete,
    stopCode,
    budget: budget?.summary() ?? null,
    metrics,
    pairedContext: options.mode === "live" ? pairedComparison(rows) : null,
    rows,
  };
}
