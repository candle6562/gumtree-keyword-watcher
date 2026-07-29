import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * A totally failed cycle and a nothing-new cycle look identical from the
 * outside: silence. That is how a dead browser worker went unnoticed from
 * 2026-07-26 to 2026-07-29. This tracks consecutive failures across cron
 * invocations so the watcher can say so out loud — once, not every ten minutes.
 */
export interface HealthState {
  consecutiveFailures: number;
  firstFailureAt: number | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  /** Latch: set when the degraded alert has been sent, cleared on recovery. */
  degradedAlertSentAt: number | null;
  lastRestartAttemptAt: number | null;
}

const EMPTY_STATE: HealthState = {
  consecutiveFailures: 0,
  firstFailureAt: null,
  lastFailureAt: null,
  lastSuccessAt: null,
  degradedAlertSentAt: null,
  lastRestartAttemptAt: null
};

export class HealthStateStore {
  private state: HealthState = { ...EMPTY_STATE };

  constructor(private readonly filePath: string) {}

  async load(): Promise<HealthState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<HealthState>;
      this.state = { ...EMPTY_STATE, ...parsed };
    } catch {
      // Missing or corrupt state is not worth failing a cycle over; a reset
      // costs at most one duplicate degraded alert.
      this.state = { ...EMPTY_STATE };
    }
    return this.state;
  }

  current(): HealthState {
    return { ...this.state };
  }

  async recordFailure(now = Date.now()): Promise<HealthState> {
    this.state.consecutiveFailures += 1;
    this.state.lastFailureAt = now;
    if (this.state.firstFailureAt === null) {
      this.state.firstFailureAt = now;
    }
    await this.persist();
    return this.current();
  }

  async recordSuccess(now = Date.now()): Promise<{ state: HealthState; recoveredFromDegraded: boolean }> {
    const recoveredFromDegraded = this.state.degradedAlertSentAt !== null;
    this.state.consecutiveFailures = 0;
    this.state.firstFailureAt = null;
    this.state.lastSuccessAt = now;
    this.state.degradedAlertSentAt = null;
    await this.persist();
    return { state: this.current(), recoveredFromDegraded };
  }

  async markDegradedAlertSent(now = Date.now()): Promise<void> {
    this.state.degradedAlertSentAt = now;
    await this.persist();
  }

  async markRestartAttempt(now = Date.now()): Promise<void> {
    this.state.lastRestartAttemptAt = now;
    await this.persist();
  }

  /** True on the exact cycle that crosses the threshold, false thereafter. */
  shouldSendDegradedAlert(threshold: number): boolean {
    return this.state.consecutiveFailures >= threshold && this.state.degradedAlertSentAt === null;
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tempPath = join(
      dir,
      `.${basename(this.filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await writeFile(tempPath, JSON.stringify(this.state, null, 2));
    try {
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
