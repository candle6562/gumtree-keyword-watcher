#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { DetailStore, fetchFacebookDetail } from "../src/listing-detail.js";
import { extractPlate, triageListing, type TriageResult } from "../src/triage/index.js";
import type { OpenRouterConfig } from "../src/triage/openrouter.js";
import { loadSpec } from "../src/triage/spec.js";
import type { Listing } from "../src/types.js";

function verdictIcon(verdict: string): string {
  return verdict === "shortlist" ? "✅" : verdict === "maybe" ? "🟡" : "❌";
}

function bullets(label: string, items: string[]): void {
  if (items.length === 0) return;
  console.log(`  ${label}`);
  for (const item of items) console.log(`    - ${item}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const specName = args.find((a) => a.startsWith("--spec="))?.split("=")[1] ?? "camper-van";
  const withVision = args.includes("--vision");
  const urls = args.filter((a) => a.startsWith("http"));

  if (urls.length === 0) {
    throw new Error('Usage: npm run triage -- [--spec=camper-van] [--vision] "<listing url>" ...');
  }

  const config = loadConfig();
  if (!config.openrouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const llm: OpenRouterConfig = {
    apiKey: config.openrouterApiKey,
    textModel: config.openrouterTextModel,
    visionModel: config.openrouterVisionModel,
    timeoutMs: config.openrouterTimeoutMs
  };

  const spec = await loadSpec(specName, config.triageSpecDir);
  const store = new DetailStore(config.detailCachePath);
  await store.load();

  console.log(`Spec: ${spec.name} | text: ${llm.textModel} | vision: ${llm.visionModel}\n`);

  const results: TriageResult[] = [];
  let spend = 0;

  for (const url of urls) {
    let detail = store.get(url);
    if (!detail) {
      detail = await fetchFacebookDetail(config, { url, title: "", matchedKeyword: "" } as Listing);
      store.set(detail);
      await store.persist();
    }

    const result = await triageListing(llm, spec, detail);
    spend += result.usage?.costUsd ?? 0;

    // Vision is the expensive step, so it only runs on listings worth chasing.
    if (withVision && !result.gatedLocally && result.score >= config.triageVisionMinScore && !result.registration) {
      const plate = await extractPlate(llm, detail.images);
      spend += plate.usage?.costUsd ?? 0;
      if (plate.registration) {
        result.registration = plate.registration;
        console.log(`  (plate read from photos: ${plate.registration}, confidence ${plate.confidence})`);
      }
    }
    results.push(result);
  }

  results.sort((a, b) => b.score - a.score);

  for (const r of results) {
    console.log(`${verdictIcon(r.verdict)} ${r.score}/100  ${r.title}`);
    console.log(`  ${r.price ?? "?"} · ${r.location ?? "?"} · ${r.url}`);
    if (r.gatedLocally) {
      console.log(`  rejected without a model call: ${r.hardRejects.join("; ")}`);
      console.log();
      continue;
    }
    const e = r.extracted;
    const facts = [
      e.year && `year ${e.year}`,
      e.mileage && `${e.mileage.toLocaleString()} miles`,
      e.fuel,
      e.euroStatus,
      e.seats && `${e.seats} seats`,
      e.popTop === true && "pop-top",
      r.registration && `reg ${r.registration}`
    ].filter(Boolean);
    if (facts.length) console.log(`  ${facts.join(" · ")}`);
    bullets("matches:", r.matched);
    bullets("concerns:", r.concerns);
    bullets("hard rejects:", r.hardRejects);
    bullets("unknowns (ask the seller):", r.unknowns);
    console.log();
  }

  const shortlist = results.filter((r) => r.verdict === "shortlist").length;
  console.log(`${results.length} listing(s): ${shortlist} shortlist, ` +
    `${results.filter((r) => r.verdict === "maybe").length} maybe, ` +
    `${results.filter((r) => r.verdict === "reject").length} reject`);
  console.log(`OpenRouter spend this run: $${spend.toFixed(5)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
