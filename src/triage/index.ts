import type { ListingDetail } from "../listing-detail.js";
import { complete, type OpenRouterConfig, type Usage } from "./openrouter.js";
import { applyHardGates, type Spec } from "./spec.js";

export type Verdict = "shortlist" | "maybe" | "reject";

export interface TriageResult {
  url: string;
  title: string;
  price?: string;
  location?: string;
  score: number;
  verdict: Verdict;
  matched: string[];
  concerns: string[];
  hardRejects: string[];
  /** Spec points the listing says nothing about — the seller question list. */
  unknowns: string[];
  registration?: string;
  extracted: {
    year?: number;
    mileage?: number;
    fuel?: string;
    euroStatus?: string;
    seats?: number;
    model?: string;
    popTop?: boolean;
    /** Null, not false, when the advert simply does not say. */
    aircon?: boolean | null;
    /** Already a camper conversion, as opposed to an empty panel van. */
    converted?: boolean | null;
    /**
     * Typical real-world combined MPG for this model and engine.
     *
     * Adverts effectively never state economy, so unlike every other field here
     * this is the model's own knowledge of the vehicle rather than something
     * read off the page. Treated as an estimate throughout and shown as one.
     */
    mpg?: number | null;
  };
  /** How the asking price compares to similar vehicles, 1-10. */
  valueForMoney?: { score: number; reason: string };
  gatedLocally: boolean;
  usage?: Usage;
}

/**
 * Bump when the prompt changes: cached verdicts from an older prompt are
 * answers to a different question.
 */
export const PROMPT_VERSION = "v4";

const SYSTEM_PROMPT = `You assess second-hand vehicle adverts against a buyer's written specification.

THE MOST IMPORTANT RULE: an advert that does not mention something has not
failed it. Sellers omit almost everything — emissions standard, air
conditioning, seat count, service history. Silence is an unknown, never a
reject, and never a concern.

Put anything the advert does not state into "unknowns". Only put something in
"hardRejects" when the advert positively establishes it, either because the
seller says so or because it follows inescapably from a stated fact (a stated
price above the budget, a stated year below a stated minimum).

Worked example, because this is where assessments usually go wrong:
  Spec: "Diesel must be confirmed Euro 6." Advert says nothing about emissions.
  WRONG: hardReject "diesel not confirmed Euro 6"
  RIGHT: unknown "Euro emissions standard not stated - ask the seller"
The buyer resolves unknowns by asking the seller or checking DVLA. Rejecting on
silence throws away every viable vehicle.

Distinguish requirements by their wording. "Must", "essential" and "reject" are
hard. "Preferably", "ideally" and "strong preference" are soft: falling short
lowers the score and belongs in "concerns", never in "hardRejects".

Scoring, 0-100. Judge on what is known, and do not punish a listing merely for
being brief:
  85-100 shortlist  nothing known to fail; most stated facts fit well
  60-84  maybe      plausible, with gaps or soft-requirement shortfalls
  0-59   reject     positively fails something the spec calls essential

Reply with JSON only:
{
  "score": number,
  "verdict": "shortlist" | "maybe" | "reject",
  "matched": [string],      // spec points the advert positively satisfies
  "concerns": [string],     // stated facts that fall short, incl. soft misses
  "hardRejects": [string],  // essentials the advert positively fails - usually empty
  "unknowns": [string],     // spec points the advert is silent on
  "registration": string | null,  // only if the advert states it
  "extracted": {
    "year": number | null, "mileage": number | null, "fuel": string | null,
    "euroStatus": string | null, "seats": number | null, "model": string | null,
    "popTop": boolean | null, "aircon": boolean | null, "converted": boolean | null,
    "mpg": number | null
  },
  "valueForMoney": { "score": number, "reason": string }
}

Four fields need care.

"aircon" and "converted" follow the silence rule above: true when the advert
says so, false only when it positively says otherwise ("no air con", "empty
panel van, ready to convert"), and null when it simply does not say — which is
most of the time. Do not infer air conditioning from a vehicle being modern, or
a conversion from the word "camper" in a title that is otherwise about a van
shell.

"converted" means the vehicle already has a camper interior — bed, units,
somewhere to cook. A day van with seats and windows is not converted. A van
described as "ideal for conversion" is explicitly not converted.

"mpg" is the exception to the silence rule. Adverts do not state fuel economy,
so estimate typical real-world combined MPG from the model, engine size and
year — what an owner actually sees, not the manufacturer's figure. A 2.0 diesel
Transit Custom is around 38; a 2.5 petrol T4 is around 22. Give null only when
the advert does not identify the vehicle well enough to place it, and never
guess from the price.

"valueForMoney" is 1-10 on the asking price against comparable vehicles, using
the market context below when it is given. 5 is the going rate. Above 5 means
cheaper than comparable vehicles for what it is; below means dearer. Judge on
price against age, mileage and whether the conversion work is already done —
not on how well it matches the buyer's specification, which "score" already
covers. Say which in one short clause: "20k under comparable T5 conversions" or
"high mileage for the money". If there is nothing to compare against, give 5
and say the comparison was not possible.`;

