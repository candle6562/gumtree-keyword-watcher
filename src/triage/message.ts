import type { TriageResult } from "./index.js";

function verdictIcon(verdict: string): string {
  if (verdict === "shortlist") return "✅";
  if (verdict === "maybe") return "🟡";
  return "❌";
}

function truncateList(items: string[], limit: number): string[] {
  if (items.length <= limit) return items;
  return [...items.slice(0, limit), `…and ${items.length - limit} more`];
}

export interface TriageMessageOptions {
  watchName: string;
  schedule?: string;
  /** Rejects are summarised rather than listed in full. */
  maxRejectsListed?: number;
  /** Cap on detail lines per shortlisted listing. */
  maxBullets?: number;
}

/**
 * Formats scored listings for WhatsApp.
 *
 * Ordered by score, and deliberately asymmetric: a good van gets its reasoning
 * and its open questions, a rejected one gets a single line saying why. Listing
 * every reject in full is what turned earlier alerts into a wall of text nobody
 * reads, but dropping them silently hides triage mistakes — so they stay,
 * compressed.
 */
export function formatTriageMessage(results: TriageResult[], options: TriageMessageOptions): string {
  const maxRejects = options.maxRejectsListed ?? 8;
  const maxBullets = options.maxBullets ?? 3;

  const sorted = [...results].sort((a, b) => b.score - a.score);
  const shortlist = sorted.filter((r) => r.verdict === "shortlist");
  const maybes = sorted.filter((r) => r.verdict === "maybe");
  const rejects = sorted.filter((r) => r.verdict === "reject");

  const lines: string[] = [];
  lines.push(
    `🔔 ${options.watchName} — ${results.length} triaged` +
      (options.schedule ? ` — cron ${options.schedule}` : "")
  );
  lines.push(`✅ ${shortlist.length} shortlist · 🟡 ${maybes.length} maybe · ❌ ${rejects.length} reject`);

  const detailed = [...shortlist, ...maybes];
  if (detailed.length > 0) {
    lines.push("");
    lines.push("────────");
  }

  detailed.forEach((r, index) => {
    if (index > 0) {
      lines.push("");
      lines.push("────────");
    }
    lines.push("");
    lines.push(`${verdictIcon(r.verdict)} ${r.score}/100 — ${r.title}`);

    const facts = [
      r.price,
      r.extracted.mileage ? `${r.extracted.mileage.toLocaleString()} mi` : null,
      r.extracted.fuel,
      r.extracted.seats ? `${r.extracted.seats} seats` : null,
      r.extracted.popTop === true ? "pop-top" : null,
      r.registration ? `reg ${r.registration}` : null
    ].filter(Boolean);
    if (facts.length) lines.push(`💷 ${facts.join(" · ")}`);
    if (r.location) lines.push(`🧭 ${r.location}`);

    for (const item of truncateList(r.matched, maxBullets)) lines.push(`  ✓ ${item}`);
    for (const item of truncateList(r.concerns, maxBullets)) lines.push(`  ⚠️ ${item}`);
    for (const item of truncateList(r.hardRejects, 2)) lines.push(`  ⛔ ${item}`);
    if (r.unknowns.length) lines.push(`  ❓ ask: ${truncateList(r.unknowns, maxBullets).join("; ")}`);

    lines.push(`🔗 ${r.url}`);
  });

  if (rejects.length > 0) {
    lines.push("");
    lines.push("────────");
    lines.push("");
    lines.push(`❌ Rejected (${rejects.length}):`);
    for (const r of rejects.slice(0, maxRejects)) {
      const why = r.hardRejects[0] ?? r.concerns[0] ?? "does not meet the specification";
      lines.push(`• ${r.title} — ${r.price ?? "?"} — ${why}`);
    }
    if (rejects.length > maxRejects) {
      lines.push(`• …and ${rejects.length - maxRejects} more`);
    }
  }

  return lines.join("\n");
}
