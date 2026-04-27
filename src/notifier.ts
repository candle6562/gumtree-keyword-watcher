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

function formatListingForMessage(listing: Listing): string {
  const parts = [
    listing.title,
    listing.price ? `💷 ${listing.price}` : null,
    listing.postedDate ? `📅 ${listing.postedDate}` : null,
    listing.location ? `📍 ${listing.location}` : null,
    listing.url
  ].filter(Boolean);
  return parts.join("\n");
}

function formatBatchMessage(keyword: string, listings: Listing[]): string {
  const header = `🔔 Gumtree ${keyword.toUpperCase()} alerts — ${listings.length} new listing${listings.length !== 1 ? "s" : ""}:\n`;
  const items = listings.map((l, i) => `${i + 1}. ${formatListingForMessage(l)}`).join("\n\n");
  return header + items;
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