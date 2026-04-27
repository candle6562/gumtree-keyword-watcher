import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Monitor } from "../src/monitor.js";

describe("integration smoke", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs a full cycle against a stable Gumtree fixture and dedupes on rerun", async () => {
    const folder = await mkdtemp(join(tmpdir(), "gumtree-smoke-"));
    const dataPath = join(folder, "seen-listings.json");
    const diagnosticsLogPath = join(folder, "diagnostics.log");
    const fixtureHtml = await readFile(join(process.cwd(), "test/fixtures/gumtree-search-stable.html"), "utf8");

    const fetchMock = vi.fn(async () => new Response(fixtureHtml, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const config = loadConfig({
      POSTCODE: "SW1A 1AA",
      WHATSAPP_TO: "whatsapp:+447700900000",
      DRY_RUN: "true",
      KEYWORDS: "strimmer",
      RETRY_ATTEMPTS: "1",
      RETRY_DELAY_MS: "1",
      DATA_PATH: dataPath,
      DIAGNOSTICS_LOG_PATH: diagnosticsLogPath
    });

    const monitor = new Monitor(config);
    await monitor.init();

    await monitor.runCycle();
    await monitor.runCycle();

    expect(fetchMock).toHaveBeenCalledTimes(4);

    const stored = JSON.parse(await readFile(dataPath, "utf8")) as {
      version: number;
      entries: Array<{ url: string; seenAt: number }>;
    };

    expect(stored.version).toBe(2);
    expect(stored.entries).toHaveLength(2);
    expect(stored.entries.map((entry) => entry.url).sort()).toEqual([
      "https://www.gumtree.com/p/garden-tools/flymo-strimmer-25cm/202",
      "https://www.gumtree.com/p/lawnmowers/honda-izy-hrg466/101"
    ]);

    const diagnosticsLines = (await readFile(diagnosticsLogPath, "utf8")).trim().split("\n");
    expect(diagnosticsLines).toHaveLength(4);

    const parsed = diagnosticsLines.map((line) =>
      JSON.parse(line) as {
        outcome: "success" | "failure";
        details: { keyword: string; sent: number };
      }
    );
    expect(parsed.every((entry) => entry.outcome === "success")).toBe(true);

    const sentByKeyword = new Map<string, number[]>();
    for (const entry of parsed) {
      const keyword = entry.details.keyword;
      const sent = entry.details.sent;
      sentByKeyword.set(keyword, [...(sentByKeyword.get(keyword) ?? []), sent]);
    }

    expect(sentByKeyword.get("lawnmower")).toEqual([1, 0]);
    expect(sentByKeyword.get("strimmer")).toEqual([1, 0]);
  });
});
