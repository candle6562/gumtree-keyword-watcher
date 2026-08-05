import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";
import { searchFacebookMarketplaceDetailed } from "./facebook-marketplace.js";
import type { Listing } from "./types.js";

/**
 * Price tracking for listings we have already matched.
 *
 * Deliberately separate from SeenStore. That store answers "have we alerted
 * this yet" and prunes on a retention window; price history has to outlive
 * that, because the interesting drops are on listings that sat unsold for
 * weeks.
 */
export interface PriceObservation {
  price: number;
  at: number;
}

export interface PriceRecord {
  url: string;
  title?: string;
  location?: string;
  /**
   * Which watch this listing belongs to.
   *
   * Load-bearing for absence detection: one store holds every watch's
   * listings, and a sweep only ever enumerates one watch's search term. Without
   * this scope a camper van sweep sees no Garmin watches and concludes all 46
   * of them sold.
   */
  watchName?: string;
  history: PriceObservation[];
  lastSeenAt: number;
  /** Consecutive complete sweeps in which this listing did not appear. */
  missedSweeps: number;
  /** Set once it has been missing long enough to call it gone. */
  goneAt?: number;
}

/** What one sweep of a watch saw, kept so the next can judge its own health. */
export interface SweepStat {
  at: number;
  seen: number;
}

interface PersistedPrices {
  version: 1;
  items: Record<string, PriceRecord>;
  sweeps?: Record<string, SweepStat>;
}

/** Strip Facebook's tracking query string so the same listing keys consistently. */
export function canonicalUrl(url: string): string {
  return url.split("?")[0];
}

/**
 * Parse a price string to a number.
 *
 * A reduced listing renders the new price immediately followed by the struck
 * through original, and the card scraper concatenates them into one string
 * ("£80£100"). The first amount is what is being asked today; the second is
 * Facebook telling us the price dropped, which is worth keeping as
 * corroboration rather than letting "80100" through as a number.
 */
export function parsePrice(raw?: string | null): { current: number | null; previous: number | null } {
  if (!raw) return { current: null, previous: null };
  const amounts = Array.from(raw.matchAll(/[£$€]\s?([\d,]+(?:\.\d+)?)/g)).map((m) =>
    Number(m[1].replace(/,/g, ""))
  );
  if (amounts.length === 0) return { current: null, previous: null };
  return { current: amounts[0], previous: amounts.length > 1 ? amounts[1] : null };
}

