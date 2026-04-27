import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Monitor } from "../src/monitor.js";

describe("delivery canary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs successful canary run with sent=1 when webhook transport is ready", async () => {
    const folder = await mkdtemp(join(tmpdir(), "gumtree-canary-ok-"));
    const dataPath = join(folder, "seen-listings.json");
    const diagnosticsLogPath = join(folder, "diagnostics.log");
    const fixturePath = join(process.cwd(), "test/fixtures/gumtree-search-stable.html");

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("example.com/webhook")) {
        return new Response("", { status: 200 });
      }
      const html = await readFile(fixturePath, "utf8");
      return new Response(html, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const config = loadConfig({
      POSTCODE: "SW1A 1AA",
      WHATSAPP_TO: "whatsapp:+447700900000",
      WHATSAPP_ALERT_WEBHOOK_URL: "https://example.com/webhook",
      RETRY_ATTEMPTS: "1",
      RETRY_DELAY_MS: "1",
      DATA_PATH: dataPath,
      DIAGNOSTICS_LOG_PATH: diagnosticsLogPath,
      DELIVERY_CANARY_ENABLED: "true",
      DELIVERY_CANARY_FIXTURE_PATH: fixturePath,
      DELIVERY_CANARY_KEYWORD: "lawnmower"
    });

    const monitor = new Monitor(config);
    await monitor.init();
    await monitor.runCycle();

    const lines = (await readFile(diagnosticsLogPath, "utf8")).trim().split("\n");
    const canaryEntries = lines
      .map((line) => JSON.parse(line) as { outcome: string; details?: Record<string, unknown> })
      .filter((entry) => entry.details?.checkType === "delivery_canary");

    expect(canaryEntries).toHaveLength(1);
    expect(canaryEntries[0]?.outcome).toBe("success");
    expect(canaryEntries[0]?.details?.sent).toBe(1);
    expect(canaryEntries[0]?.details?.expectedMinimumSent).toBe(1);
  });

  it("fails canary when readiness gate is not webhook+ready", async () => {
    const folder = await mkdtemp(join(tmpdir(), "gumtree-canary-fail-"));
    const dataPath = join(folder, "seen-listings.json");
    const diagnosticsLogPath = join(folder, "diagnostics.log");

    const config = loadConfig({
      POSTCODE: "SW1A 1AA",
      WHATSAPP_TO: "whatsapp:+447700900000",
      DRY_RUN: "true",
      RETRY_ATTEMPTS: "1",
      RETRY_DELAY_MS: "1",
      DATA_PATH: dataPath,
      DIAGNOSTICS_LOG_PATH: diagnosticsLogPath,
      DELIVERY_CANARY_ENABLED: "true"
    });

    const monitor = new Monitor(config);
    await monitor.init();
    await monitor.runCycle();

    const lines = (await readFile(diagnosticsLogPath, "utf8")).trim().split("\n");
    const canaryEntries = lines
      .map((line) => JSON.parse(line) as { outcome: string; errorDetail?: string; details?: Record<string, unknown> })
      .filter((entry) => entry.details?.checkType === "delivery_canary");

    expect(canaryEntries).toHaveLength(1);
    expect(canaryEntries[0]?.outcome).toBe("failure");
    expect(canaryEntries[0]?.errorDetail).toContain("Canary readiness gate failed");
  });
});
