import { loadEnvFile } from "node:process";
import { ReplayError } from "./errors.ts";
import type { Mode } from "./decision.ts";

export function loadLocalEnv() {
  try {
    loadEnvFile(".env.local");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function integer(value: string | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new ReplayError("configuration", `Set ${name} to an integer between 1 and ${max}.`);
  }
  return Number(value);
}

export function readConfig(env: Record<string, string | undefined> = process.env, forceDemo = false) {
  const mode: Mode | string = forceDemo ? "demo" : (env.INCIDENT_REPLAY_MODE ?? "demo");
  if (mode !== "live" && mode !== "demo") {
    throw new ReplayError("configuration", "Set INCIDENT_REPLAY_MODE to demo or live.");
  }
  const key = mode === "live" ? env.SUBQ_API_KEY?.trim() : undefined;
  if (mode === "live" && (!key || !/^[!-~]+$/.test(key))) {
    throw new ReplayError("configuration", "Set SUBQ_API_KEY in .env.local or in the server environment.");
  }
  const origin = env.INCIDENT_REPLAY_ORIGIN ?? "http://localhost:3000";
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    throw new ReplayError("configuration", "Set INCIDENT_REPLAY_ORIGIN to an exact HTTP or HTTPS origin without a trailing slash.");
  }
  const importDirectory = env.INCIDENT_REPLAY_IMPORT_DIR?.trim() || undefined;
  const allowImported = env.INCIDENT_REPLAY_ALLOW_IMPORTED_SUBQ ?? "false";
  if (allowImported !== "true" && allowImported !== "false") {
    throw new ReplayError("configuration", "Set INCIDENT_REPLAY_ALLOW_IMPORTED_SUBQ to true or false.");
  }
  return {
    mode,
    key,
    origin,
    importDirectory,
    importedEvaluationEnabled: Boolean(importDirectory && mode === "live" && allowImported === "true"),
    dailyAttempts: integer(env.INCIDENT_REPLAY_DAILY_ATTEMPTS, 100, "INCIDENT_REPLAY_DAILY_ATTEMPTS", 100_000),
    maxInFlight: integer(env.INCIDENT_REPLAY_MAX_IN_FLIGHT, 2, "INCIDENT_REPLAY_MAX_IN_FLIGHT", 50),
  } as const;
}
