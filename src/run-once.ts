import "dotenv/config";
import { loadConfig } from "./config.js";
import { Monitor } from "./monitor.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const monitor = new Monitor(config);
  await monitor.init();
  await monitor.runCycle();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
