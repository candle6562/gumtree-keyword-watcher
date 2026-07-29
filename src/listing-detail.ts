import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AppConfig } from "./config.js";
import type { Listing } from "./types.js";

/**
 * A listing plus everything that only exists on its own page.
 *
 * Search results carry title, price and town — nothing you could actually judge
 * a vehicle on. Mileage, seat count, service history, whether the air
 * conditioning works and whether there is a pop-top all live in the seller's
 * free-text description and the photos, so triage is impossible without this.
 */
export interface ListingDetail extends Listing {
  description?: string;
  images: string[];
  attributes: Record<string, string>;
  sellerName?: string;
  descriptionExpanded?: boolean;
  fetchedAt: string;
}

interface PersistedDetails {
  version: 1;
  details: Record<string, ListingDetail>;
}

export type DetailConfig = Pick<
  AppConfig,
  | "browserWorkerUrl"
  | "browserWorkerToken"
  | "httpTimeoutMs"
  | "detailFetchEnabled"
  | "detailMaxPerCycle"
  | "detailDelayMs"
  | "detailCachePath"
>;

/**
 * Detail pages are immutable enough to cache forever: a listing's description
 * and photos do not change, and re-fetching costs both a browser round trip and
 * anti-bot risk against Facebook.
 */
export class DetailStore {
  private details = new Map<string, ListingDetail>();
  private dirty = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<PersistedDetails>;
      if (parsed.version === 1 && parsed.details) {
        this.details = new Map(Object.entries(parsed.details));
      }
    } catch {
      // A missing or corrupt cache only costs re-fetching; never fail a cycle.
      this.details = new Map();
    }
  }

  get(url: string): ListingDetail | undefined {
    return this.details.get(url);
  }

  has(url: string): boolean {
    return this.details.has(url);
  }

  set(detail: ListingDetail): void {
    this.details.set(detail.url, detail);
    this.dirty = true;
  }

  count(): number {
    return this.details.size;
  }

  async persist(): Promise<void> {
    if (!this.dirty) return;
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const payload: PersistedDetails = {
      version: 1,
      details: Object.fromEntries(this.details)
    };
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchFacebookDetail(
  config: DetailConfig,
  listing: Listing
): Promise<ListingDetail> {
  const response = await fetch(`${config.browserWorkerUrl.replace(/\/$/, "")}/marketplace/detail`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.browserWorkerToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ url: listing.url }),
    // Detail pages expand a description and wait on lazy images, so they need
    // more headroom than a plain search call.
    signal: AbortSignal.timeout(Math.max(config.httpTimeoutMs, 60000))
  });

  if (!response.ok) {
    throw new Error(`fb-browser-worker detail returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return {
    ...listing,
    // Prefer the detail page's own values: the search card truncates the title
    // and gives only a town, while the detail page states the exact posting age.
    title: data.title || listing.title,
    price: data.price || listing.price,
    postedDate: data.postedDate || listing.postedDate,
    location: data.location || listing.location,
    description: data.description ?? undefined,
    images: Array.isArray(data.images) ? data.images : [],
    attributes: data.attributes && typeof data.attributes === "object" ? data.attributes : {},
    sellerName: data.sellerName ?? undefined,
    descriptionExpanded: Boolean(data.descriptionExpanded),
    fetchedAt: new Date().toISOString()
  };
}

export interface EnrichResult {
  details: ListingDetail[];
  fetched: number;
  cached: number;
  skipped: number;
  failed: number;
}

/**
 * Fetch detail pages for listings that do not have one cached.
 *
 * Deliberately serial with a delay: detail fetching multiplies browser-worker
 * load by the number of matches, and hammering Facebook risks the rate limiting
 * that already returns empty result pages. The per-cycle budget means a large
 * backlog drains over several cycles rather than in one burst.
 */
export async function enrichListings(
  config: DetailConfig,
  store: DetailStore,
  listings: Listing[]
): Promise<EnrichResult> {
  const result: EnrichResult = { details: [], fetched: 0, cached: 0, skipped: 0, failed: 0 };
  if (!config.detailFetchEnabled) {
    result.skipped = listings.length;
    return result;
  }

  for (const listing of listings) {
    const cached = store.get(listing.url);
    if (cached) {
      result.details.push(cached);
      result.cached += 1;
      continue;
    }

    if (result.fetched >= config.detailMaxPerCycle) {
      result.skipped += 1;
      continue;
    }

    if (listing.source !== "facebook") {
      // Only Facebook has a detail extractor so far; Gumtree and AutoTrader
      // pages have a different shape and are not wired up yet.
      result.skipped += 1;
      continue;
    }

    try {
      if (result.fetched > 0) await sleep(config.detailDelayMs);
      const detail = await fetchFacebookDetail(config, listing);
      store.set(detail);
      result.details.push(detail);
      result.fetched += 1;
    } catch (error) {
      // One unreachable listing must not sink the cycle; it retries next time.
      console.error(
        `Detail fetch failed for ${listing.url}: ${error instanceof Error ? error.message : String(error)}`
      );
      result.failed += 1;
    }
  }

  await store.persist();
  return result;
}
