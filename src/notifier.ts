import Twilio from "twilio";
import type { Listing } from "./types.js";

export interface TransportReadinessSignal {
  mode: "dry_run" | "webhook" | "twilio" | "unconfigured";
  ready: boolean;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
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
      return {
        mode: "dry_run",
        ready: false
      };
    }
    if (this.webhookUrl) {
      return {
        mode: "webhook",
        ready: true
      };
    }
    if (this.client) {
      return {
        mode: "twilio",
        ready: true
      };
    }
    return {
      mode: "unconfigured",
      ready: false
    };
  }

  async sendListingAlert(listing: Listing): Promise<void> {
    const body = [
      `Gumtree match: ${listing.matchedKeyword}`,
      listing.title,
      listing.url
    ].join("\n");

    if (this.dryRun) {
      console.log(`[DRY_RUN] WhatsApp alert to ${this.to}\n${body}`);
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
        body: JSON.stringify({
          to: this.to,
          body,
          listing
        })
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
}
