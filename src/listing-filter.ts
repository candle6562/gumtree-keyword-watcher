import type { Listing } from "./types.js";
import type { MarketWatch } from "./watches.js";

export function parsePricePounds(price?: string): number | null {
  if (!price) return null;
  const match = price.replace(/,/g, "").match(/£\s*(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

export function filterByWatchRules(
  watch: Pick<MarketWatch, "minPrice" | "maxPrice">,
  listings: Listing[]
): Listing[] {
  return listings.filter((listing) => {
    if (watch.minPrice === undefined && watch.maxPrice === undefined) return true;

    const price = parsePricePounds(listing.price);
    // An unpriced listing cannot be shown to satisfy a price bound, and for a
    // vehicle search "POA" is usually a trade advert rather than a private sale.
    if (price === null) return false;
    if (watch.minPrice !== undefined && price < watch.minPrice) return false;
    if (watch.maxPrice !== undefined && price > watch.maxPrice) return false;
    return true;
  });
}
