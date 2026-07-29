#!/usr/bin/env node
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { searchFacebookMarketplace } from "../src/facebook-marketplace.js";
import { fetchGumtreeHtml, parseGumtreeResults } from "../src/gumtree.js";
import { isWithinNorthShieldsRadius } from "../src/location-filter.js";
import { filterByWatchRules } from "../src/listing-filter.js";
import { matchListings } from "../src/matcher.js";
import { WhatsappNotifier } from "../src/notifier.js";
import { SeenStore } from "../src/store.js";
import type { Listing } from "../src/types.js";
import { loadWatches } from "../src/watches.js";

function postedAgeDays(postedDate?: string): number | null {
  if (!postedDate) return null;
  const value = postedDate.replace(/^listed\s+/i, "").trim().toLowerCase();
  if (["just listed", "just now", "today"].includes(value)) return 0;
  if (value === "yesterday") return 1;
  const match = value.match(/^(\d+|a|an)\s+(min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months)\s+ago$/i);
  if (!match) return null;
  const amount = /^(a|an)$/i.test(match[1]) ? 1 : Number(match[1]);
  const unit = match[2].toLowerCase();
  if (/^(min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.test(unit)) return 0;
  if (/^(d|day|days)$/.test(unit)) return amount;
  if (/^(w|week|weeks)$/.test(unit)) return amount * 7;
  if (/^(mo|month|months)$/.test(unit)) return amount * 30;
  return null;
}

async function searchGumtree24h(config: ReturnType<typeof loadConfig>, term: string, distanceKm: number): Promise<Listing[]> {
  const html = await fetchGumtreeHtml(config.postcode, term, config.httpTimeoutMs, distanceKm);
  return matchListings(parseGumtreeResults(html), term).filter((item) => isWithinNorthShieldsRadius(item.location, distanceKm)).filter((item) => {
    const age = postedAgeDays(item.postedDate);
    return age !== null && age <= 1;
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const watches = loadWatches().filter((watch) => watch.enabled && watch.terms.length > 0);
  const store = new SeenStore(config.dataPath, {
    retentionDays: config.dedupeRetentionDays,
    maxEntries: config.dedupeMaxEntries
  });
  await store.load();

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

  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const lines: string[] = ["📊 Daily market summary — last 24h", "08:00 daily digest", ""];

  for (const watch of watches) {
    const byUrl = new Map<string, Listing>();
    for (const term of watch.terms) {
      try {
        for (const item of await searchGumtree24h(config, term, watch.distanceKm)) byUrl.set(item.url, item);
        if (config.marketplaceFacebookEnabled) {
          for (const item of await searchFacebookMarketplace(config, term, 1, 20, watch.distanceKm)) byUrl.set(item.url, item);
        }
      } catch (error) {
        lines.push(`⚠️ ${watch.name}: ${term} failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    const rawItems = Array.from(byUrl.values());
    const items = filterByWatchRules(watch, rawItems);
    const ruleFiltered = rawItems.length - items.length;
    const cachedHits = items.filter((item) => store.has(item.url)).length;
    const fresh = items.length - cachedHits;
    const watchCacheEntries = store.entries().filter((entry) => entry.watchName === watch.name);
    const watchCacheAdded24h = watchCacheEntries.filter((entry) => entry.seenAt >= sinceMs).length;
    lines.push(`Watch: ${watch.name}`);
    lines.push(`Terms: ${watch.terms.join(", ")}`);
    lines.push(`Distance: ${watch.distanceKm} km`);
    lines.push(`Found live last 24h: ${items.length}`);
    if (ruleFiltered > 0) lines.push(`Filtered by rules: ${ruleFiltered}`);
    lines.push(`New right now: ${fresh}`);
    lines.push(`Already seen in live results: ${cachedHits}`);
    lines.push(`Cache for watch: total ${watchCacheEntries.length}, added last 24h ${watchCacheAdded24h}`);
    lines.push(`Cache for chat: total ${store.count()}, added last 24h ${store.countSince(sinceMs)}`);
    lines.push("");
  }

  await notifier.sendText(lines.join("\n").trim());
  console.log(lines.join("\n").trim());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
