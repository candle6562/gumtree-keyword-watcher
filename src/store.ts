import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

interface SeenEntry {
  url: string;
  seenAt: number;
}

interface SeenStoreOptions {
  retentionDays: number;
  maxEntries: number;
  now?: () => number;
}

interface PersistedSeenStoreV2 {
  version: 2;
  entries: Array<{
    url: string;
    seenAt: number;
  }>;
}

export class SeenStore {
  private readonly seenByUrl = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly filePath: string,
    private readonly options: SeenStoreOptions = { retentionDays: 30, maxEntries: 5000 }
  ) {
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.loadParsedState(parsed);
      this.applyRetention();
      await this.persist();
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        console.warn(`Seen store at '${this.filePath}' is invalid; rotating and resetting state`);
        const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
        await rename(this.filePath, backupPath).catch(() => undefined);
      }
      this.seenByUrl.clear();
      await this.persist();
    }
  }

  has(url: string): boolean {
    return this.seenByUrl.has(url);
  }

  async add(url: string): Promise<void> {
    this.seenByUrl.set(url, this.now());
    this.applyRetention();
    await this.persist();
  }

  private loadParsedState(parsed: unknown): void {
    this.seenByUrl.clear();
    const entries = this.parseEntries(parsed);
    entries.forEach((entry) => {
      this.seenByUrl.set(entry.url, entry.seenAt);
    });
  }

  private parseEntries(parsed: unknown): SeenEntry[] {
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      const loadedAt = this.now();
      return parsed.map((url) => ({ url, seenAt: loadedAt }));
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Seen store file must be a JSON string array or versioned object");
    }

    const v2 = parsed as Partial<PersistedSeenStoreV2>;
    if (v2.version !== 2 || !Array.isArray(v2.entries)) {
      throw new Error("Seen store file must be a JSON string array or versioned object");
    }

    if (
      v2.entries.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          typeof item.url !== "string" ||
          !Number.isFinite(item.seenAt) ||
          item.seenAt <= 0
      )
    ) {
      throw new Error("Seen store entries must contain { url: string, seenAt: number }");
    }

    return v2.entries as SeenEntry[];
  }

  private applyRetention(): void {
    const retentionCutoffMs = this.now() - this.options.retentionDays * 24 * 60 * 60 * 1000;
    const retained = Array.from(this.seenByUrl.entries())
      .filter(([, seenAt]) => seenAt >= retentionCutoffMs)
      .sort((left, right) => left[1] - right[1]);

    const bounded = retained.slice(Math.max(0, retained.length - this.options.maxEntries));
    this.seenByUrl.clear();
    bounded.forEach(([url, seenAt]) => this.seenByUrl.set(url, seenAt));
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const payload = JSON.stringify(
      {
        version: 2,
        entries: Array.from(this.seenByUrl.entries()).map(([url, seenAt]) => ({ url, seenAt }))
      } as PersistedSeenStoreV2,
      null,
      2
    );
    const tempPath = join(
      dir,
      `.${basename(this.filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );

    await writeFile(tempPath, payload);
    try {
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}
