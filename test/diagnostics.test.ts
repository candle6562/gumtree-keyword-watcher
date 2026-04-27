import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticsSink } from "../src/diagnostics.js";

describe("DiagnosticsSink", () => {
  it("appends JSONL entries with required fields", async () => {
    const folder = await mkdtemp(join(tmpdir(), "gumtree-diag-"));
    const file = join(folder, "diagnostics.log");
    const sink = new DiagnosticsSink(file);

    await sink.write({
      timestamp: "2026-04-26T21:30:00Z",
      runRef: "cycle-1",
      outcome: "success",
      transportReadiness: { mode: "webhook", ready: true },
      errorDetail: null,
      nextAction: "Continue next scheduled cycle",
      details: { keyword: "lawnmower", sent: 0 }
    });

    await sink.write({
      timestamp: "2026-04-26T21:31:00Z",
      runRef: "cycle-2",
      outcome: "failure",
      transportReadiness: { mode: "webhook", ready: true },
      errorDetail: "boom",
      nextAction: "Inspect logs",
      details: { keyword: "lawnmower" }
    });

    const raw = await readFile(file, "utf8");
    const rows = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(rows).toHaveLength(2);
    expect(rows[0].outcome).toBe("success");
    expect(rows[1].errorDetail).toBe("boom");
    expect(rows[0]).toHaveProperty("timestamp");
    expect(rows[0]).toHaveProperty("runRef");
    expect(rows[0]).toHaveProperty("nextAction");
    expect(rows[0]).toHaveProperty("transportReadiness");
  });
});
