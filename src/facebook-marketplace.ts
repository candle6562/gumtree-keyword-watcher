import type { AppConfig } from "./config.js";
import type { Listing } from "./types.js";

export function cleanFacebookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("facebook.com") && parsed.pathname.includes("/marketplace/item/")) {
      return `${parsed.origin}${parsed.pathname}`;
    }
    return url;
  } catch {
    return url;
  }
}

/** What the worker reports about how the scroll ended. */
export interface HarvestInfo {
  harvested?: number;
  steps?: number;
  settleMs?: number;
  /**
   * Whether the scroll reached Facebook's "results from outside your search"
   * heading. Passing it means every in-area listing has been rendered, which is
   * the only trustworthy signal that a sweep saw the whole local market.
   */
  sawMarker?: boolean;
  reason?: string;
}

function requiredNumberTokensMatch(term: string, title: string): boolean {
  const required = term.match(/\d+/g) ?? [];
  const present = new Set(title.match(/\d+/g) ?? []);
  return required.every((token) => present.has(token));
}

export async function searchFacebookMarketplace(
  config: Pick<AppConfig, "browserWorkerToken" | "browserWorkerUrl" | "marketplaceAreaId" | "httpTimeoutMs">,
  term: string,
  maxAgeDays?: 1 | 7 | 30,
  maxResults = 25,
  distanceKm = 20,
  price?: { min?: number; max?: number },
  knownUrls?: string[]
): Promise<Listing[]> {
  return (
    await searchFacebookMarketplaceDetailed(config, term, maxAgeDays, maxResults, distanceKm, price, knownUrls)
  ).items;
}

/**
 * As searchFacebookMarketplace, but also reports how many cards Facebook
 * returned before any local filtering.
 *
 * Callers that page by splitting a query need the raw count: Facebook caps a
 * search at maxResults and offers no "there is more" flag, so a full page is
 * the only signal that results were truncated. Reading that off the filtered
 * list hides it — a capped page of 50 that loses four to the radius filter
 * looks like an uncapped 46, and the caller stops paging while listings remain
 * unseen.
 */
export async function searchFacebookMarketplaceDetailed(
  config: Pick<AppConfig, "browserWorkerToken" | "browserWorkerUrl" | "marketplaceAreaId" | "httpTimeoutMs">,
  term: string,
  maxAgeDays?: 1 | 7 | 30,
  maxResults = 25,
  distanceKm = 20,
  price?: { min?: number; max?: number },
  /**
   * Listings the caller already has. Results come back newest-first, so once
   * the worker reaches a run of these it can stop scrolling — everything below
   * is older and already known.
   *
   * For new-listing searches only. A price sweep must never pass these: its
   * whole purpose is re-reading the price of listings we already hold, and
   * stopping at the first known one would skip every drop.
   */
  knownUrls?: string[],
  /** Scroll budget. Long for a full sweep, short for a routine new-listing check. */
  harvestTimeoutMs?: number
): Promise<{ items: Listing[]; rawCount: number; harvest: HarvestInfo }> {
  if (!config.browserWorkerToken) {
    throw new Error("BROWSER_WORKER_TOKEN not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
  try {
    const response = await fetch(`${config.browserWorkerUrl.replace(/\/$/, "")}/marketplace/search`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.browserWorkerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query: term,
        areaId: config.marketplaceAreaId || undefined,
        daysSinceListed: maxAgeDays,
        maxResults,
        radiusKm: distanceKm,
        minPrice: price?.min,
        maxPrice: price?.max,
        knownUrls: knownUrls && knownUrls.length > 0 ? knownUrls.slice(0, 500) : undefined,
        harvestTimeoutMs,
        // Facebook defaults to best_match, which ranks by relevance. A watch
        // with maxAgeDays=30 can match far more listings than maxResults, so
        // relevance ranking silently drops the newest ones — the only listings
        // a watcher actually cares about. Sorting newest-first makes the
        // harvested window the most recent N rather than an arbitrary N.
        sortBy: "creation_time_descend"
      })
    });

    if (!response.ok) {
      throw new Error(`fb-browser-worker returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();

    // Facebook answers a throttled query with a page whose result cards never
    // render, which the worker reports as a settle timeout at zero cards. Left
    // alone that is indistinguishable from a genuinely empty search: the cycle
    // records facebook_matched=0, logs success, and the listings are silently
    // lost. Treat it as a failure so the source is retried and escalated rather
    // than quietly returning nothing.
    const harvest = data.harvest as HarvestInfo | undefined;
    if (harvest && harvest.harvested === 0 && harvest.reason === "timeout") {
      throw new Error(
        "fb-browser-worker: no result cards rendered before harvest timeout (likely rate limited by Facebook)"
      );
    }

    let items = Array.isArray(data.items) ? data.items : [];
    // Captured before any filtering: this is what tells a paging caller whether
    // Facebook truncated the page.
    const rawCount = items.length;
    items = items.filter((item: { title?: string }) => requiredNumberTokensMatch(term, item.title ?? ""));

    // Age is now filtered by Facebook itself via daysSinceListed. It used to be
    // checked here by scraping every listing's detail page — one HTTP round trip
    // per item, where any failure silently dropped the listing (the catch below
    // returned null), and 20 items cost ~30s. The card carries no exact date, so
    // record the bound we asked Facebook for.
    if (maxAgeDays) {
      items = items.map((item: { postedDate?: string }) => ({
        ...item,
        postedDate: item.postedDate ?? (maxAgeDays === 1 ? "Listed in the last day" : `Listed in the last ${maxAgeDays} days`)
      }));
    }
    // No local distance filtering. Marketplace applies the radius itself via the
    // session location (see the worker's ensureRadius) and marks where it stops
    // with its own "results from outside your search" heading. Re-deriving
    // distance here from a hand-maintained gazetteer meant two different answers
    // for one listing — "Catterick Camp" was kept and "Catterick Garrison"
    // dropped, same van — so the platform is now the single authority.
    const filtered = items
      .map((item: { title?: string; price?: string; location?: string; postedDate?: string; url: string }) => ({
        source: "facebook" as const,
        matchedKeyword: term,
        title: item.title ?? term,
        price: item.price,
        location: item.location,
        postedDate: item.postedDate,
        url: cleanFacebookUrl(item.url)
      }));
    return {
      items: filtered,
      rawCount,
      harvest: harvest ?? { harvested: filtered.length, reason: "unknown", sawMarker: false }
    };
  } finally {
    clearTimeout(timer);
  }
}
