import { parseArgs } from "node:util";
import { loadLocalEnv, readConfig } from "../replay/config.ts";
import { liveDecision } from "../replay/live.ts";
import { demoDecision } from "../replay/decision.ts";
import { ReplayError } from "../replay/errors.ts";
import { loadScenarios, resolveCheckpoint, resolveScenario } from "../replay/scenario.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string" },
      checkpoint: { type: "string" },
      mode: { type: "string", default: "demo" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log("Usage: npm run replay -- --scenario ID --checkpoint ID [--mode demo|live] [--json]");
    return;
  }
  if (!values.scenario || !values.checkpoint || (values.mode !== "demo" && values.mode !== "live")) {
    throw new ReplayError("input", "Provide --scenario ID and --checkpoint ID. Use --help for usage.");
  }
  const scenario = resolveScenario(loadScenarios(), values.scenario);
  const point = resolveCheckpoint(scenario, values.checkpoint);
  if (values.mode === "live") {
    try {
      loadLocalEnv();
    } catch {
      throw new ReplayError("configuration", "Unable to load .env.local. Check the file permissions and format.");
    }
  }
  const config = readConfig(process.env, values.mode === "demo");
  if (values.mode === "live" && config.mode !== "live") {
    throw new ReplayError("configuration", "Set INCIDENT_REPLAY_MODE=live and SUBQ_API_KEY in .env.local.");
  }
  const result = config.mode === "live"
    ? await liveDecision(scenario, point, config.key!)
    : demoDecision(scenario, point);
  if (values.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`${scenario.title} / ${point.id} · ${result.mode === "live" ? "Live SubQ" : "Demo fixture"}`);
  if (result.status === "insufficient_evidence") console.log("Insufficient evidence.");
  console.log(`Next step: ${result.recommendation}`);
  if (result.inputTokens !== undefined) console.log(`Input tokens: ${result.inputTokens} · Estimated inference: $${result.estimatedCostUsd?.toFixed(6)}`);
  if (result.evidence) console.log(`Evidence [${result.evidence.id}] ${result.evidence.text}`);
}

main().catch((error: unknown) => {
  if (error instanceof ReplayError || (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS"))) {
    console.error(error.message);
    process.exitCode = error instanceof ReplayError
      ? (error.code === "configuration" ? 3 : ["input", "not_found"].includes(error.code) ? 2 : 4)
      : 2;
    return;
  }
  console.error("Replay failed to load. Verify the bundled scenario files.");
  process.exitCode = 1;
});
