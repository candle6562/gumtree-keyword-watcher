import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";
import { searchFacebookMarketplaceDetailed } from "./facebook-marketplace.js";
import { type SeenEntry, type SeenStore } from "./store.js";
import type { Listing } from "./types.js";

/**
 * Price sweeping over the seen-store.
 *
 * Price history used to live in a store of its own. That produced two records
 * for one listing which drifted apart — `price` frozen at first sight, the
 * sweep tracking the real one — and left 1,258 listings stranded in a store the
 * sweep no longer covered. One record per listing removes both problems.
 */

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
  /** Seen previously but not in this sweep. Reported, never interpreted. */
  notSeenThisSweep: number;
  /** Diagnostics, surfaced in the report so a bad run is visible from the phone. */
  reason: string;
  sawMarker: boolean;
  previousSeen?: number;
  newlyTracked: number;
  storeSize: number;
  /** Entries the caller must write back; applySweep itself stays pure. */
  pending: SeenEntry[];
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
  store: SeenStore,
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
    notSeenThisSweep: 0,
    reason: enumeration.reason,
    sawMarker: enumeration.sawMarker,
    newlyTracked: 0,
    storeSize: 0,
    pending: []
  };

  const pending: SeenEntry[] = [];

  for (const [url, item] of enumeration.items) {
    const { current, previous } = parsePrice(item.price);
    if (current === null) continue;

    const record = store.get(url);
    if (!record) {
      // Seen by the sweep but never matched as new. Recorded as delivered:
      // announcing a listing the watcher deliberately never alerted would turn
      // every sweep into a backlog dump.
      result.newlyTracked += 1;
      pending.push({
        url,
        seenAt: now,
        title: item.title,
        location: item.location,
        price: item.price,
        source: "facebook",
        watchName,
        delivered: true,
        priceHistory: [{ price: current, at: now }],
        lastSeenAt: now,
        missedSweeps: 0
      });
      continue;
    }

    // Seed from the price the listing was first matched at, so a sweep after
    // deployment measures against something real rather than starting blind.
    const seeded = record.priceHistory ?? [];
    if (seeded.length === 0) {
      const first = parsePrice(record.price).current;
      if (first !== null) seeded.push({ price: first, at: record.seenAt });
    }
    const last = seeded[seeded.length - 1]?.price ?? null;
    const history = [...seeded];

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

    pending.push({
      ...record,
      title: item.title || record.title,
      location: item.location ?? record.location,
      // The listed price moves with the market; `seenAt` must not, or the
      // listing looks newly matched and retention restarts.
      price: item.price ?? record.price,
      watchName: record.watchName ?? watchName,
      priceHistory: history,
      lastSeenAt: now,
      missedSweeps: 0,
      goneAt: undefined
    });
  }

  // Absence is deliberately not interpreted.
  //
  // A listing missing from a sweep might have sold, or been delisted, or had
  // its price edited out of range, or simply sat beyond where the scroll
  // stopped — and with the market larger than the result ceiling, that last
  // cause dominates. The only reliable signal was the redirect on a removed
  // listing's own page, and fetching those is the traffic pattern that gets a
  // scraper blocked. An earlier version of this guessed from absence and
  // announced 46 vehicles as sold that were all still for sale.
  store.recordSweep(watchName, result.seen);
  result.notSeenThisSweep = store
    .entries()
    .filter((r) => r.watchName === watchName && !r.goneAt)
    .filter((r) => !enumeration.items.has(canonicalUrl(r.url))).length;

  result.storeSize = store.entries().filter((r) => r.watchName === watchName).length;
  result.pending = pending;
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

  if (result.notSeenThisSweep > 0) {
    lines.push("", `👀 ${result.notSeenThisSweep} tracked listings not seen this sweep`);
  }

  lines.push("", "🔧 debug");
  lines.push(`scroll ended: ${result.reason}${result.sawMarker ? " (reached out-of-area boundary)" : ""}`);
  if (result.previousSeen !== undefined) {
    lines.push(`live vs last sweep: ${result.seen} vs ${result.previousSeen}`);
  } else {
    lines.push("live vs last sweep: no baseline yet (first run)");
  }
  lines.push(`new to price history: ${result.newlyTracked}`);
  lines.push(`price history size: ${result.storeSize}`);

  return lines.join("\n");
}
