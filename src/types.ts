export interface Listing {
  title: string;
  url: string;
  matchedKeyword: string;
  price?: string;
  postedDate?: string;
  location?: string;
}

export interface RawListing {
  title: string;
  url: string;
  price?: string;
  postedDate?: string;
  location?: string;
}