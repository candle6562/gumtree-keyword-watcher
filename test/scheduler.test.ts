import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMonitorLoop } from "../src/scheduler.js";

describe("startMonitorLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not overlap cycles when one run is still in flight", async () => {
    let resolveCycle: (() => void) | undefined;
    const monitor = {
      runCycle: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveCycle = resolve;
          })
      )
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const timer = startMonitorLoop(monitor, 1_000);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(monitor.runCycle).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    resolveCycle?.();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitor.runCycle).toHaveBeenCalledTimes(2);

    clearInterval(timer);
  });

  it("recovers the lock after a cycle throws", async () => {
    let attempt = 0;
    const monitor = {
      runCycle: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("boom");
        }
      })
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const timer = startMonitorLoop(monitor, 1_000);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(monitor.runCycle).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    clearInterval(timer);
  });
});
