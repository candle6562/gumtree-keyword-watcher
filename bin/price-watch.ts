#!/usr/bin/env node
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { WhatsappNotifier } from "../src/notifier.js";
import { applySweep, sweepMarket, formatPriceReport } from "../src/price-watch.js";
import { SeenStore } from "../src/store.js";
import type { Listing } from "../src/types.js";
import { loadWatches } from "../src/watches.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const watches = loadWatches().filter((watch) => watch.enabled && watch.terms.length > 0);
  if (watches.length === 0) {
    console.log("No enabled watches; nothing to price-check");
    return;
  }

  // One store holds both what has been alerted and every price seen for it.
  const seen = new SeenStore(config.dataPath, {
    retentionDays: config.dedupeRetentionDays,
    maxEntries: config.dedupeMaxEntries
  });
  await seen.load();

  // The sweep stays inside the watch's own price bracket. Looking wider would
  // catch a listing falling into range from above, but it multiplies the work:
  // the market is dense enough that every extra £1,000 of range costs more
  // queries, and those listings are ones we never tracked anyway. Accepting
  // that miss keeps the sweep small and quick.
  //
  // Overridable per run for a deliberate wider look.
  const floorOverride = process.env.PRICE_SWEEP_MIN;
  const ceilingOverride = process.env.PRICE_SWEEP_MAX;
  const maxResults = Number(process.env.PRICE_SWEEP_MAX_RESULTS || 1000);
  const harvestTimeoutMs = Number(process.env.PRICE_SWEEP_HARVEST_MS || 180000);

  const reports: string[] = [];
  for (const watch of watches) {
    const term = watch.terms[0];
    const tracked = seen
      .entries()
      .filter((entry) => entry.source === "facebook" && entry.watchName === watch.name)
      .map((entry) => ({
        source: "facebook" as const,
        matchedKeyword: entry.matchedKeyword ?? term,
        title: entry.title ?? "",
        price: entry.price,
        location: entry.location,
        postedDate: entry.postedDate,
        url: entry.url,
        seenAt: entry.seenAt
      })) satisfies Array<Listing & { seenAt: number }>;

    const floor = floorOverride !== undefined ? Number(floorOverride) : watch.minPrice ?? 0;
    const ceiling = ceilingOverride !== undefined ? Number(ceilingOverride) : watch.maxPrice ?? 20000;

    console.log(`\n=== ${watch.name}: enumerating £${floor}-£${ceiling} within ${watch.distanceKm}km ===`);
    const enumeration = await sweepMarket(
      config,
      term,
      watch.distanceKm,
      { min: floor, max: ceiling },
      { maxResults, harvestTimeoutMs }
    );

    const result = applySweep(seen, enumeration, tracked, watch.name);
    await seen.update(result.pending);
    reports.push(formatPriceReport(result, watch.name));
  }

  const body = reports.join("\n\n————————\n\n");

  const notifier = new WhatsappNotifier(
    config.twilioAccountSid,
    config.twilioAuthToken,
    config.whatsappFrom,
    config.whatsappTo,
    config.dryRun,
    config.whatsappAlertWebhookUrl,
    config.whatsappAlertWebhookToken,
    config.openclawGatewayToken,
    config.openclawToolUrl,
    config.httpTimeoutMs
  );

  await notifier.sendText(body);
  console.log(body);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
