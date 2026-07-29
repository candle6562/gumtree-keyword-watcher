#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { searchFacebookMarketplace } from "../src/facebook-marketplace.js";
import { DetailStore, enrichListings } from "../src/listing-detail.js";
import { extractPlate, triageListing, type TriageResult } from "../src/triage/index.js";
import { TriageCache } from "../src/triage/cache.js";
import { formatTriageMessage } from "../src/triage/message.js";
import type { OpenRouterConfig } from "../src/triage/openrouter.js";
import { loadSpec } from "../src/triage/spec.js";
import { findWatch, loadWatches } from "../src/watches.js";

function arg(name: string, fallback?: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
}

/**
 * End-to-end triage: search, fetch details, score against a spec, print the
 * WhatsApp message that would be sent.
 *
 * Every stage is cached, so a second run costs nothing and returns the same
 * verdicts. `--cached` goes further and skips the search entirely, working only
 * from listings already on disk — which is what makes iterating on the message
 * format or a triage bug practical without re-scraping or re-billing.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const watchName = arg("watch", "camper van")!;
  const specName = arg("spec", "camper-van")!;
  const limit = Number(arg("limit", "50"));
  const cachedOnly = process.argv.includes("--cached");
  const withVision = process.argv.includes("--vision") || config.triageVisionEnabled;

  if (!config.openrouterApiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const watch = findWatch(loadWatches(), watchName);
  if (!watch) throw new Error(`Watch not found: ${watchName}`);

  const spec = await loadSpec(specName, config.triageSpecDir);
  const specHash = TriageCache.hashSpec(spec.prose);

  const llm: OpenRouterConfig = {
    apiKey: config.openrouterApiKey,
    textModel: config.openrouterTextModel,
    visionModel: config.openrouterVisionModel,
    timeoutMs: config.openrouterTimeoutMs
  };

  const detailStore = new DetailStore(config.detailCachePath);
  const triageCache = new TriageCache(config.triageCachePath);
  await Promise.all([detailStore.load(), triageCache.load()]);

  console.log(
    `watch="${watch.name}" spec=${spec.name} radius=${watch.distanceKm}km ` +
      `price=£${watch.minPrice ?? 0}-${watch.maxPrice ?? "∞"} age=${watch.maxAgeDays ?? 1}d`
  );
  console.log(`text=${llm.textModel} vision=${withVision ? llm.visionModel : "disabled"} cachedOnly=${cachedOnly}`);
  console.log(`caches: ${detailStore.count()} details, ${triageCache.count()} triage results\n`);

  let listings = [];
  if (cachedOnly) {
    listings = [];
    console.log("(--cached: skipping search, triaging listings already in the detail cache)");
  } else {
    listings = await searchFacebookMarketplace(
      config,
      watch.terms[0],
      watch.maxAgeDays ?? 1,
      limit,
      watch.distanceKm,
      { min: watch.minPrice, max: watch.maxPrice }
    );
    console.log(`search returned ${listings.length} listing(s)`);
  }

  const enriched = cachedOnly
    ? []
    : await enrichListings({ ...config, detailFetchEnabled: true, detailMaxPerCycle: limit }, detailStore, listings);
  const details = cachedOnly
    ? // Work from whatever is already on disk.
      listings.map((l) => detailStore.get(l.url)).filter(Boolean)
    : enriched.details;

  if (!cachedOnly) {
    console.log(
      `details: ${enriched.fetched} fetched, ${enriched.cached} cached, ` +
        `${enriched.failed} failed, ${enriched.skipped} skipped\n`
    );
  }

  const results: TriageResult[] = [];
  let spend = 0;
  let fromCache = 0;

  for (const detail of details) {
    if (!detail) continue;
    const cached = triageCache.get(detail.url, specHash, llm.textModel);
    if (cached) {
      results.push(cached);
      fromCache += 1;
      continue;
    }

    try {
      const result = await triageListing(llm, spec, detail);
      spend += result.usage?.costUsd ?? 0;

      if (withVision && !result.gatedLocally && result.score >= config.triageVisionMinScore && !result.registration) {
        const plate = await extractPlate(llm, detail.images);
        spend += plate.usage?.costUsd ?? 0;
        if (plate.registration) result.registration = plate.registration;
      }

      triageCache.set(result, specHash, llm.textModel);
      await triageCache.persist();
      results.push(result);
      process.stdout.write(".");
    } catch (error) {
      // One bad advert must not lose the other forty-nine.
      console.error(`\ntriage failed for ${detail.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n\ntriaged ${results.length} (${fromCache} from cache) · spend $${spend.toFixed(5)}\n`);
  console.log("═══════════ WhatsApp message ═══════════");
  console.log(formatTriageMessage(results, { watchName: watch.name, schedule: "*/10 * * * * (every 10 mins)" }));
  console.log("════════════════════════════════════════");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
