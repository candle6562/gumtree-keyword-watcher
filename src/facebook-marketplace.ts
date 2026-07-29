import type { AppConfig } from "./config.js";
import { isNotKnownToBeOutsideRadius } from "./location-filter.js";
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
  price?: { min?: number; max?: number }
): Promise<Listing[]> {
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
        maxPrice: price?.max
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
    const harvest = data.harvest as { harvested?: number; reason?: string } | undefined;
    if (harvest && harvest.harvested === 0 && harvest.reason === "timeout") {
      throw new Error(
        "fb-browser-worker: no result cards rendered before harvest timeout (likely rate limited by Facebook)"
      );
    }

    let items = Array.isArray(data.items) ? data.items : [];
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
    return items
      .filter((item: { location?: string }) => isNotKnownToBeOutsideRadius(item.location, distanceKm))
      .map((item: { title?: string; price?: string; location?: string; postedDate?: string; url: string }) => ({
        source: "facebook" as const,
        matchedKeyword: term,
        title: item.title ?? term,
        price: item.price,
        location: item.location,
        postedDate: item.postedDate,
        url: cleanFacebookUrl(item.url)
      }));
  } finally {
    clearTimeout(timer);
  }
}
