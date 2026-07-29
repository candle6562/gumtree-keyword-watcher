#!/usr/bin/env node
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { SeenStore, type SeenEntry } from "../src/store.js";
import { findWatch, loadWatches } from "../src/watches.js";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function label(entry: SeenEntry): string {
  return entry.title || entry.url.replace(/^https?:\/\//, "");
}

async function main(): Promise<void> {
  const term = process.argv.slice(2).join(" ").trim().toLowerCase();
  if (!term) throw new Error("Usage: history <term>");

  const config = loadConfig();
  const store = new SeenStore(config.dataPath, {
    retentionDays: config.dedupeRetentionDays,
    maxEntries: config.dedupeMaxEntries
  });
  await store.load();

  const watches = loadWatches();
  const exactWatch = findWatch(watches, term);
  const partialWatches = exactWatch
    ? [exactWatch]
    : watches.filter((item) => item.name.toLowerCase().includes(term) || item.terms.some((watchTerm) => watchTerm.includes(term)));
  const watch = partialWatches.length === 1 ? partialWatches[0] : exactWatch;
  const watchTerms = watch?.terms.map((item) => item.toLowerCase()) ?? [];

  const matches = store.entries()
    .filter((entry) => {
      const matchedKeyword = entry.matchedKeyword?.toLowerCase() ?? "";
      const watchName = entry.watchName?.toLowerCase() ?? "";
      const title = entry.title?.toLowerCase() ?? "";

      if (watch) {
        return watchName === watch.name.toLowerCase() || watchTerms.includes(matchedKeyword);
      }

      return matchedKeyword.includes(term) || title.includes(term);
    })
    .sort((a, b) => b.seenAt - a.seenAt)
    .slice(0, 50);

  if (matches.length === 0) {
    console.log(`No cache history for "${term}".`);
    return;
  }

  const heading = watch ? `${watch.name} (terms: ${watch.terms.join(", ")})` : term;
  const lines = [`🧾 Market cache history: ${heading} — ${matches.length} cached item${matches.length === 1 ? "" : "s"}`];
  for (const entry of matches) {
    lines.push(`- ${label(entry)}`);
    lines.push(`  Added: ${formatTime(entry.seenAt)}`);
    if (entry.watchName) lines.push(`  Watch: ${entry.watchName}`);
    if (entry.matchedKeyword) lines.push(`  Term: ${entry.matchedKeyword}`);
    if (entry.source) lines.push(`  Source: ${entry.source === "facebook" ? "Facebook" : "Gumtree"}`);
    if (entry.price) lines.push(`  Price: ${entry.price}`);
    if (entry.location) lines.push(`  Location: ${entry.location}`);
    lines.push(`  ${entry.url}`);
  }

  console.log(lines.join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
