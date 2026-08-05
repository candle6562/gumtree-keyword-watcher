import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface SeenEntry {
  url: string;
  seenAt: number;
  title?: string;
  matchedKeyword?: string;
  watchName?: string;
  source?: string;
  price?: string;
  location?: string;
  postedDate?: string;
  /**
   * Whether the alert for this listing actually reached WhatsApp.
   *
   * Listings are recorded as seen at match time so a transport outage cannot
   * cause the same listing to be re-matched as "new" on every ten-minute cycle
   * — that behaviour built a 355-message backlog and flooded the group chat on
   * 2026-07-22. Delivery is then tracked separately so marking seen early does
   * not silently drop anything: undelivered entries are retried on later cycles.
   *
   * Legacy entries predate this field and were only ever written after a
   * successful send, so `undefined` means delivered.
   */
  delivered?: boolean;
  /**
   * Every asking price we have observed, oldest first.
   *
   * Lives here rather than in a store of its own. Keeping it separate meant two
   * records for one listing that drifted apart: `price` freezes at first sight
   * while the sweep tracked the real one, and 23 listings ended up holding two
   * different "current" prices — with alerts reading the stale one.
   */
  priceHistory?: Array<{ price: number; at: number }>;
  /** Last time a sweep actually saw this listing. */
  lastSeenAt?: number;
  /** Consecutive authoritative sweeps in which it did not appear. */
  missedSweeps?: number;
  /** Set once it has been missing long enough to call it gone. */
  goneAt?: number;
  /**
   * Vehicle assessment, kept so the daily digest can rank listings without
   * paying for the model again. Written once, when the listing is alerted.
   */
  vehicle?: {
    mileage?: number | null;
    mpg?: number | null;
    aircon?: boolean | null;
    converted?: boolean | null;
    /** Spec match, 0-100. */
    score?: number;
    verdict?: "shortlist" | "maybe" | "reject";
    valueForMoney?: { score: number; reason: string };
  };
}

/** What one sweep of a watch saw, kept so the next can judge its own health. */
export interface SweepStat {
  at: number;
  seen: number;
}

interface SeenStoreOptions {
  retentionDays: number;
  maxEntries: number;
  now?: () => number;
}

interface PersistedSeenStoreV2 {
  version: 2;
  entries: SeenEntry[];
  sweeps?: Record<string, SweepStat>;
}

export class SeenStore {
  private readonly seenByUrl = new Map<string, SeenEntry>();
  private sweeps = new Map<string, SweepStat>();
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

  lastSweep(watchName: string): SweepStat | undefined {
    return this.sweeps.get(watchName);
  }

  recordSweep(watchName: string, seen: number): void {
    this.sweeps.set(watchName, { at: this.now(), seen });
  }

  /**
   * Update entries in place without touching `seenAt`.
   *
   * A sweep re-observing a listing is not the same event as first matching it:
   * `seenAt` is what retention and "is this new" are keyed on, so a sweep must
   * never look like a fresh sighting.
   */
  async update(entries: SeenEntry[]): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) this.seenByUrl.set(entry.url, entry);
    this.applyRetention();
    await this.persist();
  }

  entries(): SeenEntry[] {
    return Array.from(this.seenByUrl.values());
  }

  get(url: string): SeenEntry | undefined {
    return this.seenByUrl.get(url);
  }

  count(): number {
    return this.seenByUrl.size;
  }

  countSince(sinceMs: number): number {
    return Array.from(this.seenByUrl.values()).filter((entry) => entry.seenAt >= sinceMs).length;
  }

  async add(url: string): Promise<void> {
    await this.addEntry({ url });
  }

  async addEntry(entry: Omit<SeenEntry, "seenAt"> & { seenAt?: number }): Promise<void> {
    this.seenByUrl.set(entry.url, { ...entry, seenAt: entry.seenAt ?? this.now() });
    this.applyRetention();
    await this.persist();
  }

  /**
   * Record entries without persisting between each one — a batch of matches is
   * a single logical write.
   */
  async addEntries(entries: Array<Omit<SeenEntry, "seenAt"> & { seenAt?: number }>): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) {
      this.seenByUrl.set(entry.url, { ...entry, seenAt: entry.seenAt ?? this.now() });
    }
    this.applyRetention();
    await this.persist();
  }

  /** Entries that were matched but whose alert never reached WhatsApp. */
  pendingDelivery(watchName?: string): SeenEntry[] {
    return Array.from(this.seenByUrl.values())
      .filter((entry) => entry.delivered === false)
      .filter((entry) => watchName === undefined || entry.watchName === watchName)
      .sort((left, right) => left.seenAt - right.seenAt);
  }

  async markDelivered(urls: string[]): Promise<void> {
    let changed = false;
    for (const url of urls) {
      const entry = this.seenByUrl.get(url);
      if (entry && entry.delivered === false) {
        entry.delivered = true;
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  private loadParsedState(parsed: unknown): void {
    this.seenByUrl.clear();
    this.sweeps.clear();
    const entries = this.parseEntries(parsed);
    entries.forEach((entry) => {
      this.seenByUrl.set(entry.url, entry);
    });
    const sweeps = (parsed as Partial<PersistedSeenStoreV2>)?.sweeps;
    if (sweeps && typeof sweeps === "object") {
      for (const [watch, stat] of Object.entries(sweeps)) {
        if (stat && Number.isFinite(stat.seen)) this.sweeps.set(watch, stat);
      }
    }
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
      // Retention runs on the most recent contact of any kind. A listing the
      // sweep still sees every few hours is live, however long ago it was first
      // matched, and dropping it would lose its whole price history.
      .filter(([, entry]) => Math.max(entry.seenAt, entry.lastSeenAt ?? 0) >= retentionCutoffMs)
      .sort((left, right) => left[1].seenAt - right[1].seenAt);

    const bounded = retained.slice(Math.max(0, retained.length - this.options.maxEntries));
    this.seenByUrl.clear();
    bounded.forEach(([url, entry]) => this.seenByUrl.set(url, entry));
  }

  private async persist(): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const payload = JSON.stringify(
      {
        version: 2,
        entries: Array.from(this.seenByUrl.values()),
        sweeps: Object.fromEntries(this.sweeps)
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
