#!/usr/bin/env node
import "dotenv/config";
import { readFile, writeFile, copyFile } from "node:fs/promises";

/**
 * Fold the standalone price history into the seen-store.
 *
 * The two stores held overlapping records for the same listings and disagreed:
 * the seen-store froze `price` at first sight while the sweep tracked the real
 * one, so alerts could quote a price the listing no longer asked. Merging makes
 * one record per listing the single source of truth.
 *
 * Run with --apply to write; without it, reports what it would do.
 */

interface Observation {
  price: number;
  at: number;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const seenPath = process.env.DATA_PATH || ".data/seen-listings.group-unity.json";
  const pricePath = process.env.PRICE_HISTORY_PATH || ".data/price-history.json";

  const seen = JSON.parse(await readFile(seenPath, "utf8"));
  const prices = JSON.parse(await readFile(pricePath, "utf8").catch(() => '{"items":{}}'));
  const canonical = (url: string) => url.split("?")[0];

  const byUrl = new Map<string, any>();
  for (const entry of seen.entries) byUrl.set(canonical(entry.url), entry);

  let merged = 0;
  let adopted = 0;

  for (const [rawUrl, record] of Object.entries<any>(prices.items ?? {})) {
    const url = canonical(rawUrl);
    const history: Observation[] = Array.isArray(record.history) ? record.history : [];
    const existing = byUrl.get(url);

    if (existing) {
      existing.priceHistory = history;
      existing.lastSeenAt = record.lastSeenAt ?? existing.seenAt;
      existing.missedSweeps = record.missedSweeps ?? 0;
      if (record.goneAt) existing.goneAt = record.goneAt;
      // The sweep's latest observation is the current asking price; the
      // seen-store's frozen one is what caused the two to disagree.
      const latest = history[history.length - 1]?.price;
      if (typeof latest === "number") existing.price = `£${latest.toLocaleString("en-GB")}`;
      merged += 1;
      continue;
    }

    // Price-only records were never alerted and must not become a backlog dump
    // the moment the watcher next runs.
    byUrl.set(url, {
      url,
      seenAt: record.lastSeenAt ?? history[0]?.at ?? Date.now(),
      title: record.title,
      watchName: record.watchName,
      source: "facebook",
      price: history.length ? `£${history[history.length - 1].price.toLocaleString("en-GB")}` : undefined,
      location: record.location,
      delivered: true,
      priceHistory: history,
      lastSeenAt: record.lastSeenAt,
      missedSweeps: record.missedSweeps ?? 0,
      ...(record.goneAt ? { goneAt: record.goneAt } : {})
    });
    adopted += 1;
  }

  const entries = Array.from(byUrl.values());
  const undelivered = entries.filter((e) => e.delivered === false).length;

  console.log(`seen-store entries before : ${seen.entries.length}`);
  console.log(`price-history records     : ${Object.keys(prices.items ?? {}).length}`);
  console.log(`  merged into existing    : ${merged}`);
  console.log(`  adopted as delivered    : ${adopted}`);
  console.log(`combined entries          : ${entries.length}`);
  console.log(`still awaiting delivery   : ${undelivered}   <- these WILL be alerted`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }

  await copyFile(seenPath, `${seenPath}.pre-merge-${Date.now()}`);
  await writeFile(
    seenPath,
    JSON.stringify({ version: 2, entries, sweeps: prices.sweeps ?? {} }, null, 2),
    "utf8"
  );
  console.log(`\nWritten. Previous seen-store copied alongside as .pre-merge-*`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
