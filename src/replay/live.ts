import { buildRequest, MODEL, parseResponse, PRICE_USD_PER_TOKEN } from "../subq/contract.ts";
import { requestSubq } from "../subq/transport.ts";
import { mapDecision } from "./decision.ts";
import { ABSTAIN, NO_EVIDENCE } from "./scenario.ts";
import type { Checkpoint, ReplayScenario } from "./scenario.ts";

export async function liveDecision(scenario: ReplayScenario, point: Checkpoint, key: string, options?: Parameters<typeof requestSubq>[2]) {
  const { request, events, availableCount } = buildRequest(scenario, point);
  const upstream = await requestSubq(request, key, options);
  const result = parseResponse(upstream.body, request);
  const actionId = result.nextStep.choice;
  const evidenceId = actionId === ABSTAIN ? NO_EVIDENCE : (result.supportingEvent?.choice ?? NO_EVIDENCE);
  return {
    ...mapDecision(scenario, point, events, availableCount, { actionId, evidenceId }, "live"),
    model: MODEL,
    elapsedMs: upstream.elapsedMs,
    inputTokens: result.inputTokens,
    estimatedCostUsd: result.inputTokens * PRICE_USD_PER_TOKEN,
    probabilities: result.nextStep.probabilities,
  };
}
