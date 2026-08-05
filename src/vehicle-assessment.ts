import type { AppConfig } from "./config.js";
import type { ListingDetail } from "./listing-detail.js";
import type { AlertListing, MileageRating } from "./notifier.js";
import type { SeenEntry } from "./store.js";
import { triageListing, type MarketContext } from "./triage/index.js";
import { loadSpec, parsePricePounds } from "./triage/spec.js";
import type { MarketWatch } from "./watches.js";

/**
 * Extra assessment for vehicle watches: mileage, air conditioning, whether the
 * conversion is already done, and what the asking price looks like against
 * comparable vehicles.
 *
 * Gated on `watch.type === "vehicle"` because it costs a model call per listing
 * and means nothing for a search like a Garmin watch.
 */

/**
 * Mileage as the seller declared it, from Facebook's own vehicle fields.
 *
 * Facebook states this in kilometres and the worker converts it, so it is a
 * fact rather than an inference. Always prefer it over the model reading a
 * number out of the description: the same advert produced 204,000 from prose
 * where the declared figure was quite different, and a wrong mileage is worse
 * than none.
 */
function declaredMileage(attributes?: Record<string, string>): number | null {
  const raw = attributes?.Mileage;
  if (!raw) return null;
  const match = raw.replace(/,/g, "").match(/(\d+)/);
  if (!match) return null;
  const miles = Number(match[1]);
  return Number.isFinite(miles) && miles > 0 ? miles : null;
}

/**
 * Rate a mileage against the range the specification calls ideal.
 *
 * Anchored on the spec rather than fixed thresholds so the marker always agrees
 * with what the buyer actually wrote. This search calls 70k-120k ideal, so a
 * van at 100k is not a warning; a blanket "amber over 50k" would have flagged
 * most of the preferred range.
 */
export function rateMileage(miles: number, ideal?: [number, number]): MileageRating {
  const [, idealMax] = ideal ?? [70_000, 120_000];
  if (miles <= idealMax) return "great";
  if (miles <= idealMax * 1.25) return "good";
  if (miles <= idealMax * 1.6) return "ok";
  return "bad";
}

/** Slug a watch name into the spec filename triage expects. */
function specNameFor(watch: MarketWatch): string {
  return watch.name.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Summarise what comparable vehicles are asking, from listings already seen for
 * this watch.
 *
 * Quartiles rather than a mean: a handful of £40,000 motorhomes in a £10,000
 * search would drag an average somewhere no real listing sits.
 */
export function buildMarketContext(entries: SeenEntry[], watchName: string): MarketContext | undefined {
  const prices = entries
    .filter((entry) => entry.watchName === watchName)
    .map((entry) => ({ title: entry.title ?? "", price: parsePricePounds(entry.price) }))
    .filter((row): row is { title: string; price: number } => typeof row.price === "number" && row.price > 0)
    .sort((a, b) => a.price - b.price);

  // Too thin a sample says more about our coverage than about the market.
  if (prices.length < 8) return undefined;

  const at = (fraction: number) => prices[Math.min(prices.length - 1, Math.floor(prices.length * fraction))].price;

  // Spread the comparables across the range rather than taking the cheapest
  // few, which would make everything look expensive.
  const step = Math.max(1, Math.floor(prices.length / 8));
  const comparables = prices.filter((_, i) => i % step === 0).slice(0, 8);

  return {
    sampleSize: prices.length,
    lowerQuartile: at(0.25),
    medianPrice: at(0.5),
    upperQuartile: at(0.75),
    comparables
  };
}

export interface AssessmentOutcome {
  assessed: number;
  failed: number;
}

/**
 * Attach vehicle assessment to the listings about to be alerted.
 *
 * Failure is always soft: a listing whose assessment errors, or which has no
 * detail to assess, goes out exactly as it would have before. The assessment is
 * a nice-to-have on top of an alert whose job is to be timely.
 */
export async function assessVehicles(
  config: AppConfig,
  watch: MarketWatch,
  listings: AlertListing[],
  details: Map<string, ListingDetail>,
  market: MarketContext | undefined
): Promise<{ listings: AlertListing[]; outcome: AssessmentOutcome }> {
  const outcome: AssessmentOutcome = { assessed: 0, failed: 0 };
  if (watch.type !== "vehicle" || !config.openrouterApiKey) return { listings, outcome };

  let spec;
  try {
    spec = await loadSpec(specNameFor(watch));
  } catch {
    // No written specification for this watch: the value judgement still works,
    // the specification-matching part simply has nothing to match against.
    return { listings, outcome };
  }

  const assessed = await Promise.all(
    listings.map(async (listing) => {
      const detail = details.get(listing.url);
      if (!detail) return listing;
      try {
        const result = await triageListing(
          {
            apiKey: config.openrouterApiKey as string,
            textModel: config.openrouterTextModel,
            visionModel: config.openrouterVisionModel,
            timeoutMs: config.openrouterTimeoutMs
          },
          spec,
          detail,
          market
        );
        outcome.assessed += 1;
        const miles = declaredMileage(detail.attributes) ?? result.extracted.mileage ?? null;
        return {
          ...listing,
          vehicle: {
            mileage: miles,
            mileageRating: miles === null ? null : rateMileage(miles, spec.softFlags.mileage_ideal),
            aircon: result.extracted.aircon ?? null,
            converted: result.extracted.converted ?? null,
            valueForMoney: result.valueForMoney
          }
        } satisfies AlertListing;
      } catch (error) {
        outcome.failed += 1;
        console.error(
          `Vehicle assessment failed for ${listing.url}: ${error instanceof Error ? error.message : String(error)}`
        );
        return listing;
      }
    })
  );

  return { listings: assessed, outcome };
}
