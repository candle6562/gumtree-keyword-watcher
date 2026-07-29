import { exec } from "node:child_process";
import type { AppConfig } from "./config.js";

/**
 * Distinguishes "the browser worker is down" from any other fetch failure, so
 * callers can escalate it as an infrastructure problem rather than retrying a
 * dead host on a loop. The worker died on 2026-07-26 and produced 2,584
 * identical `TypeError: fetch failed` cycles before a human noticed.
 */
export class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

export interface WorkerHealthResult {
  healthy: boolean;
  restartAttempted: boolean;
  recovered: boolean;
  detail: string;
}

export type BrowserWorkerConfig = Pick<
  AppConfig,
  | "browserWorkerUrl"
  | "browserWorkerToken"
  | "browserWorkerAutostartEnabled"
  | "browserWorkerAutostartCommand"
  | "browserWorkerHealthTimeoutMs"
  | "browserWorkerStartupTimeoutMs"
  | "browserWorkerRestartCooldownMs"
>;

// Process-scoped, deliberately: a cron invocation is a fresh process, so the
// cooldown only guards against repeated restarts inside one long-running cycle.
// Cross-process cooldown lives in the health state file.
let lastRestartAttemptMs = 0;

export function resetRestartCooldown(): void {
  lastRestartAttemptMs = 0;
}

export async function probeWorker(config: BrowserWorkerConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.browserWorkerUrl.replace(/\/$/, "")}/health`, {
      headers: config.browserWorkerToken
        ? { authorization: `Bearer ${config.browserWorkerToken}` }
        : undefined,
      signal: AbortSignal.timeout(config.browserWorkerHealthTimeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function runStartCommand(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    // The start script launches a detached Windows process and may not return
    // promptly; we only care that it was invoked, the health poll decides the
    // outcome.
    exec(command, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve(`start command error: ${error.message}`);
        return;
      }
      resolve([stdout, stderr].filter(Boolean).join(" ").trim() || "start command issued");
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probe the worker and, if it is down, invoke the host-side start script and
 * wait for it to come up.
 *
 * Caveat worth knowing: the worker runs with HEADLESS=false and therefore needs
 * an interactive Windows desktop session. If the host is locked or logged out,
 * no amount of restarting will help — that case needs a Scheduled Task
 * configured to "run whether user is logged on or not" plus headless mode.
 */
export async function ensureWorkerHealthy(config: BrowserWorkerConfig): Promise<WorkerHealthResult> {
  if (await probeWorker(config)) {
    return { healthy: true, restartAttempted: false, recovered: false, detail: "worker healthy" };
  }

  if (!config.browserWorkerAutostartEnabled) {
    return {
      healthy: false,
      restartAttempted: false,
      recovered: false,
      detail: "worker unreachable and autostart is disabled"
    };
  }

  const sinceLastAttempt = Date.now() - lastRestartAttemptMs;
  if (lastRestartAttemptMs > 0 && sinceLastAttempt < config.browserWorkerRestartCooldownMs) {
    return {
      healthy: false,
      restartAttempted: false,
      recovered: false,
      detail: `worker unreachable; restart suppressed by cooldown (${Math.round(sinceLastAttempt / 1000)}s of ${Math.round(config.browserWorkerRestartCooldownMs / 1000)}s elapsed)`
    };
  }

  lastRestartAttemptMs = Date.now();
  console.warn(`Browser worker unreachable at ${config.browserWorkerUrl}; attempting restart`);
  const commandOutput = await runStartCommand(
    config.browserWorkerAutostartCommand,
    config.browserWorkerStartupTimeoutMs
  );

  // Cold start is slow: Playwright has to launch a persistent Chrome context.
  const deadline = Date.now() + config.browserWorkerStartupTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await probeWorker(config)) {
      const elapsed = Math.round((config.browserWorkerStartupTimeoutMs - (deadline - Date.now())) / 1000);
      console.warn(`Browser worker recovered after restart (${elapsed}s)`);
      return {
        healthy: true,
        restartAttempted: true,
        recovered: true,
        detail: `worker recovered after restart in ~${elapsed}s (${commandOutput})`
      };
    }
  }

  return {
    healthy: false,
    restartAttempted: true,
    recovered: false,
    detail: `worker still unreachable ${Math.round(config.browserWorkerStartupTimeoutMs / 1000)}s after restart (${commandOutput}). If the Windows host is locked or logged out, HEADLESS=false cannot start.`
  };
}
