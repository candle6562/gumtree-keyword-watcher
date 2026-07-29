#!/usr/bin/env node
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { fetchGumtreeHtml, parseGumtreeResults } from "../src/gumtree.js";
import { matchListings } from "../src/matcher.js";

// On-demand snapshot of everything currently listed for each keyword.
// Unlike run-once, this ignores the seen-listings dedupe store and sends
// nothing — it just prints, so a caller (e.g. the OpenClaw market skill)
// can relay the output directly.
async function main(): Promise<void> {
  const config = loadConfig();
  const lines: string[] = [];

  for (const keyword of config.keywords) {
    let matched;
    try {
      const html = await fetchGumtreeHtml(config.postcode, keyword, config.httpTimeoutMs);
      matched = matchListings(parseGumtreeResults(html), keyword);
    } catch (error) {
      lines.push(`${keyword}: fetch failed (${error instanceof Error ? error.message : error})`);
      continue;
    }

    if (matched.length === 0) {
      lines.push(`${keyword}: no current listings`);
      continue;
    }

    lines.push(`${keyword}: ${matched.length} listing${matched.length === 1 ? "" : "s"}`);
    for (const listing of matched) {
      const parts = [listing.title, listing.price, listing.location].filter(Boolean).join(" | ");
      lines.push(`- ${parts}`);
      lines.push(`  ${listing.url}`);
    }
  }

  console.log(lines.join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
