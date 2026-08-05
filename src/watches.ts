import fs from "node:fs";
import path from "node:path";

/** Search kinds. Only "vehicle" enables the extra per-listing assessment. */
export type WatchType = "default" | "vehicle";

export const WATCH_TYPES: WatchType[] = ["default", "vehicle"];

export interface MarketWatch {
  name: string;
  enabled: boolean;
  frequency: string;
  noChange: boolean;
  distanceKm: number;
  minPrice?: number;
  maxPrice?: number;
  /** Max listing age in days. Facebook only supports these three values. */
  maxAgeDays?: 1 | 7 | 30;
  /** Gumtree search category slug; default "for-sale" is general goods. */
  gumtreeCategory?: string;
  /**
   * What is being searched for.
   *
   * "vehicle" turns on the extra assessment — mileage, air conditioning,
   * whether it is already converted, and a value rating — and switches the
   * alert to the tighter vehicle layout. It costs a model call per listing and
   * means nothing for, say, a watch, so anything else stays "default".
   */
  type: WatchType;
  terms: string[];
}

export interface WatchesFile {
  watches: MarketWatch[];
}

export const WATCHES_FILE_PATH = path.join(process.cwd(), "config", "watches.json");

function defaultWatchesFilePath(): string {
  return process.env.MARKET_WATCHES_FILE || WATCHES_FILE_PATH;
}

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function loadWatches(filePath: string = defaultWatchesFilePath()): MarketWatch[] {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as WatchesFile;
    if (!Array.isArray(raw.watches)) return [];
    return raw.watches
      .filter((watch) => watch && typeof watch.name === "string")
      .map((watch) => ({
        name: normalizeName(watch.name),
        enabled: watch.enabled !== false,
        frequency: watch.frequency || "10m",
        noChange: watch.noChange === true,
        distanceKm: Number.isFinite(Number((watch as Partial<MarketWatch>).distanceKm))
          ? Math.max(1, Math.min(1000, Math.round(Number((watch as Partial<MarketWatch>).distanceKm))))
          : 20,
        minPrice: Number.isFinite(Number((watch as Partial<MarketWatch>).minPrice))
          ? Math.max(0, Math.round(Number((watch as Partial<MarketWatch>).minPrice)))
          : undefined,
        maxPrice: Number.isFinite(Number((watch as Partial<MarketWatch>).maxPrice))
          ? Math.max(0, Math.round(Number((watch as Partial<MarketWatch>).maxPrice)))
          : undefined,
        maxAgeDays: ([1, 7, 30] as const).find(
          (allowed) => allowed === Number((watch as Partial<MarketWatch>).maxAgeDays)
        ),
        gumtreeCategory:
          typeof (watch as Partial<MarketWatch>).gumtreeCategory === "string" &&
          /^[a-z0-9-]+$/.test((watch as Partial<MarketWatch>).gumtreeCategory as string)
            ? ((watch as Partial<MarketWatch>).gumtreeCategory as string)
            : undefined,
        type: (watch as Partial<MarketWatch>).type === "vehicle" ? "vehicle" : "default",
        terms: Array.isArray(watch.terms)
          ? Array.from(new Set(watch.terms.map((term) => String(term).trim().toLowerCase()).filter(Boolean)))
          : []
      }));
  } catch {
    return [];
  }
}

export function saveWatches(watches: MarketWatch[], filePath: string = defaultWatchesFilePath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ watches }, null, 2) + "\n");
}

export function findWatch(watches: MarketWatch[], name: string): MarketWatch | undefined {
  const needle = normalizeName(name).toLowerCase();
  return watches.find((watch) => watch.name.toLowerCase() === needle);
}

export function primaryWatch(watches: MarketWatch[]): MarketWatch | undefined {
  return watches.find((watch) => watch.enabled && watch.terms.length > 0) ?? watches.find((watch) => watch.terms.length > 0);
}
