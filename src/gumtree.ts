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
      found.set(url, { title, url });
    }
  });

  return Array.from(found.values());
}

export function parseGumtreeResults(html: string): RawListing[] {
  const fromClientData = parseFromClientData(html);
  if (fromClientData.length > 0) return fromClientData;
  return parseFromHtml(html);
}

export async function fetchGumtreeHtml(postcode: string, keyword: string, timeoutMs: number): Promise<string> {
  const params = new URLSearchParams({
    search_location: postcode,
    q: keyword,
    search_category: "for-sale"
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

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}