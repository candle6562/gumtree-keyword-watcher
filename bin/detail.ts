#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { DetailStore, fetchFacebookDetail } from "../src/listing-detail.js";
import type { Listing } from "../src/types.js";

/**
 * Inspect one listing's full detail record. Useful for eyeballing what triage
 * will actually see before spending model calls on it.
 */
async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    throw new Error('Usage: npm run detail -- "<facebook marketplace item url>"');
  }

  const config = loadConfig();
  const store = new DetailStore(config.detailCachePath);
  await store.load();

  const cached = store.get(url);
  const detail = cached ?? (await fetchFacebookDetail(config, { url, title: "", matchedKeyword: "" } as Listing));
  if (!cached) {
    store.set(detail);
    await store.persist();
  }

  console.log(`${cached ? "[cached]" : "[fetched]"} ${detail.url}`);
  console.log(`Title:       ${detail.title}`);
  console.log(`Price:       ${detail.price ?? "-"}`);
  console.log(`Posted:      ${detail.postedDate ?? "-"}`);
  console.log(`Location:    ${detail.location ?? "-"}`);
  console.log(`Seller:      ${detail.sellerName ?? "-"}`);
  console.log(`Expanded:    ${detail.descriptionExpanded ? "yes" : "no"}`);
  const attrs = Object.entries(detail.attributes);
  console.log(`Attributes:  ${attrs.length ? attrs.map(([k, v]) => `${k}=${v}`).join(", ") : "-"}`);
  console.log(`Images:      ${detail.images.length}`);
  detail.images.forEach((image, index) => console.log(`  ${index + 1}. ${image.split("?")[0]}`));
  console.log(`\nDescription:\n${detail.description ?? "(none)"}`);
  console.log(`\nCache: ${store.count()} listing(s) at ${config.detailCachePath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
