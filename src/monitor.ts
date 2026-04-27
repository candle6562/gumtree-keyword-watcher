import { readFile } from "node:fs/promises";
import { loadConfig, type AppConfig } from "./config.js";
import { DiagnosticsSink } from "./diagnostics.js";
import { fetchGumtreeHtml, parseGumtreeResults } from "./gumtree.js";
import { matchListings } from "./matcher.js";
import { WhatsappNotifier } from "./notifier.js";
import { RuntimeStats } from "./observability.js";
import { withRetry } from "./retry.js";
import { SeenStore } from "./store.js";

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export class Monitor {
  private readonly store: SeenStore;
  private readonly notifier: WhatsappNotifier;
  private readonly diagnostics: DiagnosticsSink;
  private readonly runtimeStats: RuntimeStats;

  constructor(private readonly config: AppConfig, runtimeStats: RuntimeStats = new RuntimeStats()) {
    this.store = new SeenStore(config.dataPath, {
      retentionDays: config.dedupeRetentionDays,
      maxEntries: config.dedupeMaxEntries
    });
    this.notifier = new WhatsappNotifier(
      config.twilioAccountSid,
      config.twilioAuthToken,
      config.whatsappFrom,
      config.whatsappTo,
      config.dryRun,
      config.whatsappAlertWebhookUrl,
      config.whatsappAlertWebhookToken,
      config.openclawGatewayToken,
      config.openclawToolUrl,
      config.httpTimeoutMs
    );
    this.diagnostics = new DiagnosticsSink(config.diagnosticsLogPath);
    this.runtimeStats = runtimeStats;
  }

  async init(): Promise<void> {
    await this.store.load();
  }

  async runCycle(): Promise<void> {
    const runRef = `cycle-${Date.now()}`;
    const transportReadiness = this.notifier.getTransportReadiness();
    this.runtimeStats.markCycleStart();
    let failedKeywords = 0;
    console.log(`Starting scrape cycle at ${new Date().toISOString()} (${runRef})`);

    if (this.config.deliveryCanaryEnabled) {
      const canaryOk = await this.runDeliveryCanary(runRef, transportReadiness);
      if (!canaryOk) {
        failedKeywords += 1;
      }
    }

    for (const keyword of this.config.keywords) {
      try {
        const html = await withRetry(
          () => fetchGumtreeHtml(this.config.postcode, keyword, this.config.httpTimeoutMs),
          this.config.retryAttempts,
          this.config.retryDelayMs,
          `fetch:${keyword}`
        );

        const parsed = parseGumtreeResults(html);
        const matches = matchListings(parsed, keyword);
        let sent = 0;
        let skipped = 0;

        for (const match of matches) {
          if (this.store.has(match.url)) {
            skipped += 1;
            continue;
          }

          await withRetry(
            () => this.notifier.sendListingAlert(match),
            this.config.retryAttempts,
            this.config.retryDelayMs,
            `notify:${keyword}`
          );

          await this.store.add(match.url);
          sent += 1;
          console.log(`Alert sent for ${match.url}`);
        }

        console.log(
          `Keyword '${keyword}': parsed=${parsed.length}, matched=${matches.length}, sent=${sent}, skipped_duplicates=${skipped}`
        );
        await this.diagnostics.write({
          timestamp: new Date().toISOString(),
          runRef,
          outcome: "success",
          transportReadiness,
          errorDetail: null,
          nextAction: "Continue next scheduled cycle",
          details: {
            keyword,
            parsed: parsed.length,
            matched: matches.length,
            sent,
            skippedDuplicates: skipped
          }
        });
      } catch (error) {
        failedKeywords += 1;
        const message = describeError(error);
        console.error(`Cycle failed for keyword '${keyword}': ${message}`);
        await this.diagnostics.write({
          timestamp: new Date().toISOString(),
          runRef,
          outcome: "failure",
          transportReadiness,
          errorDetail: message,
          nextAction: "Retry on next scheduled cycle; inspect transport/scraper logs if repeated",
          details: {
            keyword
          }
        });
      }
    }
    this.runtimeStats.markCycleComplete({ ok: failedKeywords === 0, failedKeywords });
  }

  private async runDeliveryCanary(
    runRef: string,
    transportReadiness: ReturnType<WhatsappNotifier["getTransportReadiness"]>
  ): Promise<boolean> {
    const details: Record<string, unknown> = {
      checkType: "delivery_canary",
      keyword: this.config.deliveryCanaryKeyword,
      fixturePath: this.config.deliveryCanaryFixturePath,
      expectedMinimumSent: 1
    };

    if (transportReadiness.mode !== "webhook" || !transportReadiness.ready) {
      const errorDetail =
        "Canary readiness gate failed: requires transportReadiness.mode=webhook and transportReadiness.ready=true";
      console.error(errorDetail);
      await this.diagnostics.write({
        timestamp: new Date().toISOString(),
        runRef,
        outcome: "failure",
        transportReadiness,
        errorDetail,
        nextAction:
          "Escalate immediately: canary cannot validate delivery path until webhook transport readiness is restored",
        details
      });
      return false;
    }

    try {
      const html = await readFile(this.config.deliveryCanaryFixturePath, "utf8");
      const parsed = parseGumtreeResults(html);
      const matches = matchListings(parsed, this.config.deliveryCanaryKeyword);
      details.parsed = parsed.length;
      details.matched = matches.length;

      if (matches.length < 1) {
        throw new Error(
          `Controlled fixture produced no matches for keyword '${this.config.deliveryCanaryKeyword}'`
        );
      }

      const canaryListing = {
        ...matches[0],
        url: `${matches[0].url}${matches[0].url.includes("?") ? "&" : "?"}delivery_canary=true&run_ref=${encodeURIComponent(runRef)}`
      };

      await withRetry(
        () => this.notifier.sendListingAlert(canaryListing),
        this.config.retryAttempts,
        this.config.retryDelayMs,
        "notify:delivery-canary"
      );

      details.sent = 1;
      await this.diagnostics.write({
        timestamp: new Date().toISOString(),
        runRef,
        outcome: "success",
        transportReadiness,
        errorDetail: null,
        nextAction: "Continue next scheduled cycle",
        details
      });
      console.log(
        `Delivery canary passed: matched=${matches.length}, sent=1, keyword='${this.config.deliveryCanaryKeyword}'`
      );
      return true;
    } catch (error) {
      const message = describeError(error);
      details.sent = 0;
      console.error(`Delivery canary failed: ${message}`);
      await this.diagnostics.write({
        timestamp: new Date().toISOString(),
        runRef,
        outcome: "failure",
        transportReadiness,
        errorDetail: message,
        nextAction:
          "Escalate immediately: investigate fixture parsing or webhook delivery path before trusting live send results",
        details
      });
      return false;
    }
  }
}

export function createMonitorFromEnv(env: NodeJS.ProcessEnv = process.env): Monitor {
  const config = loadConfig(env);
  return new Monitor(config);
}