/**
 * What comparable vehicles are going for, drawn from listings we have already
 * seen for the same watch.
 *
 * Without this the model can only judge value against whatever it recalls of
 * the used market in general. The local picture is both current and specific to
 * the search, which is what makes "cheap for what it is" mean anything.
 */
export interface MarketContext {
  sampleSize: number;
  medianPrice: number;
  lowerQuartile: number;
  upperQuartile: number;
  /** A handful of concrete comparables, cheapest first. */
  comparables: Array<{ title: string; price: number }>;
}

function renderMarketContext(market: MarketContext): string {
  const lines = [
    "# Market context (listings already seen for this same search)",
    `Sample: ${market.sampleSize} vehicles`,
    `Asking prices: lower quartile £${market.lowerQuartile.toLocaleString("en-GB")}, ` +
      `median £${market.medianPrice.toLocaleString("en-GB")}, ` +
      `upper quartile £${market.upperQuartile.toLocaleString("en-GB")}`
  ];
  if (market.comparables.length > 0) {
    lines.push("Comparables:");
    for (const c of market.comparables) {
      lines.push(`  £${c.price.toLocaleString("en-GB")} — ${c.title}`);
    }
  }
  return lines.join("\n");
}

function buildUserPrompt(spec: Spec, listing: ListingDetail, market?: MarketContext): string {
  const attributes = Object.entries(listing.attributes ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  return [
    "# Buyer specification",
    spec.prose,
    "",
    "# Advert",
    `Title: ${listing.title}`,
    `Price: ${listing.price ?? "not stated"}`,
    `Location: ${listing.location ?? "not stated"}`,
    `Posted: ${listing.postedDate ?? "not stated"}`,
    attributes ? `Seller-declared attributes:\n${attributes}` : "Seller-declared attributes: none",
    "",
    "Seller's description:",
    listing.description?.trim() || "(the seller wrote no description)",
    "",
    listing.description
      ? ""
      : "Note: with no description, nearly every specification point is an unknown.",
    market ? "" : "",
    market ? renderMarketContext(market) : ""
  ]
    .filter(Boolean)
    .join("\n");
}

export async function triageListing(
  config: OpenRouterConfig,
  spec: Spec,
  listing: ListingDetail,
  market?: MarketContext
): Promise<TriageResult> {
  const base = {
    url: listing.url,
    title: listing.title,
    price: listing.price,
    location: listing.location
  };

  // Free gates first: never pay a model to reject a £40,000 van against a
  // £10,000 ceiling.
  const gate = applyHardGates(spec, listing);
  if (gate.rejected) {
    return {
      ...base,
      score: 0,
      verdict: "reject",
      matched: [],
      concerns: [],
      hardRejects: gate.reasons,
      unknowns: [],
      extracted: {},
      gatedLocally: true
    };
  }

  const result = await complete<Omit<TriageResult, "url" | "title" | "gatedLocally" | "usage">>(config, {
    model: config.textModel,
    // deepseek-v4-flash is a reasoning model: without a cap on effort it spends
    // the whole token budget thinking and returns empty content.
    reasoningEffort: "low",
    // Long adverts against a long spec overran 4000 and returned empty content.
    maxTokens: 8000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(spec, listing, market) }
    ]
  });

  const data = result.data as Partial<TriageResult>;
  const score = Math.max(0, Math.min(100, Number(data.score ?? 0)));
  return {
    ...base,
    score,
    verdict: data.verdict ?? (score >= 85 ? "shortlist" : score >= 60 ? "maybe" : "reject"),
    matched: data.matched ?? [],
    concerns: data.concerns ?? [],
    hardRejects: data.hardRejects ?? [],
    unknowns: data.unknowns ?? [],
    registration: data.registration ?? undefined,
    extracted: data.extracted ?? {},
    valueForMoney: normaliseValue(data.valueForMoney),
    gatedLocally: false,
    usage: result.usage
  };
}

