import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Deterministic gates, evaluated locally before any model call so an obvious
 * reject never costs money. Everything nuanced is left to the prose.
 */
export interface HardReject {
  price_gt?: number;
  price_lt?: number;
  year_lt?: number;
  weight_kg_gt?: number;
  seats_lt?: number;
}

export interface SoftFlags {
  price_ideal?: [number, number];
  year_ideal_from?: number;
  mileage_ideal?: [number, number];
  preferred_models?: string[];
}

export interface Spec {
  name: string;
  watch?: string;
  hardReject: HardReject;
  softFlags: SoftFlags;
  sources: string[];
  /** The prose below the front matter, passed to the model verbatim. */
  prose: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSpec(raw: string, fallbackName: string): Spec {
  const match = raw.match(FRONT_MATTER);
  if (!match) {
    // A spec is still usable with no front matter — it just gets no free gates.
    return { name: fallbackName, hardReject: {}, softFlags: {}, sources: [], prose: raw.trim() };
  }

  const meta = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
  return {
    name: typeof meta.name === "string" ? meta.name : fallbackName,
    watch: typeof meta.watch === "string" ? meta.watch : undefined,
    hardReject: (meta.hard_reject as HardReject) ?? {},
    softFlags: (meta.soft_flags as SoftFlags) ?? {},
    sources: Array.isArray(meta.sources) ? (meta.sources as string[]) : [],
    prose: match[2].trim()
  };
}

export async function loadSpec(name: string, dir = join(process.cwd(), "config", "specs")): Promise<Spec> {
  const file = name.endsWith(".md") ? name : `${name}.md`;
  const raw = await readFile(join(dir, file), "utf8");
  return parseSpec(raw, file.replace(/\.md$/, ""));
}

export function parsePricePounds(price?: string | null): number | null {
  if (!price) return null;
  const match = price.replace(/,/g, "").match(/£\s*(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

/** Year from a title like "2015 Volkswagen Transporter". */
export function parseYear(title?: string | null): number | null {
  const match = (title ?? "").match(/\b(19[89]\d|20[0-4]\d)\b/);
  return match ? Number(match[1]) : null;
}

export interface GateResult {
  rejected: boolean;
  reasons: string[];
}

/**
 * Free pre-filter. Only rejects on facts we can read directly off the listing —
 * anything requiring judgement is deliberately left for the model, so a
 * borderline van is never silently dropped here.
 */
export function applyHardGates(
  spec: Spec,
  listing: { title?: string; price?: string }
): GateResult {
  const reasons: string[] = [];
  const price = parsePricePounds(listing.price);
  const year = parseYear(listing.title);

  if (spec.hardReject.price_gt !== undefined && price !== null && price > spec.hardReject.price_gt) {
    reasons.push(`price £${price} exceeds £${spec.hardReject.price_gt}`);
  }
  if (spec.hardReject.price_lt !== undefined && price !== null && price < spec.hardReject.price_lt) {
    reasons.push(`price £${price} below £${spec.hardReject.price_lt}`);
  }
  if (spec.hardReject.year_lt !== undefined && year !== null && year < spec.hardReject.year_lt) {
    reasons.push(`year ${year} older than ${spec.hardReject.year_lt}`);
  }

  return { rejected: reasons.length > 0, reasons };
}
