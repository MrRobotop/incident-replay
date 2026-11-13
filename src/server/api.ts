import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createBudget } from "../replay/budget.ts";
import { readConfig } from "../replay/config.ts";
import { demoDecision } from "../replay/decision.ts";
import { ReplayError } from "../replay/errors.ts";
import type { ErrorCode } from "../replay/errors.ts";
import { liveDecision } from "../replay/live.ts";
import { idSchema, loadScenarios, resolveScenario, visibleEvents } from "../replay/scenario.ts";
import type { ImportedScenario, Scenario } from "../replay/scenario.ts";
import { loadImportedScenarios } from "./imported.ts";
import { MODEL } from "../subq/contract.ts";

const MAX_BODY_BYTES = 4096;
const inputSchema = z.strictObject({
  scenarioId: idSchema,
  checkpointId: idSchema,
  allowImportedEvidence: z.literal(true).optional(),
});
const headers = { "Cache-Control": "no-store" };
const errorStatuses: Record<ErrorCode, number> = {
  input: 400, not_found: 404, configuration: 503, origin: 403, budget: 429, busy: 429,
  unauthorized: 502, credits: 502, model_access: 502, rate_limit: 429, upstream: 502,
  invalid_response: 502, timeout: 504, network: 502, cancelled: 408,
};

async function readInput(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ReplayError("input", "Send an application/json request.");
  }
  if (!request.body || Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    void request.body?.cancel().catch(() => {});
    throw new ReplayError("input", "Send a decision request up to 4 KiB.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new ReplayError("input", "Send a decision request up to 4 KiB.");
      }
      chunks.push(value);
    }
    const parsed = inputSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
    if (!parsed.success) throw new Error();
    return parsed.data;
  } catch (error) {
    if (error instanceof ReplayError) throw error;
    throw new ReplayError("input", "Send valid scenarioId and checkpointId fields.");
  } finally {
    reader.releaseLock();
  }
}

export function createApi(
  config: ReturnType<typeof readConfig>,
  scenarios: (Scenario | ImportedScenario)[],
  runLive = liveDecision,
  log: (record: Record<string, unknown>) => void = (record) => console.info(JSON.stringify(record)),
) {
  const budget = createBudget(config.dailyAttempts, config.maxInFlight);
  function findCheckpoint(scenarioId: string, checkpointId: string) {
    const scenario = resolveScenario(scenarios, scenarioId, true);
    const index = Number(/^checkpoint-(\d+)$/.exec(checkpointId)?.[1]) - 1;
    const point = scenario.checkpoints[index];
    if (!point || checkpointId !== `checkpoint-${index + 1}`) {
      throw new ReplayError("not_found", "Choose an available checkpoint.");
    }
    return { scenario, point };
  }
  return {
    health: () => ({ status: "ready" }),
    list: () => ({
      mode: config.mode,
      importsEnabled: Boolean(config.importDirectory),
      importedEvaluationEnabled: config.importedEvaluationEnabled,
      scenarios: scenarios.map((scenario) => {
        const { publicId, title, briefing, checkpoints, actions } = scenario;
        return {
          id: publicId, title, briefing,
          kind: "kind" in scenario ? scenario.kind : "training",
          checkpoints: checkpoints.map(({ cutoffAt }, index) => ({
            id: `checkpoint-${index + 1}`, label: `Checkpoint ${index + 1}`, cutoffAt,
          })),
          actions: actions.map(({ id, label }) => ({ id, label })),
        };
      }),
    }),
    checkpoint(scenarioId: string, checkpointId: string) {
      const { scenario, point } = findCheckpoint(scenarioId, checkpointId);
      return { cutoffAt: point.cutoffAt, events: visibleEvents(scenario, point.cutoffAt) };
    },
    debrief(scenarioId: string, checkpointId: string | null) {
      const scenario = resolveScenario(scenarios, scenarioId, true);
      if (!("debrief" in scenario)) throw new ReplayError("not_found", "Imported incidents have no training debrief.");
      if (checkpointId !== `checkpoint-${scenario.checkpoints.length}`) {
        throw new ReplayError("input", "Advance to the final checkpoint to reveal the debrief.");
      }
      return scenario.debrief;
    },
    async decide(request: Request) {
      if (request.headers.get("origin") !== config.origin) {
        throw new ReplayError("origin", "Open Incident Replay at its configured browser origin.");
      }
      const { scenarioId, checkpointId, allowImportedEvidence } = await readInput(request);
      const { scenario, point } = findCheckpoint(scenarioId, checkpointId);
      if (!("demo" in scenario)) {
        if (!config.importedEvaluationEnabled) {
          throw new ReplayError("origin", "This instance allows local review of imported incidents. The operator can enable imported evaluation in the server configuration.");
        }
        if (!allowImportedEvidence) {
          throw new ReplayError("input", "Confirm that this checkpoint’s imported evidence can be sent to SubQ.");
        }
      } else if (config.mode === "demo") {
        return { ...demoDecision(scenario, point), checkpointId };
      }
      const requestId = randomUUID();
      const start = performance.now();
      let attempts = 0;
      const metadata = { requestId, scenarioId, checkpointId, model: MODEL };
      try {
        const result = await budget.run((reserve) => runLive(scenario, point, config.key!, {
          signal: request.signal,
          reserveAttempt: () => { reserve(); attempts++; },
        }));
        log({ ...metadata, attempts, elapsedMs: Math.round(performance.now() - start), inputTokens: result.inputTokens, status: result.status });
        return { ...result, checkpointId, probabilities: undefined };
      } catch (error) {
        log({ ...metadata, attempts, elapsedMs: Math.round(performance.now() - start), status: error instanceof ReplayError ? error.code : "internal" });
        throw error;
      }
    },
  };
}

let instance: ReturnType<typeof createApi> | undefined;

export function api() {
  if (!instance) {
    const config = readConfig();
    const bundled = loadScenarios();
    const imported = config.importDirectory ? loadImportedScenarios(config.importDirectory) : [];
    if (imported.some(({ id }) => bundled.some((entry) => entry.id === id || entry.publicId === id))) {
      throw new ReplayError("configuration", "A private incident ID conflicts with a training scenario.");
    }
    instance = createApi(config, [...bundled, ...imported]);
  }
  return instance;
}

export async function jsonResponse(operation: () => unknown | Promise<unknown>) {
  try {
    return Response.json(await operation(), { headers });
  } catch (error) {
    if (error instanceof ReplayError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { headers, status: errorStatuses[error.code] });
    }
    return Response.json({ error: { code: "internal", message: "Replay could not load. Check the bundled scenario files and server configuration." } }, { headers, status: 500 });
  }
}
