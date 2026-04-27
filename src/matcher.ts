import type { Listing, RawListing } from "./types.js";

export function matchListings(listings: RawListing[], keyword: string): Listing[] {
  const needle = keyword.toLowerCase();
  return listings
    .filter((listing) => listing.title.toLowerCase().includes(needle))
    .map((listing) => ({ ...listing, matchedKeyword: keyword }));
}
