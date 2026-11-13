import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:3210",
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
  },
  webServer: {
    command: "npm run start -- --port 3210",
    url: "http://localhost:3210/api/health",
    env: {
      INCIDENT_REPLAY_MODE: "demo",
      INCIDENT_REPLAY_ORIGIN: "http://localhost:3210",
      INCIDENT_REPLAY_IMPORT_DIR: "",
      INCIDENT_REPLAY_ALLOW_IMPORTED_SUBQ: "false",
      SUBQ_API_KEY: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
