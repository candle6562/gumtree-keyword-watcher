import { load } from "cheerio";
import type { RawListing } from "./types.js";

function toAbsoluteUrl(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }
  return `https://www.gumtree.com${href.startsWith("/") ? href : `/${href}`}`;
}

function normalizeTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface ClientDataAd {
  title: string;
  path: string;
  price?: string;
  postedDate?: string;
  location?: string;
  date?: number;
}

interface ClientData {
  resultsPage?: {
    searchAds?: ClientDataAd[];
  };
}

function parseFromClientData(html: string): RawListing[] {
  const clientDataMatch = html.match(/window\.clientData\s*=\s*"([^"]+)"/);
  if (!clientDataMatch) return [];

  try {
    const decoded = decodeURIComponent(clientDataMatch[1]);
    const data: ClientData = JSON.parse(decoded);
    const ads = data.resultsPage?.searchAds;
    if (!ads || ads.length === 0) return [];

    return ads.map((ad) => ({
      source: "gumtree" as const,
      title: normalizeTitle(ad.title),
      url: toAbsoluteUrl(ad.path),
      price: ad.price,
      postedDate: ad.postedDate,
      location: ad.location,
      date: ad.date
    })).sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  } catch {
    return [];
  }
}

function parseFromHtml(html: string): RawListing[] {
  const $ = load(html);
  const found = new Map<string, RawListing>();

  $("a[href*='/p/']").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;

    const titleFromAttr = $(element).attr("title");
    const titleFromChildren =
      $(element).find("h1, h2, h3, h4, span, div").first().text() || $(element).text();
    const title = normalizeTitle(titleFromAttr || titleFromChildren || "");
    if (!title) return;

    const url = toAbsoluteUrl(href);
    if (!found.has(url)) {
      found.set(url, { source: "gumtree", title, url });
    }
  });

  return Array.from(found.values());
}

export function parseGumtreeResults(html: string): RawListing[] {
  const fromClientData = parseFromClientData(html);
  if (fromClientData.length > 0) return fromClientData;
  return parseFromHtml(html);
}

/**
 * A real search page is tens of kilobytes and carries the results payload; the
 * WAF challenge is a few hundred bytes of loader script. Match on the WAF's own
 * fingerprints, with a size floor as a backstop for variants we have not seen.
 */
export function isBotChallenge(html: string): boolean {
  if (/window\.rbzns|kramericaindustries|px-captcha|are you a robot/i.test(html)) {
    return true;
  }
  // The parser reads either the embedded clientData payload or the rendered
  // results markup, so a page carrying neither and weighing almost nothing is
  // not a search page at all.
  const hasResultsMarkup = /window\.clientData|data-testid="search-results"|href="\/p\//.test(html);
  return html.length < 2000 && !hasResultsMarkup;
}

/**
 * `searchCategory` scopes the search. The default "for-sale" is general goods:
 * a "camper van" search there returns Barbie playsets, awnings and T-shirts, no
 * vehicles at all. Vehicle watches want "campervans-motorhomes" or
 * "cars-vans-motorbikes".
 */
export async function fetchGumtreeHtml(
  postcode: string,
  keyword: string,
  timeoutMs: number,
  distanceKm = 20,
  searchCategory = "for-sale"
): Promise<string> {
  const distanceMiles = Math.max(1, Math.round(distanceKm * 0.621371));
  const params = new URLSearchParams({
    search_location: postcode,
    q: keyword,
    search_category: searchCategory,
    distance: String(distanceMiles)
  });
  const url = `https://www.gumtree.com/search?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; gumtree-keyword-watcher/1.0)",
        accept: "text/html"
      }
    });

    if (!response.ok) {
      throw new Error(`Gumtree returned ${response.status} for ${url}`);
    }

    const html = await response.text();

    // Gumtree fronts its search with a Reblaze WAF that answers suspected bots
    // with a tiny JavaScript challenge page — served as HTTP 247, which is
    // inside the 2xx range and therefore passes `response.ok`. The parser finds
    // no listings in it and the cycle logs a cheerful `parsed=0, success`,
    // making a hard block look exactly like "nothing for sale today".
    if (isBotChallenge(html)) {
      throw new Error(
        `Gumtree served a bot challenge instead of results (status ${response.status}, ${html.length} bytes) — likely rate limited`
      );
    }

    return html;
  } finally {
    clearTimeout(timer);
  }
}