/**
 * Keep the value rating inside 1-10, or drop it.
 *
 * A rating is only useful if the scale is trustworthy, so a missing or
 * unparseable score becomes absent rather than a made-up middle value — the
 * alert then shows nothing instead of asserting "5/10" the model never said.
 */
function normaliseValue(
  raw: TriageResult["valueForMoney"]
): TriageResult["valueForMoney"] | undefined {
  const score = Number(raw?.score);
  if (!Number.isFinite(score)) return undefined;
  return {
    score: Math.max(1, Math.min(10, Math.round(score))),
    reason: typeof raw?.reason === "string" ? raw.reason.trim() : ""
  };
}

export interface PlateResult {
  registration: string | null;
  confidence: "high" | "medium" | "low" | null;
  imageIndex: number | null;
  usage?: Usage;
}

// UK plates since 2001: two letters, two digits, three letters.
const UK_PLATE = /\b([A-Z]{2}\d{2}\s?[A-Z]{3})\b/;

const PLATE_PROMPT = `Read the vehicle registration plate in these photos.

Reply with ONE JSON object covering all the photos together, never an array and
never one object per photo.

Return the plate only if you can read it with confidence. A guessed character
produces a lookup for a different vehicle entirely, which is worse than
returning nothing. Plates are frequently blurred, cropped or obscured — say so
rather than reconstructing them.

JSON only:
{"registration": string | null, "confidence": "high"|"medium"|"low"|null, "imageIndex": number | null}`;

/**
 * Extracts the number plate from listing photos, which is the only way to reach
 * DVLA and MOT history — sellers rarely state the registration in text.
 *
 * Deliberately narrow: no condition assessment, no rust detection. Reading
 * seven characters is a task a cheap model does reliably; judging bodywork from
 * a seller's flattering photos is not.
 */
export async function extractPlate(
  config: OpenRouterConfig,
  images: string[],
  // Two images keeps the request fast and cheap: the plate is almost always in
  // an exterior shot near the front of the gallery, and four images timed out.
  maxImages = 2
): Promise<PlateResult> {
  const selected = images.slice(0, maxImages);
  if (selected.length === 0) {
    return { registration: null, confidence: null, imageIndex: null };
  }

  const result = await complete<PlateResult>(config, {
    model: config.visionModel,
    maxTokens: 800,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PLATE_PROMPT },
          ...selected.map((url) => ({ type: "image_url" as const, image_url: { url } }))
        ]
      }
    ]
  });

  // Asked for several photos at once, vision models tend to answer per-image
  // with an array. That parses as valid JSON, so reading `.registration` off it
  // silently yielded undefined and every plate came back null.
  const payload = Array.isArray(result.data)
    ? ((result.data as PlateResult[]).find((entry) => entry?.registration) ?? result.data[0] ?? {})
    : result.data;

  const raw = (payload.registration ?? "").toString().toUpperCase().replace(/\s+/g, " ").trim();
  const match = raw.match(UK_PLATE);
  return {
    // Reject anything not shaped like a UK plate: a malformed read is a lookup
    // for someone else's vehicle.
    registration: match ? match[1].replace(/\s/g, "") : null,
    confidence: payload.confidence ?? null,
    imageIndex: typeof payload.imageIndex === "number" ? payload.imageIndex : null,
    usage: result.usage
  };
}