export class PriceStore {
  private items = new Map<string, PriceRecord>();
  private sweeps = new Map<string, SweepStat>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as PersistedPrices;
      if (parsed && parsed.version === 1 && parsed.items) {
        this.items = new Map(Object.entries(parsed.items));
        this.sweeps = new Map(Object.entries(parsed.sweeps ?? {}));
      }
    } catch {
      this.items = new Map();
      this.sweeps = new Map();
    }
  }

  lastSweep(watchName: string): SweepStat | undefined {
    return this.sweeps.get(watchName);
  }

  recordSweep(watchName: string, seen: number): void {
    this.sweeps.set(watchName, { at: Date.now(), seen });
  }

  get(url: string): PriceRecord | undefined {
    return this.items.get(canonicalUrl(url));
  }

  set(record: PriceRecord): void {
    this.items.set(canonicalUrl(record.url), record);
  }

  all(): PriceRecord[] {
    return Array.from(this.items.values());
  }

  async persist(): Promise<void> {
    const payload: PersistedPrices = {
      version: 1,
      items: Object.fromEntries(this.items),
      sweeps: Object.fromEntries(this.sweeps)
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}

/** How many consecutive complete sweeps a listing must miss before it counts as gone. */
export const MISSES_BEFORE_GONE = 2;

/**
 * How far this sweep's live count may fall below the previous sweep's before
 * its absences stop being trustworthy.
 *
 * Measured against the last sweep, never against how many listings we track.
 * Tracked count is the wrong denominator: sold listings are *supposed* to go
 * missing, so "seen / tracked" falls precisely when the feature is working, and
 * a guard built on it can never confirm a sale. Comparing like with like asks
 * the only question that matters — did the search itself still work?
 */
export const MIN_SWEEP_RETENTION = 0.5;

/**
 * Fewest live listings a sweep must see before its absences may condemn anything.
 *
 * Retention alone is not enough: it compares this sweep to the last, so a
 * search that returns one result twice running looks perfectly stable at 100%
 * and would confirm every other tracked listing as sold. A term that has
 * stopped matching, or a source quietly degrading, both look exactly like that.
 * Below this floor the sweep simply is not a picture of a market.
 */
export const MIN_SEEN_TO_CONDEMN = 10;

export interface EnumerationResult {
  items: Map<string, Listing>;
  queries: number;
  /** True only when the sweep can account for the whole in-area market. */
  complete: boolean;
  reason: string;
  sawMarker: boolean;
}

/**
 * Read the whole in-area market for a watch in a single search.
 *
 * Marketplace renders its results as one infinitely scrolling grid, so the way
 * to see everything is to keep scrolling — not to re-query. An earlier design
 * split the price range into bands and issued a fresh search per band, on the
 * belief that Facebook capped a search at 50 results. It does not: that cap was
 * our own MAX_RESULTS setting. Removing it turned 159 searches into one, which
 * matters because bursts of searches are exactly what looks like scraping.
 *
 * Scrolling far enough reaches Facebook's "results from outside your search"
 * heading, at which point every in-area listing has been rendered. That marker,
 * not a query count, is what tells us a sweep is complete.
 */
export async function sweepMarket(
  config: AppConfig,
  term: string,
  distanceKm: number,
  range: { min: number; max: number },
  options: { maxResults?: number; harvestTimeoutMs?: number } = {}
): Promise<EnumerationResult> {
  const maxResults = options.maxResults ?? 1000;
  const harvestTimeoutMs = options.harvestTimeoutMs ?? 180000;

  const items = new Map<string, Listing>();
  try {
    const page = await searchFacebookMarketplaceDetailed(
      config,
      term,
      undefined,
      maxResults,
      distanceKm,
      { min: range.min, max: range.max },
      // Never pass knownUrls here: stopping at already-known listings is right
      // for finding new ones and fatal for re-reading prices on old ones.
      undefined,
      harvestTimeoutMs
    );
    for (const item of page.items) items.set(canonicalUrl(item.url), item);

    const reason = page.harvest.reason ?? "unknown";
    const sawMarker = Boolean(page.harvest.sawMarker);
    console.log(
      `swept £${range.min}-£${range.max}: ${page.rawCount} raw / ${page.items.length} kept ` +
        `in ${page.harvest.steps ?? "?"} scroll steps (${reason}${sawMarker ? ", reached out-of-area boundary" : ""})`
    );

    return {
      items,
      queries: 1,
      // Complete means we can account for the whole local market: either the
      // grid ran out, or we scrolled past the point where Facebook starts
      // padding with listings outside the radius. Stopping on our own result
      // ceiling or a timeout proves nothing about what we did not reach.
      complete: sawMarker || reason === "exhausted",
      reason,
      sawMarker
    };
  } catch (error) {
    console.error(`Sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    return { items, queries: 1, complete: false, reason: "failed", sawMarker: false };
  }
}

export interface PriceChange {
  url: string;
  title: string;
  location?: string;
  from: number;
  to: number;
  /** Struck-through original Facebook rendered on the card, when present. */
  facebookPrevious?: number;
}

export interface PriceSweepResult {
  tracked: number;
  seen: number;
  queries: number;
  complete: boolean;
  unchanged: number;
  drops: PriceChange[];
  rises: PriceChange[];
  gone: Array<{ url: string; title: string; lastPrice?: number }>;
  missingButUnconfirmed: number;
  /** Diagnostics, surfaced in the report so a bad run is visible from the phone. */
  reason: string;
  sawMarker: boolean;
  previousSeen?: number;
  retention?: number;
  authoritative: boolean;
  newlyTracked: number;
  storeSize: number;
}

/**
 * Fold one enumeration into the price history and report what moved.
 *
 * Absence is only treated as "sold" when the sweep achieved full coverage and
 * the listing has been missing for MISSES_BEFORE_GONE sweeps running. A
 * saturated band means we simply could not see everything, and calling those
 * listings sold would be guesswork.
 */
export function applySweep(
  store: PriceStore,
  enumeration: EnumerationResult,
  tracked: Array<Listing & { seenAt?: number }>,
  watchName: string
): PriceSweepResult {
  const now = Date.now();
  const result: PriceSweepResult = {
    tracked: tracked.length,
    seen: enumeration.items.size,
    queries: enumeration.queries,
    complete: enumeration.complete,
    unchanged: 0,
    drops: [],
    rises: [],
    gone: [],
    missingButUnconfirmed: 0,
    reason: enumeration.reason,
    sawMarker: enumeration.sawMarker,
    authoritative: false,
    newlyTracked: 0,
    storeSize: 0
  };

  // Seed anything we track but have never priced, so the first sweep after
  // deployment establishes a baseline instead of reporting spurious changes.
  for (const listing of tracked) {
    const key = canonicalUrl(listing.url);
    if (store.get(key)) continue;
    const seeded = parsePrice(listing.price).current;
    if (seeded === null) continue;
    store.set({
      url: key,
      title: listing.title,
      location: listing.location,
      watchName,
      history: [{ price: seeded, at: listing.seenAt ?? now }],
      lastSeenAt: listing.seenAt ?? now,
      missedSweeps: 0
    });
  }

  for (const [url, item] of enumeration.items) {
    const { current, previous } = parsePrice(item.price);
    if (current === null) continue;

    const record = store.get(url);
    if (!record) {
      result.newlyTracked += 1;
      store.set({
        url,
        title: item.title,
        location: item.location,
        watchName,
        history: [{ price: current, at: now }],
        lastSeenAt: now,
        missedSweeps: 0
      });
      continue;
    }

    const last = record.history[record.history.length - 1]?.price ?? null;
    const history = [...record.history];

    if (last === null) {
      history.push({ price: current, at: now });
    } else if (current !== last) {
      history.push({ price: current, at: now });
      const change: PriceChange = {
        url,
        title: item.title || record.title || "(unknown)",
        location: item.location ?? record.location,
        from: last,
        to: current,
        facebookPrevious: previous ?? undefined
      };
      (current < last ? result.drops : result.rises).push(change);
    } else {
      result.unchanged += 1;
    }

    store.set({
      url,
      title: item.title || record.title,
      location: item.location ?? record.location,
      watchName: record.watchName ?? watchName,
      history,
      lastSeenAt: now,
      missedSweeps: 0,
      goneAt: undefined
    });
  }

  // Decide whether this sweep's absences mean anything, by asking whether the
  // search still works — not whether the listings we track showed up. A sweep
  // that returns roughly what the last one did is healthy, and anything missing
  // from it is genuinely missing. A sweep that collapses (throttled, term
  // stopped matching, worker degraded) is telling us nothing about the market.
  //
  // The first sweep has no baseline, but it also cannot condemn anything:
  // MISSES_BEFORE_GONE requires two consecutive sweeps, so by the time a
  // removal can be confirmed a baseline always exists.
  const previous = store.lastSweep(watchName);
  const retention = previous && previous.seen > 0 ? result.seen / previous.seen : 1;
  const healthy = retention >= MIN_SWEEP_RETENTION;
  const substantial = result.seen >= MIN_SEEN_TO_CONDEMN;
  const authoritative = enumeration.complete && healthy && substantial;

  if (enumeration.complete && !healthy) {
    console.warn(
      `Sweep for '${watchName}' saw ${result.seen}, down from ${previous?.seen} last time ` +
        `(${(retention * 100).toFixed(0)}%) — treating as a search failure, not ${result.tracked} sales`
    );
  }
  if (enumeration.complete && healthy && !substantial) {
    console.warn(
      `Sweep for '${watchName}' saw only ${result.seen} listings — too few to conclude anything about the rest`
    );
  }
  store.recordSweep(watchName, result.seen);
  result.previousSeen = previous?.seen;
  result.retention = previous && previous.seen > 0 ? retention : undefined;
  result.authoritative = authoritative;

  for (const record of store.all()) {
    if (record.goneAt) continue;
    // This sweep only searched one watch's term, so it says nothing at all
    // about listings belonging to any other watch.
    if (record.watchName !== watchName) continue;
    if (enumeration.items.has(canonicalUrl(record.url))) continue;

    if (!authoritative) {
      result.missingButUnconfirmed += 1;
      continue;
    }

    const missed = (record.missedSweeps ?? 0) + 1;
    if (missed >= MISSES_BEFORE_GONE) {
      store.set({ ...record, missedSweeps: missed, goneAt: now });
      result.gone.push({
        url: record.url,
        title: record.title ?? "(unknown)",
        lastPrice: record.history[record.history.length - 1]?.price
      });
    } else {
      store.set({ ...record, missedSweeps: missed });
      result.missingButUnconfirmed += 1;
    }
  }

  result.storeSize = store.all().filter((r) => r.watchName === watchName).length;
  return result;
}

/** Always-on report: a silent job is indistinguishable from a broken one. */
export function formatPriceReport(result: PriceSweepResult, watchLabel: string): string {
  const coverage = result.complete
    ? "full coverage"
    : "partial — stopped before the out-of-area boundary";

  const lines: string[] = [
    `💰 Price check: ${watchLabel}`,
    `Saw ${result.seen} live listings in ${result.queries} search${result.queries === 1 ? "" : "es"} (${coverage})`,
    `Tracking ${result.tracked} — ${result.unchanged} unchanged`,
    ""
  ];

  if (result.drops.length === 0) {
    lines.push("No price drops since last check.");
  } else {
    lines.push(`📉 ${result.drops.length} price drop${result.drops.length === 1 ? "" : "s"}`);
    lines.push("");
    for (const [i, d] of result.drops.entries()) {
      const pct = Math.round(((d.to - d.from) / d.from) * 100);
      lines.push(`${i + 1}. ${d.title}`);
      lines.push(`💷 £${d.from.toLocaleString("en-GB")} → £${d.to.toLocaleString("en-GB")} (${pct}%)`);
      if (d.location) lines.push(`🧭 ${d.location}`);
      lines.push(`🔗 ${d.url}`);
      if (i < result.drops.length - 1) lines.push("");
    }
  }

  if (result.rises.length > 0) {
    lines.push("", `📈 ${result.rises.length} price increase${result.rises.length === 1 ? "" : "s"} (not listed)`);
  }

  if (result.gone.length > 0) {
    lines.push("", `🏁 ${result.gone.length} sold or withdrawn`);
    for (const gone of result.gone.slice(0, 10)) {
      const price = gone.lastPrice ? ` (was £${gone.lastPrice.toLocaleString("en-GB")})` : "";
      lines.push(`• ${gone.title}${price}`);
    }
    if (result.gone.length > 10) lines.push(`• …and ${result.gone.length - 10} more`);
  }

  if (result.missingButUnconfirmed > 0) {
    lines.push("", `❓ ${result.missingButUnconfirmed} not seen this sweep (awaiting confirmation)`);
  }

  lines.push("", "🔧 debug");
  lines.push(`scroll ended: ${result.reason}${result.sawMarker ? " (reached out-of-area boundary)" : ""}`);
  if (result.previousSeen !== undefined) {
    const pct = result.retention !== undefined ? ` (${Math.round(result.retention * 100)}%)` : "";
    lines.push(`live vs last sweep: ${result.seen} vs ${result.previousSeen}${pct}`);
  } else {
    lines.push("live vs last sweep: no baseline yet (first run)");
  }
  lines.push(`new to price history: ${result.newlyTracked}`);
  lines.push(`price history size: ${result.storeSize}`);
  lines.push(`removals confirmable: ${result.authoritative ? "yes" : "no — sweep not authoritative"}`);

  return lines.join("\n");
}
