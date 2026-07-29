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

function formatListingForMessage(listing: Listing): string {
  const meta = [sourceLabel(listing), listing.postedDate || "age unknown", listing.location].filter(Boolean).join(" · ");
  const parts = [
    listing.title,
    formatPrice(listing),
    `🧭 ${meta}`,
    `🔗 ${listing.url}`,
    `🛒 eBay: ${checkUrl(listing.title)}`
  ].filter(Boolean);
  return parts.join("\n");
}

function formatBatchMessage(keyword: string, listings: Listing[]): string {
  const gumtreeCount = listings.filter((item) => item.source !== "facebook").length;
  const facebookCount = listings.filter((item) => item.source === "facebook").length;
  const schedule = process.env.MARKET_WATCH_SCHEDULE || "*/10 * * * * (every 10 mins)";
  const header = `🔔 Market update: ${keyword} — cron ${schedule} — ${listings.length} new listing${listings.length !== 1 ? "s" : ""} (${gumtreeCount} Gumtree, ${facebookCount} Facebook)\n`;
  const items = listings.map((l, i) => `${i + 1}. ${formatListingForMessage(l)}`).join("\n\n────────\n\n");
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

  async sendListingAlertBatch(keyword: string, listings: Listing[]): Promise<void> {
    if (listings.length === 0) return;
    const body = formatBatchMessage(keyword, listings);

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