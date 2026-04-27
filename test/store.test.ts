import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SeenStore } from "../src/store.js";

describe("SeenStore", () => {
  it("persists seen urls", async () => {
    const folder = await mkdtemp(join(tmpdir(), "gumtree-watch-"));
    const file = join(folder, "seen.json");

    const first = new SeenStore(file);
    await first.load();
    await first.add("https://example.com/1");

    const second = new SeenStore(file);
    await second.load();

    expect(second.has("https://example.com/1")).toBe(true);

    const stored = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      entries: Array<{ url: string; seenAt: number }>;
    };
    expect(stored.version).toBe(2);
    expect(stored.entries.some((entry) => entry.url === "https://example.com/1")).toBe(true);
  });

  it("loads legacy string-array format and migrates it", async () => {
    const folder = await mkdtemp(join(tmpdir(), "gumtree-watch-"));
    const file = join(folder, "seen.json");
    await writeFile(file, JSON.stringify(["https://example.com/legacy"], null, 2));

    const store = new SeenStore(file);
    await store.load();

    expect(store.has("https://example.com/legacy")).toBe(true);

    const stored = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      entries: Array<{ url: string; seenAt: number }>;
    };
    expect(stored.version).toBe(2);
    expect(stored.entries.some((entry) => entry.url === "https://example.com/legacy")).toBe(true);
  });

  it("evicts entries older than retention days", async () => {
    const folder = await mkdtemp(join(tmpdir(), "gumtree-watch-"));
    const file = join(folder, "seen.json");
    const day = 24 * 60 * 60 * 1000;
    const nowMs = Date.UTC(2026, 0, 10);
    await writeFile(
      file,
      JSON.stringify(
        {
          version: 2,
          entries: [
            { url: "https://example.com/old", seenAt: nowMs - 5 * day },
            { url: "https://example.com/new", seenAt: nowMs - day }
          ]
        },
        null,
        2
      )
    );

    const store = new SeenStore(file, {
      retentionDays: 2,
      maxEntries: 100,
      now: () => nowMs
    });
    await store.load();

    expect(store.has("https://example.com/old")).toBe(false);
    expect(store.has("https://example.com/new")).toBe(true);
  });

  it("evicts oldest entries when max entries is exceeded", async () => {
    const folder = await mkdtemp(join(tmpdir(), "gumtree-watch-"));
    const file = join(folder, "seen.json");
    const nowMs = Date.UTC(2026, 0, 10);
    let tick = 0;
    const store = new SeenStore(file, {
      retentionDays: 365,
      maxEntries: 2,
      now: () => nowMs + tick++
    });

    await store.load();
    await store.add("https://example.com/1");
    await store.add("https://example.com/2");
    await store.add("https://example.com/3");

    expect(store.has("https://example.com/1")).toBe(false);
    expect(store.has("https://example.com/2")).toBe(true);
    expect(store.has("https://example.com/3")).toBe(true);
  });

  it("rotates corrupt store files and recovers with an empty state", async () => {
    const folder = await mkdtemp(join(tmpdir(), "gumtree-watch-"));
    const file = join(folder, "seen.json");
    await writeFile(file, "{not-json");

    const store = new SeenStore(file);
    await store.load();

    expect(store.has("https://example.com/1")).toBe(false);

    const files = await readdir(folder);
    expect(files.some((name) => name.startsWith("seen.json.corrupt-"))).toBe(true);
  });
});
