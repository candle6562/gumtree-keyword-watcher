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
  };
  gatedLocally: boolean;
  usage?: Usage;
}

const SYSTEM_PROMPT = `You assess second-hand vehicle adverts against a buyer's written specification.

Judge only what the advert actually says. Never infer a fact the seller has not
stated: if the advert does not mention air conditioning, that is an unknown, not
an absence. This distinction matters — the buyer uses "unknowns" as the list of
questions to ask the seller, and a fabricated fact wastes a viewing.

Scoring, 0-100:
  85-100 shortlist  meets the essentials and most preferences
  60-84  maybe      plausible but with real gaps or concerns
  0-59   reject     fails an essential requirement

Reply with JSON only:
{
  "score": number,
  "verdict": "shortlist" | "maybe" | "reject",
  "matched": [string],      // spec points this advert satisfies
  "concerns": [string],     // spec points it fails or looks weak on
  "hardRejects": [string],  // items from the spec's "reject or strongly flag" list
  "unknowns": [string],     // spec points the advert does not address
  "registration": string | null,  // only if the advert states it
  "extracted": {
    "year": number | null, "mileage": number | null, "fuel": string | null,
    "euroStatus": string | null, "seats": number | null, "model": string | null,
    "popTop": boolean | null
  }
}`;

function buildUserPrompt(spec: Spec, listing: ListingDetail): string {
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
      : "Note: with no description, nearly every specification point is an unknown."
  ]
    .filter(Boolean)
    .join("\n");
}

export async function triageListing(
  config: OpenRouterConfig,
  spec: Spec,
  listing: ListingDetail
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
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(spec, listing) }
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
    gatedLocally: false,
    usage: result.usage
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
