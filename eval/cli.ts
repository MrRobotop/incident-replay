import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadLocalEnv, readConfig } from "../src/replay/config.ts";
import { ReplayError } from "../src/replay/errors.ts";
import { loadScenarios } from "../src/replay/scenario.ts";
import { loadLabels } from "./labels.ts";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_COST_USD, runEvaluation } from "./run.ts";

const usage = `Usage: npm run eval -- --mode demo|live [options]

  --split development|release|all   Default: all
  --max-attempts N                  Live only. Default: ${DEFAULT_MAX_ATTEMPTS}, including retries
  --max-cost-usd USD                Live only. Default: $${DEFAULT_MAX_COST_USD.toFixed(2)} estimated inference
  --output FILE                     Write JSON to a new file. Default: stdout
  --help                            Show this message

Live mode requires INCIDENT_REPLAY_MODE=live and SUBQ_API_KEY in the shell or .env.local.`;

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      split: { type: "string", default: "all" },
      "max-attempts": { type: "string" },
      "max-cost-usd": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const { mode, split, output, "max-attempts": attemptArg, "max-cost-usd": costArg } = values;
  if ((mode !== "demo" && mode !== "live") || (split !== "development" && split !== "release" && split !== "all") || output === "") {
    throw new ReplayError("input", "Provide an explicit mode and valid options. Use --help for usage.");
  }
  if (mode === "demo" && (attemptArg !== undefined || costArg !== undefined)) {
    throw new ReplayError("input", "Attempt and spend limits apply to live evaluations. Use --help for usage.");
  }
  const maxAttempts = attemptArg === undefined ? DEFAULT_MAX_ATTEMPTS : Number(attemptArg);
  const maxCostUsd = costArg === undefined ? DEFAULT_MAX_COST_USD : Number(costArg);
  if ((attemptArg !== undefined && !/^\d+$/.test(attemptArg)) || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new ReplayError("input", "Set --max-attempts to a positive integer.");
  }
  if ((costArg !== undefined && !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(costArg)) || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    throw new ReplayError("input", "Set --max-cost-usd to a positive decimal amount.");
  }

  let entries: ReturnType<typeof loadLabels>;
  try {
    entries = loadLabels(loadScenarios());
  } catch {
    throw new ReplayError("input", "Could not validate bundled scenarios and evaluation labels. Check the fixture and label files.");
  }
  if (!entries.some(({ labels }) => split === "all" || split === labels.split)) {
    throw new ReplayError("input", `No labeled scenarios found for the ${split} split.`);
  }
  let key: string | undefined;
  if (mode === "live") {
    try {
      loadLocalEnv();
    } catch {
      throw new ReplayError("configuration", "Could not load .env.local. Verify its permissions and format.");
    }
    const config = readConfig();
    if (config.mode !== "live" || !config.key) {
      throw new ReplayError("configuration", "Set INCIDENT_REPLAY_MODE=live and SUBQ_API_KEY in .env.local or the shell.");
    }
    key = config.key;
  }

  const reportFile = output ? await open(output, "wx", 0o600).catch(() => {
    throw new ReplayError("input", "Could not open the report path. Choose a new file in an existing directory.");
  }) : null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const report = await runEvaluation(entries, key
      ? { mode: "live", split, key, maxAttempts, maxCostUsd, signal: controller.signal }
      : { mode: "demo", split });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (reportFile) await reportFile.writeFile(json, "utf8");
    else process.stdout.write(json);
    if (!report.complete) process.exitCode = 4;
    if (mode === "demo" && report.rows.some(({ evidenceAccepted }) => !evidenceAccepted)) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await reportFile?.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ReplayError) {
    console.error(error.message);
    process.exitCode = error.code === "configuration" ? 3 : 2;
  } else if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
    console.error("Invalid arguments. Use --help for usage.");
    process.exitCode = 2;
  } else {
    console.error("Evaluation failed. Verify the bundled fixtures, environment, and report path.");
    process.exitCode = 1;
  }
});
