import Twilio from "twilio";
import type { Listing } from "./types.js";

export interface TransportReadinessSignal {
  mode: "dry_run" | "openclaw" | "webhook" | "twilio" | "unconfigured";
  ready: boolean;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function checkUrl(title: string): string {
  const query = encodeURIComponent(title.replace(/\s+/g, " ").trim());
  return `https://www.ebay.co.uk/sch/i.html?_nkw=${query}`;
}

function parsePrice(price?: string): number | null {
  if (!price) return null;
  const match = price.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function estimateRrp(title: string): number | null {
  const text = title.toLowerCase();
  if (/husqvarna/.test(text) && /robot|automower|lawn\s*mower/.test(text)) return 1200;
  if (/yard\s*force|easymow/.test(text)) return 400;
  if (/sunseeker/.test(text) && /robot|lawn\s*mower/.test(text)) return 1000;
  if (/lawnmaster/.test(text) && /robot|robotic/.test(text)) return 300;
  if (/lawnmaster/.test(text) && /24v|cordless|mx/.test(text)) return 180;
  if (/karcher|kärcher/.test(text) && /lawn\s*mower|mower/.test(text)) return 150;
  return null;
}

function formatPrice(listing: Listing): string | null {
  if (!listing.price) return null;
  const price = parsePrice(listing.price);
  const rrp = estimateRrp(listing.title);
  if (!price || !rrp || price >= rrp) {
    return `💷 ${listing.price}`;
  }
  const discount = Math.round((1 - price / rrp) * 100);
  return `💷 ${listing.price} (RRP est. £${rrp.toLocaleString("en-GB")} · ${discount}% off est.)`;
}

function sourceLabel(listing: Listing): string {
  return listing.source === "facebook" ? "Facebook" : "Gumtree";
}

/**
 * A listing plus whatever the detail fetch managed to add. Detail is always
 * optional: a listing whose page could not be fetched still has to reach the
 * alert, just without the extra lines.
 */
/** How a mileage reads against the buyer's ideal range for that search. */
export type MileageRating = "great" | "good" | "ok" | "bad";

export type AlertListing = Listing & {
  description?: string;
  attributes?: Record<string, string>;
  sellerName?: string;
  /** Present only for watches marked as a vehicle search. */
  vehicle?: {
    mileage?: number | null;
    mileageRating?: MileageRating | null;
    /** Estimated real-world combined MPG; the model's knowledge, not the advert's. */
    mpg?: number | null;
    aircon?: boolean | null;
    converted?: boolean | null;
    valueForMoney?: { score: number; reason: string };
  };
};

/**
 * Marker for a mileage rating decided against the watch's own specification.
 *
 * The rating is computed where the spec is available rather than from fixed
 * thresholds here: the spec calls 70k-120k ideal for this search, so a blanket
 * "amber over 50k" would have flagged the buyer's preferred range as a caution.
 */
function mileageMarker(rating: MileageRating): string {
  switch (rating) {
    case "great": return "🟢";
    case "good": return "🟡";
    case "ok": return "🟠";
    case "bad": return "🔴";
  }
}

/** Tri-state: the advert said yes, said no, or said nothing. */
function triState(value: boolean | null | undefined): string {
  if (value === true) return "✅";
  if (value === false) return "❌";
  return "❓";
}

function formatVehicle(vehicle: NonNullable<AlertListing["vehicle"]>): string[] {
  const lines: string[] = [];
  const bits: string[] = [];

  if (typeof vehicle.mileage === "number") {
    const marker = vehicle.mileageRating ? `${mileageMarker(vehicle.mileageRating)} ` : "";
    bits.push(`${marker}${vehicle.mileage.toLocaleString("en-GB")} mi`);
  } else {
    bits.push("❓ mileage");
  }
  // Marked "~" because no advert states economy: this is an estimate for the
  // model, not a figure anyone has measured on this particular van.
  if (typeof vehicle.mpg === "number") bits.push(`⛽ ~${Math.round(vehicle.mpg)} mpg`);
  bits.push(`${triState(vehicle.aircon)} aircon`);
  bits.push(`${triState(vehicle.converted)} converted`);
  lines.push(`🚐 ${bits.join(" · ")}`);

  if (vehicle.valueForMoney) {
    const { score, reason } = vehicle.valueForMoney;
    lines.push(`💎 Value ${score}/10${reason ? ` — ${truncate(reason, 90)}` : ""}`);
  }
  return lines;
}

/** Attributes worth the space in a phone notification, in display order. */
const ATTRIBUTE_PRIORITY = [
  "mileage",
  "year",
  "fuel type",
  "transmission",
  "seats",
  "berths",
  "body type",
  "engine",
  "colour",
  "mot",
  "condition"
];

function formatAttributes(attributes: Record<string, string>, skipMileage = false): string | null {
  const entries = Object.entries(attributes)
    .filter(([, v]) => v && v.trim().length > 0)
    // The vehicle line already leads with mileage, banded against the spec.
    // Repeating it here, twice over including the raw "Driven ... km", spends
    // the most valuable line in the alert on something already said.
    .filter(([k]) => !(skipMileage && /^mileage/i.test(k.trim())));
  if (entries.length === 0) return null;

  const rank = (key: string): number => {
    const i = ATTRIBUTE_PRIORITY.indexOf(key.toLowerCase().trim());
    return i === -1 ? ATTRIBUTE_PRIORITY.length : i;
  };
  const chosen = entries.sort((a, b) => rank(a[0]) - rank(b[0])).slice(0, 4);
  return `📋 ${chosen.map(([k, v]) => `${k}: ${truncate(v.trim(), 40)}`).join(" · ")}`;
}

/**
 * One listing, as it appears in an alert.
 *
 * Vehicle watches get a tighter layout: the link moves up beside the title, and
 * the seller name and eBay lookup are dropped. Neither helps when judging a
 * van — an eBay search for "2017 Peugeot" returns nothing comparable — and the
 * assessment lines below are what the reader is actually there for.
 */
function formatListingForMessage(listing: AlertListing, vehicleWatch = false): string {
  const meta = [sourceLabel(listing), listing.postedDate || "age unknown", listing.location].filter(Boolean).join(" · ");
  const description = listing.description?.replace(/\s+/g, " ").trim();

  const parts = [
    vehicleWatch ? `${listing.title} (${listing.url})` : listing.title,
    formatPrice(listing),
    `🧭 ${meta}`,
    ...(listing.vehicle ? formatVehicle(listing.vehicle) : []),
    listing.attributes ? formatAttributes(listing.attributes, vehicleWatch) : null,
    description ? `📝 ${truncate(description, 220)}` : null,
    vehicleWatch ? null : listing.sellerName ? `👤 ${listing.sellerName}` : null,
    vehicleWatch ? null : `🔗 ${listing.url}`,
    vehicleWatch ? null : `🛒 eBay: ${checkUrl(listing.title)}`
  ].filter(Boolean);
  return parts.join("\n");
}

function formatBatchMessage(keyword: string, listings: AlertListing[], vehicleWatch = false): string {
  const gumtreeCount = listings.filter((item) => item.source !== "facebook").length;
  const facebookCount = listings.filter((item) => item.source === "facebook").length;
  const schedule = process.env.MARKET_WATCH_SCHEDULE || "*/10 * * * * (every 10 mins)";
  const header = `🔔 Market update: ${keyword} — cron ${schedule} — ${listings.length} new listing${listings.length !== 1 ? "s" : ""} (${gumtreeCount} Gumtree, ${facebookCount} Facebook)\n`;
  const items = listings
    .map((l, i) => `${i + 1}. ${formatListingForMessage(l, vehicleWatch)}`)
    .join("\n\n────────\n\n");
  return header + "\n" + items;
}

export class WhatsappNotifier {
  private readonly client?: ReturnType<typeof Twilio>;
  private readonly readiness: TransportReadinessSignal;

  constructor(
    accountSid: string | undefined,
    authToken: string | undefined,
    private readonly from: string,
    private readonly to: string,
    private readonly dryRun = false,
    private readonly webhookUrl?: string,
    private readonly webhookToken?: string,
    private readonly openclawGatewayToken?: string,
    private readonly openclawToolUrl = "http://127.0.0.1:28889/tools/invoke",
    private readonly httpTimeoutMs = 15_000
  ) {
    if (accountSid && authToken) {
      this.client = Twilio(accountSid, authToken);
    }
    this.readiness = this.computeReadiness();
  }

  getTransportReadiness(): TransportReadinessSignal {
    return this.readiness;
  }

  async sendText(body: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[DRY_RUN] WhatsApp message to ${this.to}\n${body}`);
      return;
    }

    if (this.openclawGatewayToken) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
      const target = this.to.startsWith("whatsapp:") ? this.to : `whatsapp:${this.to}`;
      const response = await fetch(this.openclawToolUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.openclawGatewayToken}`
        },
        body: JSON.stringify({
          tool: "message",
          action: "send",
          args: { channel: "whatsapp", target, message: body }
        })
      }).finally(() => clearTimeout(timer));

