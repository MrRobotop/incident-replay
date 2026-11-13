import { ReplayError } from "./errors.ts";

export function createBudget(dailyLimit: number, maxInFlight: number, now = () => new Date()) {
  let active = 0;
  let attempts = 0;
  let currentDay = "";

  function resetOnNewDay() {
    const day = now().toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      attempts = 0;
    }
  }

  return {
    async run<T>(operation: (reserveAttempt: () => void) => Promise<T>): Promise<T> {
      resetOnNewDay();
      if (attempts >= dailyLimit) throw new ReplayError("budget", "The live budget resets at midnight UTC. Use demo mode to continue.");
      if (active >= maxInFlight) throw new ReplayError("busy", "Another live evaluation is running. Try again shortly.");
      active++;
      try {
        return await operation(() => {
          resetOnNewDay();
          if (attempts >= dailyLimit) throw new ReplayError("budget", "The live budget resets at midnight UTC. Use demo mode to continue.");
          attempts++;
        });
      } finally {
        active--;
      }
    },
  };
}
