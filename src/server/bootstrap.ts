import { loadLocalEnv, readConfig } from "../replay/config.ts";
import { ReplayError } from "../replay/errors.ts";

process.env.NEXT_TELEMETRY_DISABLED = "1";

if (process.argv[2] === "build") {
  process.env.INCIDENT_REPLAY_MODE = "demo";
  process.env.SUBQ_API_KEY = "";
} else {
  try {
    loadLocalEnv();
    readConfig();
  } catch (error) {
    console.error(error instanceof ReplayError ? error.message : "Unable to load .env.local. Check the file permissions and format.");
    process.exit(3);
  }
}
