import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TriageResult } from "./index.js";

interface CacheEntry {
  result: TriageResult;
  specHash: string;
  model: string;
  triagedAt: string;
}

interface PersistedTriageCache {
  version: 1;
  entries: Record<string, CacheEntry>;
}

/**
 * Caches a triage verdict per listing.
 *
 * Two reasons this matters beyond saving pennies. Re-running after a formatting
 * or message-layout change should not re-score fifty adverts, and a cached run
 * is deterministic — comparing output across code changes is meaningless if the
 * model re-judges everything each time.
 *
 * Keyed on the spec text and model as well as the URL: change either and the
 * old verdict is no longer the answer to the question being asked.
 */
export class TriageCache {
  private entries = new Map<string, CacheEntry>();
  private dirty = false;

  constructor(private readonly filePath: string) {}

  static hashSpec(prose: string): string {
    return createHash("sha256").update(prose).digest("hex").slice(0, 16);
  }

  private key(url: string, specHash: string, model: string): string {
    return `${specHash}|${model}|${url}`;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<PersistedTriageCache>;
      if (parsed.version === 1 && parsed.entries) {
        this.entries = new Map(Object.entries(parsed.entries));
      }
    } catch {
      this.entries = new Map();
    }
  }

  get(url: string, specHash: string, model: string): TriageResult | undefined {
    return this.entries.get(this.key(url, specHash, model))?.result;
  }

  set(result: TriageResult, specHash: string, model: string): void {
    this.entries.set(this.key(result.url, specHash, model), {
      result,
      specHash,
      model,
      triagedAt: new Date().toISOString()
    });
    this.dirty = true;
  }

  count(): number {
    return this.entries.size;
  }

  async persist(): Promise<void> {
    if (!this.dirty) return;
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const payload: PersistedTriageCache = { version: 1, entries: Object.fromEntries(this.entries) };
    const tempPath = join(
      dir,
      `.${basename(this.filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await writeFile(tempPath, JSON.stringify(payload, null, 2));
    try {
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
    this.dirty = false;
  }
}
