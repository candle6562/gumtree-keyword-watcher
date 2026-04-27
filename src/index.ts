import "dotenv/config";
import { loadConfig } from "./config.js";
import { Monitor } from "./monitor.js";
import { RuntimeStats, startObservabilityServer } from "./observability.js";
import { startMonitorLoop } from "./scheduler.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const runtimeStats = new RuntimeStats();
  const monitor = new Monitor(config, runtimeStats);
  await monitor.init();

  if (config.healthMetricsEnabled) {
    const server = startObservabilityServer(config, runtimeStats);
    console.log(
      `Observability server listening on http://${config.healthMetricsHost}:${config.healthMetricsPort} (health=/health, metrics=/metrics)`
    );
    const shutdown = () => {
      server.close();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  await monitor.runCycle();

  startMonitorLoop(monitor, config.scrapeIntervalSeconds * 1000);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
