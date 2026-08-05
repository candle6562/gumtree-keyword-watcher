#!/usr/bin/env node
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { searchFacebookMarketplace } from "../src/facebook-marketplace.js";
import { fetchGumtreeHtml, parseGumtreeResults } from "../src/gumtree.js";
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

/** Per-watch tally of what each stage of the funnel threw away. */
type ScanStats = {
  gumtreeScanned: number;
  droppedKeyword: number;
  droppedAge: number;
  facebookReturned: number;
};

function emptyStats(): ScanStats {
  return { gumtreeScanned: 0, droppedKeyword: 0, droppedAge: 0, facebookReturned: 0 };
}

async function searchGumtree24h(
  config: ReturnType<typeof loadConfig>,
  term: string,
  distanceKm: number,
  stats: ScanStats
): Promise<Listing[]> {
  const html = await fetchGumtreeHtml(config.postcode, term, config.httpTimeoutMs, distanceKm);

  const parsed = parseGumtreeResults(html);
  stats.gumtreeScanned += parsed.length;

  const matched = matchListings(parsed, term);
  stats.droppedKeyword += parsed.length - matched.length;

  const recent = matched.filter((item) => {
    const age = postedAgeDays(item.postedDate);
    return age !== null && age <= 1;
  });
  stats.droppedAge += matched.length - recent.length;

  return recent;
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

  // A target with no enabled watches has nothing to report. Sending anyway
  // delivers a header and nothing else, which is what this digest did daily
  // for the `tom-direct` target while its watches file sat empty.
  if (watches.length === 0) {
    console.log(`No enabled watches for target ${process.env.MARKET_WATCH_TARGET_ID ?? "(unset)"}; skipping digest`);
    return;
  }

  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const lines: string[] = ["📊 Daily market summary — last 24h", "08:00 daily digest", ""];

  for (const watch of watches) {
    const byUrl = new Map<string, Listing>();
    const stats = emptyStats();
    for (const term of watch.terms) {
      try {
        for (const item of await searchGumtree24h(config, term, watch.distanceKm, stats)) byUrl.set(item.url, item);
        if (config.marketplaceFacebookEnabled) {
          const fbItems = await searchFacebookMarketplace(config, term, 1, 20, watch.distanceKm);
          stats.facebookReturned += fbItems.length;
          for (const item of fbItems) byUrl.set(item.url, item);
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
    const ignored = stats.droppedKeyword + stats.droppedAge;
    lines.push(`Watch: ${watch.name}`);
    lines.push(`Terms: ${watch.terms.join(", ")}`);
    lines.push(`Distance: ${watch.distanceKm} km`);
    lines.push(`Scanned: ${stats.gumtreeScanned} Gumtree${stats.facebookReturned > 0 ? ` + ${stats.facebookReturned} Facebook` : ""}`);
    lines.push(`Ignored: ${ignored} (keyword ${stats.droppedKeyword}, over 24h ${stats.droppedAge})`);
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
