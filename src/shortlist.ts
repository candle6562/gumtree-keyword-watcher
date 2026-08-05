import type { SeenEntry } from "./store.js";

/**
 * Rank assessed vehicles into a shortlist worth acting on.
 *
 * Built from assessments already stored when each listing was alerted, so the
 * digest costs nothing extra: re-running the model over every live listing each
 * morning would be hundreds of calls to re-derive answers we already have.
 */

export interface ShortlistEntry {
  entry: SeenEntry;
  priority: number;
  reasons: string[];
}

const VERDICT_WEIGHT: Record<string, number> = { shortlist: 40, maybe: 15, reject: -60 };

/**
 * Score a listing for "worth a message to the seller".
 *
 * Deliberately not the same as the spec score. That answers "does this meet the
 * requirements"; this answers "should I spend an evening on it", which weighs
 * being cheap for what it is, and being already converted, more heavily than
 * ticking every box.
 */
export function priorityOf(entry: SeenEntry): { priority: number; reasons: string[] } {
  const v = entry.vehicle;
  if (!v) return { priority: -Infinity, reasons: [] };

  const reasons: string[] = [];
  let priority = 0;

  priority += VERDICT_WEIGHT[v.verdict ?? ""] ?? 0;
  if (v.verdict === "shortlist") reasons.push("meets the spec");

  // Spec match, scaled so a perfect match is worth about as much as being
  // clearly good value. Neither alone should dominate.
  priority += (v.score ?? 0) * 0.3;

  const value = v.valueForMoney?.score;
  if (typeof value === "number") {
    priority += (value - 5) * 8;
    if (value >= 7) reasons.push(`good value (${value}/10)`);
    if (value <= 3) reasons.push(`dear for what it is (${value}/10)`);
  }

  if (v.converted === true) {
    priority += 20;
    reasons.push("already converted");
  }

  if (typeof v.mileage === "number") {
    // Mileage matters, but a tired van at the right price still deserves a look,
    // so this only nudges rather than deciding.
    if (v.mileage <= 100_000) { priority += 10; reasons.push(`${v.mileage.toLocaleString("en-GB")} mi`); }
    else if (v.mileage >= 180_000) { priority -= 15; reasons.push(`${v.mileage.toLocaleString("en-GB")} mi`); }
  }

  if (typeof v.mpg === "number" && v.mpg >= 40) {
    priority += 6;
    reasons.push(`~${Math.round(v.mpg)} mpg`);
  }

  if (v.aircon === true) priority += 3;

  return { priority, reasons };
}

/**
 * The best listings still worth pursuing, best first.
 *
 * Anything already gone is excluded — a shortlist of sold vans wastes the
 * reader's morning.
 */
export function buildShortlist(
  entries: SeenEntry[],
  watchName: string,
  limit = 10
): ShortlistEntry[] {
  return entries
    .filter((entry) => entry.watchName === watchName)
    .filter((entry) => !entry.goneAt)
    .filter((entry) => entry.vehicle?.verdict !== "reject")
    .map((entry) => ({ entry, ...priorityOf(entry) }))
    .filter((row) => Number.isFinite(row.priority))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}

/** Current asking price, preferring the swept history over the matched price. */
function currentPrice(entry: SeenEntry): string {
  const latest = entry.priceHistory?.[entry.priceHistory.length - 1]?.price;
  if (typeof latest === "number") return `£${latest.toLocaleString("en-GB")}`;
  return entry.price ?? "price unknown";
}

/** A price cut since we first saw it is the strongest reason to look now. */
function priceMovement(entry: SeenEntry): string | null {
  const history = entry.priceHistory ?? [];
  if (history.length < 2) return null;
  const first = history[0].price;
  const last = history[history.length - 1].price;
  if (last >= first) return null;
  return `↓ £${(first - last).toLocaleString("en-GB")} since first seen`;
}

export function formatShortlist(rows: ShortlistEntry[], watchName: string): string[] {
  if (rows.length === 0) return [];

  const lines = [`🎯 Top ${rows.length} worth a look — ${watchName}`, ""];
  rows.forEach((row, i) => {
    const { entry } = row;
    const notes = [priceMovement(entry), ...row.reasons].filter(Boolean).slice(0, 3);
    lines.push(`${i + 1}. ${entry.title ?? "(untitled)"} — ${currentPrice(entry)}`);
    if (notes.length > 0) lines.push(`   ${notes.join(" · ")}`);
    lines.push(`   ${entry.url}`);
  });
  return lines;
}
