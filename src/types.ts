export type ListingSource = "gumtree" | "facebook";

export interface Listing {
  title: string;
  url: string;
  matchedKeyword: string;
  source?: ListingSource;
  price?: string;
  postedDate?: string;
  location?: string;
}

export interface RawListing {
  title: string;
  url: string;
  source?: ListingSource;
  price?: string;
  postedDate?: string;
  location?: string;
}
