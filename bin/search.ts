#!/usr/bin/env node
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { fetchGumtreeHtml, parseGumtreeResults } from "../src/gumtree.js";
import { isNotKnownToBeOutsideRadius } from "../src/location-filter.js";
import { matchListings } from "../src/matcher.js";

interface CombinedResult {
  source: "gumtree" | "facebook";
  title: string;
  price?: string | null;
  location?: string | null;
  postedDate?: string | null;
  url: string;
}

function sourceLabel(source: CombinedResult["source"]): string {
  return source === "facebook" ? "Facebook" : "Gumtree";
}

function cleanUrl(url: string): string {
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

function formatMeta(item: CombinedResult): string {
  return [sourceLabel(item.source), item.postedDate || "age unknown", item.location].filter(Boolean).join(" · ");
}

function checkUrl(title: string): string {
  const query = encodeURIComponent(title.replace(/\s+/g, " ").trim());
  return `https://www.ebay.co.uk/sch/i.html?_nkw=${query}`;
}

function parseSearchArgs(args: string[]): { term: string; maxAgeDays?: 1 | 7 | 30; timeQuery?: string } {
  const parts = args.join(" ").trim().split(/\s+/).filter(Boolean);
  let maxAgeDays: 1 | 7 | 30 | undefined;
  let timeQuery: string | undefined;

  const last = parts[parts.length - 1];
  const compact = last?.match(/^(\d+)\s*d(?:ays?)?$/i);
  if (compact) {
    const parsedDays = Number(compact[1]);
    if (![1, 7, 30].includes(parsedDays)) {
      throw new Error("Date filter must be 1D, 7D, or 30D");
    }
    maxAgeDays = parsedDays as 1 | 7 | 30;
    timeQuery = last.toUpperCase();
    parts.pop();
  } else if (parts.length >= 2 && /^(d|day|days)$/i.test(parts[parts.length - 1])) {
    const numberToken = parts[parts.length - 2];
    if (/^\d+$/.test(numberToken)) {
      const parsedDays = Number(numberToken);
      if (![1, 7, 30].includes(parsedDays)) {
        throw new Error("Date filter must be 1D, 7D, or 30D");
      }
      maxAgeDays = parsedDays as 1 | 7 | 30;
      timeQuery = `${numberToken}${parts[parts.length - 1].toUpperCase()}`;
      parts.pop();
      parts.pop();
    }
  }

  return { term: parts.join(" ").trim(), maxAgeDays, timeQuery };
}

function postedAgeDays(postedDate?: string | null): number | null {
  if (!postedDate) return null;
  const value = postedDate.replace(/^listed\s+/i, "").trim().toLowerCase();
  if (["just listed", "just now", "today"].includes(value)) return 0;
  if (value === "yesterday") return 1;

  const match = value.match(/^(\d+|a|an)\s+(min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months)\s+ago$/i);
  if (!match) return null;

  const amount = /^(a|an)$/i.test(match[1]) ? 1 : Number(match[1]);
  const unit = match[2].toLowerCase();
  if (/^(min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.test(unit)) return 0;
  if (/^(d|day|days)$/.test(unit)) return amount;
  if (/^(w|week|weeks)$/.test(unit)) return amount * 7;
  if (/^(mo|month|months)$/.test(unit)) return amount * 30;
  return null;
}

async function searchGumtree(postcode: string, term: string, timeoutMs: number): Promise<CombinedResult[]> {
  const html = await fetchGumtreeHtml(postcode, term, timeoutMs);
  return matchListings(parseGumtreeResults(html), term).map((listing) => ({
    source: "gumtree" as const,
    title: listing.title,
    price: listing.price,
    location: listing.location,
    postedDate: listing.postedDate,
    url: cleanUrl(listing.url)
  }));
}

async function searchFacebook(config: ReturnType<typeof loadConfig>, term: string, maxAgeDays?: 1 | 7 | 30): Promise<CombinedResult[]> {
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
        maxResults: 25
      })
    });
    if (!response.ok) {
      throw new Error(`fb-browser-worker returned ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];
    return items
      .filter((item: { location?: string }) => isNotKnownToBeOutsideRadius(item.location))
      .map((item: { title?: string; price?: string; location?: string; postedDate?: string; url: string }) => ({
        source: "facebook" as const,
        title: item.title ?? term,
        price: item.price,
        location: item.location,
        postedDate: item.postedDate,
        url: cleanUrl(item.url)
      }));
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const { term, maxAgeDays, timeQuery } = parseSearchArgs(process.argv.slice(2));
  if (!term) throw new Error("Usage: search <term> [<days>d]");

  const config = loadConfig();
  const lines: string[] = [];

  const searches: Promise<CombinedResult[]>[] = [searchGumtree(config.postcode, term, config.httpTimeoutMs)];
  if (config.marketplaceFacebookEnabled) {
    searches.push(searchFacebook(config, term, maxAgeDays));
  }
  const settled = await Promise.allSettled(searches);

  const results: CombinedResult[] = [];
  const [gumtreeResult, facebookResult] = settled;
  if (gumtreeResult.status === "fulfilled") {
    results.push(...gumtreeResult.value);
  } else {
    lines.push(`Gumtree search failed: ${gumtreeResult.reason instanceof Error ? gumtreeResult.reason.message : gumtreeResult.reason}`);
  }
  if (facebookResult) {
    if (facebookResult.status === "fulfilled") {
      results.push(...facebookResult.value);
    } else {
      lines.push(`Facebook search failed: ${facebookResult.reason instanceof Error ? facebookResult.reason.message : facebookResult.reason}`);
    }
  }

  const filteredResults = maxAgeDays === undefined
    ? results
    : results.filter((item) => {
        if (item.source === "facebook") {
          return true;
        }
        const ageDays = postedAgeDays(item.postedDate);
        return ageDays !== null && ageDays <= maxAgeDays;
      });

  if (filteredResults.length === 0) {
    const sources = config.marketplaceFacebookEnabled ? "Gumtree or Facebook Marketplace" : "Gumtree";
    const ageText = maxAgeDays === undefined ? "" : ` from the last ${maxAgeDays} day${maxAgeDays === 1 ? "" : "s"}`;
    lines.push(`No listings found for "${term}"${ageText} on ${sources}.`);
  } else {
    const gumtreeCount = filteredResults.filter((item) => item.source === "gumtree").length;
    const facebookCount = filteredResults.filter((item) => item.source === "facebook").length;
    const ageText = maxAgeDays === undefined ? "" : ` · time: ${timeQuery ?? `${maxAgeDays}D`} (last ${maxAgeDays} day${maxAgeDays === 1 ? "" : "s"})`;
    lines.push(`🔎 Market search: ${term}${ageText} — ${filteredResults.length} listings (${gumtreeCount} Gumtree, ${facebookCount} Facebook)`);
    for (const item of filteredResults) {
      lines.push(`- ${item.title}`);
      lines.push(`  💷 ${item.price || "price unknown"}`);
      lines.push(`  🧭 ${formatMeta(item)}`);
      lines.push(`  🔗 ${item.url}`);
      lines.push(`  🛒 eBay: ${checkUrl(item.title)}`);
      lines.push("");
    }
  }

  console.log(lines.join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
