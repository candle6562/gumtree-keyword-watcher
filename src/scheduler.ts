type CycleRunner = {
  runCycle(): Promise<void>;
};

export function startMonitorLoop(monitor: CycleRunner, intervalMs: number): NodeJS.Timeout {
  let cycleInFlight = false;

  return setInterval(() => {
    if (cycleInFlight) {
      console.warn("Skipping scrape cycle because a previous cycle is still running");
      return;
    }

    cycleInFlight = true;

    void monitor
      .runCycle()
      .catch((error) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        console.error(`Scheduled scrape cycle failed: ${message}`);
      })
      .finally(() => {
        cycleInFlight = false;
      });
  }, intervalMs);
}