      if (!response.ok) {
        const errText = truncate((await response.text()).trim(), 500);
        throw new Error(`OpenClaw notifier failed: status=${response.status} body=${errText || "<empty>"}`);
      }
      return;
    }

    if (this.webhookUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.webhookToken ? { authorization: `Bearer ${this.webhookToken}` } : {})
        },
        body: JSON.stringify({ to: this.to, body })
      }).finally(() => clearTimeout(timer));

      if (!response.ok) {
        const bodyText = truncate((await response.text()).trim(), 500);
        throw new Error(`Webhook notifier failed: status=${response.status} body=${bodyText || "<empty>"}`);
      }
      return;
    }

    if (!this.client) {
      throw new Error("No WhatsApp notifier configured");
    }

    await this.client.messages.create({
      body,
      from: this.from,
      to: this.to
    });
  }

  private computeReadiness(): TransportReadinessSignal {
    if (this.dryRun) {
      return { mode: "dry_run", ready: false };
    }
    if (this.openclawGatewayToken) {
      return { mode: "openclaw", ready: true };
    }
    if (this.webhookUrl) {
      return { mode: "webhook", ready: true };
    }
    if (this.client) {
      return { mode: "twilio", ready: true };
    }
    return { mode: "unconfigured", ready: false };
  }

  async sendListingAlert(listing: Listing): Promise<void> {
    const body = formatListingForMessage(listing);

    if (this.dryRun) {
      console.log(`[DRY_RUN] WhatsApp alert to ${this.to}\n${body}`);
      return;
    }

    if (this.openclawGatewayToken) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
      const target = this.to.startsWith("whatsapp:") ? this.to : `whatsapp:${this.to}`;
      const response = await fetch(this.openclawToolUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.openclawGatewayToken}`
        },
        body: JSON.stringify({
          tool: "message",
          action: "send",
          args: { channel: "whatsapp", target, message: body }
        })
      }).finally(() => clearTimeout(timer));

      if (!response.ok) {
        const errText = truncate((await response.text()).trim(), 500);
        throw new Error(`OpenClaw notifier failed: status=${response.status} body=${errText || "<empty>"}`);
      }
      return;
    }

    if (this.webhookUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.webhookToken ? { authorization: `Bearer ${this.webhookToken}` } : {})
        },
        body: JSON.stringify({ to: this.to, body, listing })
      }).finally(() => {
        clearTimeout(timer);
      });

      if (!response.ok) {
        const bodyText = truncate((await response.text()).trim(), 500);
        throw new Error(
          `Webhook notifier failed: status=${response.status} statusText=${response.statusText} body=${bodyText || "<empty>"}`
        );
      }
      return;
    }

    if (!this.client) {
      throw new Error("No WhatsApp notifier configured");
    }

    await this.client.messages.create({
      body,
      from: this.from,
      to: this.to
    });
  }

  async sendListingAlertBatch(
    keyword: string,
    listings: AlertListing[],
    options: { vehicleWatch?: boolean } = {}
  ): Promise<void> {
    if (listings.length === 0) return;
    const body = formatBatchMessage(keyword, listings, options.vehicleWatch);

    if (this.dryRun) {
      console.log(`[DRY_RUN] Batch WhatsApp alert to ${this.to} (${listings.length} items)\n${body}`);
      return;
    }

    if (this.openclawGatewayToken) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
      const target = this.to.startsWith("whatsapp:") ? this.to : `whatsapp:${this.to}`;
      const response = await fetch(this.openclawToolUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.openclawGatewayToken}`
        },
        body: JSON.stringify({
          tool: "message",
          action: "send",
          args: { channel: "whatsapp", target, message: body }
        })
      }).finally(() => clearTimeout(timer));

      if (!response.ok) {
        const errText = truncate((await response.text()).trim(), 500);
        throw new Error(`OpenClaw notifier failed: status=${response.status} body=${errText || "<empty>"}`);
      }
      return;
    }

    if (this.webhookUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.httpTimeoutMs);
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(this.webhookToken ? { authorization: `Bearer ${this.webhookToken}` } : {})
        },
        body: JSON.stringify({ to: this.to, body, listings, keyword })
      }).finally(() => clearTimeout(timer));

      if (!response.ok) {
        const bodyText = truncate((await response.text()).trim(), 500);
        throw new Error(
          `Webhook notifier failed: status=${response.status} statusText=${response.statusText} body=${bodyText || "<empty>"}`
        );
      }
      return;
    }

    if (!this.client) {
      throw new Error("No WhatsApp notifier configured");
    }

    await this.client.messages.create({
      body,
      from: this.from,
      to: this.to
    });
  }
}