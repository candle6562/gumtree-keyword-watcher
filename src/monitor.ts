import { readFile } from "node:fs/promises";
import { ensureWorkerHealthy } from "./browser-worker.js";
import { loadConfig, type AppConfig } from "./config.js";
import { DiagnosticsSink } from "./diagnostics.js";
import { searchFacebookMarketplace } from "./facebook-marketplace.js";
import { HealthStateStore } from "./health-state.js";
import { fetchGumtreeHtml, parseGumtreeResults } from "./gumtree.js";
import { DetailStore, enrichListings } from "./listing-detail.js";
import { isNotKnownToBeOutsideRadius } from "./location-filter.js";
import { matchListings } from "./matcher.js";
import { filterByWatchRules } from "./listing-filter.js";
import { WhatsappNotifier, type AlertListing } from "./notifier.js";
import { RuntimeStats } from "./observability.js";
import { withRetry } from "./retry.js";
import { SeenStore, type SeenEntry } from "./store.js";
import type { Listing, ListingSource, RawListing } from "./types.js";
import { loadWatches, type MarketWatch } from "./watches.js";

/** Cap on how many listings go into a single WhatsApp message. */
const MAX_LISTINGS_PER_ALERT = 25;

function entryToListing(entry: SeenEntry): Listing {
  return {
    url: entry.url,
    title: entry.title ?? entry.matchedKeyword ?? "Listing",
    matchedKeyword: entry.matchedKeyword ?? "",
    source: entry.source as ListingSource | undefined,
    price: entry.price,
    location: entry.location,
    postedDate: entry.postedDate
  };
}

function postedAgeDays(postedDate?: string | null): number | null {
  if (!postedDate) return null;
  const value = postedDate.replace(/^listed\s+/i, "").replace(/\s+in\s+.+$/i, "").trim().toLowerCase();
  if (["just listed", "just now", "today"].includes(value)) return 0;
  if (value === "yesterday") return 1;
  const match = value.match(/^(\d+|a|an)\s+(min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months)\s+ago$/i);
  if (!match) return null;
  const amount = /^(a|an)$/i.test(match[1]) ? 1 : Number(match[1]);
  const unit = match[2].toLowerCase();
  if (/^(min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.test(unit)) return 0;
  if (/^(d|day|days)$/.test(unit)) return amount;
  if (/^(w|week|weeks)$/.test(unit)) return amount * 7;
  if (/^(mo|month|months)$/.test(unit)) return amount * 30;
  return null;
}

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
  private readonly health: HealthStateStore;
  private readonly details: DetailStore;

  constructor(private readonly config: AppConfig, runtimeStats: RuntimeStats = new RuntimeStats()) {
    this.details = new DetailStore(config.detailCachePath);
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
    this.health = new HealthStateStore(config.healthStatePath);
  }

  async init(): Promise<void> {
    await this.store.load();
    await this.health.load();
    await this.details.load();
  }

  /**
   * The most recently seen listings for a watch, newest first.
   *
   * Handed to the search worker so it can stop scrolling once it reaches
   * already-known territory. Only the recent end is worth sending: results come
   * back newest-first, so an old listing deep in the store will never be the
   * thing that halts a harvest, and the payload stays small.
   */
  private recentKnownUrls(watchName: string, limit = 300): string[] {
    return this.store
      .entries()
      .filter((entry) => entry.source === "facebook" && entry.watchName === watchName)
      .sort((a, b) => b.seenAt - a.seenAt)
      .slice(0, limit)
      .map((entry) => entry.url);
  }

  /**
   * Attach detail-page data to the listings about to be alerted.
   *
   * Only the outgoing batch is enriched, never every match: the batch is capped
   * at MAX_LISTINGS_PER_ALERT and detail fetching is one browser round trip per
   * listing. Anything the fetch cannot supply — disabled, over the per-cycle
   * budget, non-Facebook, or simply failed — falls through as the plain
   * listing, so a detail problem can never cost us the alert itself.
   */
  private async withDetail(listings: Listing[]): Promise<AlertListing[]> {
    if (!this.config.detailFetchEnabled) return listings;

    let enriched;
    try {
      enriched = await enrichListings(this.config, this.details, listings);
      await this.details.persist();
    } catch (error) {
      console.error(`Detail enrichment failed, alerting without it: ${describeError(error)}`);
      return listings;
    }

    const byUrl = new Map(enriched.details.map((detail) => [detail.url, detail]));
    console.log(
      `Detail: ${enriched.fetched} fetched, ${enriched.cached} cached, ${enriched.skipped} skipped, ${enriched.failed} failed`
    );

    return listings.map((listing) => {
      const detail = byUrl.get(listing.url);
      if (!detail) return listing;
      return {
        ...listing,
        // The search card has no real date — facebook-marketplace.ts fills in a
        // synthetic "Listed in the last N days" from the window we requested.
        // The detail page carries the actual relative date, so prefer it.
        //
        // Facebook words it as "Listed 4 hours ago in Catterick Garrison", and
        // the worker parses `location` out of that very suffix, so keeping it
        // would print the town twice in one line. Drop it and let the existing
        // location field say where.
        postedDate: (detail.postedDate ?? listing.postedDate)?.replace(/\s+in\s+.+$/i, ""),
        description: detail.description,
        attributes: detail.attributes,
        sellerName: detail.sellerName
      };
    });
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

    const activeWatches: MarketWatch[] = loadWatches().filter(
      (watch) => watch.enabled && watch.terms.length > 0
    );

    // An empty watch file means there is nothing to run. Do not resurrect the
    // old MARKET_WATCH_GROUP_NAME/KEYWORDS fallback after a user deletes their
    // final watch or removes its final term.
    if (activeWatches.length === 0) {
      console.log("No active watches configured; scrape cycle complete");
      this.runtimeStats.markCycleComplete({ ok: failedKeywords === 0, failedKeywords });
      return;
    }

    // Probe (and if necessary restart) the browser worker once per cycle, rather
    // than letting every keyword burn its full retry budget against a dead host.
    let facebookAvailable = this.config.marketplaceFacebookEnabled;
    let workerDetail = "facebook source disabled";
    if (this.config.marketplaceFacebookEnabled) {
      const workerHealth = await ensureWorkerHealthy(this.config);
      facebookAvailable = workerHealth.healthy;
      workerDetail = workerHealth.detail;
      if (workerHealth.restartAttempted) {
        await this.health.markRestartAttempt();
        await this.diagnostics.write({
          timestamp: new Date().toISOString(),
          runRef,
          outcome: workerHealth.recovered ? "success" : "failure",
          transportReadiness,
          errorDetail: workerHealth.recovered ? null : workerHealth.detail,
          nextAction: workerHealth.recovered
            ? "Browser worker auto-restarted; continuing"
            : "Browser worker could not be restarted; confirm the Windows host is logged in (HEADLESS=false needs a desktop session)",
          details: { checkType: "browser_worker_autostart", ...workerHealth }
        });
      }
      if (!facebookAvailable) {
        console.error(`Facebook source unavailable this cycle: ${workerDetail}`);
      }
    }

    let sourceFailures = 0;

    for (const watch of activeWatches) {
      const seenThisWatch = new Set<string>();
      let totalMatched = 0;
      let newThisWatch = 0;

      for (const keyword of watch.terms) {
        // Sources are fetched independently. They used to share one try block,
        // so a Facebook failure threw away Gumtree matches found in the same
        // pass — which is why three days of dead-worker downtime produced no
        // alerts at all despite Gumtree working fine throughout.
        let parsed: RawListing[] = [];
        let localParsed: RawListing[] = [];
        let recentLocalParsed: RawListing[] = [];
        let gumtreeMatches: Listing[] = [];
        let facebookMatches: Listing[] = [];
        let gumtreeError: string | null = null;
        let facebookError: string | null = null;
        // Both sources share one age window so their results stay comparable.
        const maxAgeDays = watch.maxAgeDays ?? 1;

        try {
          const html = await withRetry(
            () => fetchGumtreeHtml(this.config.postcode, keyword, this.config.httpTimeoutMs, watch.distanceKm, watch.gumtreeCategory),
            this.config.retryAttempts,
            this.config.retryDelayMs,
            `fetch:${keyword}`
          );
          parsed = parseGumtreeResults(html);
          localParsed = parsed.filter((item) => isNotKnownToBeOutsideRadius(item.location, watch.distanceKm));
          recentLocalParsed = localParsed.filter((item) => {
            const age = postedAgeDays(item.postedDate);
            return age !== null && age <= maxAgeDays;
          });
          // Gumtree has already matched these against `q=`, so re-checking that
          // the title literally contains the term is a second, stricter filter
          // that Facebook results never face. Real vehicles title themselves
          // "campervan", "DAY VAN" or "Ford, TRANSIT, Panel Van, 2011" — the
          // re-check took 7 in-range listings down to 0. Keep it only for the
          // default general-goods category, where the query is the sole thing
          // scoping the search; a deliberate category already does that job.
          gumtreeMatches = watch.gumtreeCategory
            ? recentLocalParsed.map((item) => ({ ...item, matchedKeyword: keyword }))
            : matchListings(recentLocalParsed, keyword);
        } catch (error) {
          gumtreeError = describeError(error);
        }

        if (this.config.marketplaceFacebookEnabled) {
          if (!facebookAvailable) {
            facebookError = `browser worker unavailable: ${workerDetail}`;
          } else {
            try {
              facebookMatches = await withRetry(
                () =>
                  searchFacebookMarketplace(
                    this.config,
                    keyword,
                    maxAgeDays,
                    50,
                    watch.distanceKm,
                    { min: watch.minPrice, max: watch.maxPrice },
                    // Newest-first results mean the worker can stop scrolling
                    // once it reaches listings we already hold. On a quiet cycle
                    // that ends the harvest after a handful of cards instead of
                    // working down the whole grid to find nothing new.
                    this.recentKnownUrls(watch.name)
                  ),
                this.config.retryAttempts,
                this.config.retryDelayMs,
                `facebook:${keyword}`
              );
            } catch (error) {
              facebookError = describeError(error);
            }
          }
        }

        const rawMatches = [...gumtreeMatches, ...facebookMatches];
        const matches = filterByWatchRules(watch, rawMatches);
        const ruleFiltered = rawMatches.length - matches.length;
        totalMatched += matches.length;

        // Record matches as seen immediately, marked undelivered. Waiting for a
        // successful send meant an outage re-matched the same listings every ten
        // minutes and re-queued a duplicate alert each time; that built a
        // 355-message backlog which flooded the group chat on 2026-07-22.
        const newEntries: SeenEntry[] = [];
        const backfillEntries: SeenEntry[] = [];
        for (const match of matches) {
          const cached = this.store.get(match.url);
          if (!cached && !seenThisWatch.has(match.url)) {
            seenThisWatch.add(match.url);
            newEntries.push({
              url: match.url,
              seenAt: Date.now(),
              title: match.title,
              matchedKeyword: match.matchedKeyword,
              watchName: watch.name,
              source: match.source,
              price: match.price,
              location: match.location,
              postedDate: match.postedDate,
              delivered: false
            });
          } else if (cached && (!cached.title || !cached.matchedKeyword || !cached.watchName)) {
            backfillEntries.push({
              ...cached,
              title: match.title,
              matchedKeyword: match.matchedKeyword,
              watchName: watch.name,
              source: match.source,
              price: match.price,
              location: match.location
            });
          }
        }
        await this.store.addEntries([...newEntries, ...backfillEntries]);
        newThisWatch += newEntries.length;

        const skipped = matches.length - newEntries.length;
        const failedSources = [
          gumtreeError ? "gumtree" : null,
          facebookError ? "facebook" : null
        ].filter(Boolean) as string[];
        if (failedSources.length > 0) {
          sourceFailures += failedSources.length;
          failedKeywords += 1;
        }

        console.log(
          `Watch '${watch.name}' keyword '${keyword}': parsed=${parsed.length}, gumtree_local=${localParsed.length}, gumtree_recent_local=${recentLocalParsed.length}, gumtree_matched=${gumtreeMatches.length}, facebook_matched=${facebookMatches.length}, rule_filtered=${ruleFiltered}, matched=${matches.length}, new=${newEntries.length}, queued=${newEntries.length}, skipped_duplicates=${skipped}, failed_sources=${failedSources.join("|") || "none"}`
        );
        if (gumtreeError) {
          console.error(`Gumtree source failed for '${watch.name}' / '${keyword}': ${gumtreeError}`);
        }
        if (facebookError) {
          console.error(`Facebook source failed for '${watch.name}' / '${keyword}': ${facebookError}`);
        }

        await this.diagnostics.write({
          timestamp: new Date().toISOString(),
          runRef,
          // A partial cycle still delivered real results, so only a total source
          // wipeout counts as a failure for alerting purposes.
          outcome: failedSources.length > 0 ? "failure" : "success",
          transportReadiness,
          errorDetail: [gumtreeError, facebookError].filter(Boolean).join(" | ") || null,
          nextAction:
            failedSources.length > 0
              ? "Retry on next scheduled cycle; inspect transport/scraper logs if repeated"
              : "Continue next scheduled cycle",
          details: {
            watch: watch.name,
            keyword,
            parsed: parsed.length,
            gumtreeLocal: localParsed.length,
            gumtreeRecentLocal: recentLocalParsed.length,
            gumtreeMatched: gumtreeMatches.length,
            facebookMatched: facebookMatches.length,
            ruleFiltered,
            matched: matches.length,
            new: newEntries.length,
            queued: newEntries.length,
            skippedDuplicates: skipped,
            failedSources
          }
        });
      }

      // The pending set is the single source of truth for what still owes a
      // send: this cycle's new matches plus anything an earlier cycle failed to
      // deliver. Nothing is lost by recording matches before the send succeeds.
      const pending = this.store.pendingDelivery(watch.name);
      const batch = pending.slice(0, MAX_LISTINGS_PER_ALERT);
      const deferred = pending.length - batch.length;

      if (batch.length > 0) {
        const listings = await this.withDetail(batch.map(entryToListing));
        try {
          await withRetry(
            () => this.notifier.sendListingAlertBatch(this.watchDisplayName(watch), listings),
            this.config.retryAttempts,
            this.config.retryDelayMs,
            `notify:${watch.name}`
          );
          await this.store.markDelivered(batch.map((entry) => entry.url));
          const backlogNote = deferred > 0 ? `, ${deferred} deferred to next cycle` : "";
          console.log(
            `Grouped alert sent for ${batch.length} ${this.watchDisplayName(watch)} listing(s)${backlogNote}`
          );
        } catch (error) {
          failedKeywords += 1;
          const message = describeError(error);
          console.error(`Delivery failed for watch '${watch.name}': ${message}`);
          await this.diagnostics.write({
            timestamp: new Date().toISOString(),
            runRef,
            outcome: "failure",
            transportReadiness,
            errorDetail: message,
            nextAction: "Listings remain pending delivery and will be retried next cycle",
            details: { watch: watch.name, pendingDelivery: pending.length }
          });
        }
      } else if (this.config.marketWatchSendNoChanges || watch.noChange) {
        const schedule = process.env.MARKET_WATCH_SCHEDULE || "*/10 * * * * (every 10 mins)";
        await this.notifier.sendText(
          `🔔 Market update: ${this.watchDisplayName(watch)} — cron ${schedule}\n\nNo new listings. Checked ${watch.terms.length} terms, ${totalMatched} current matches already seen. Cache size: ${this.store.count()}.`
        );
        console.log(`No-change alert sent for ${watch.name} (new this cycle: ${newThisWatch})`);
      }
    }

    await this.updateHealth(failedKeywords, sourceFailures, workerDetail);
    this.runtimeStats.markCycleComplete({ ok: failedKeywords === 0, failedKeywords });
  }

  /**
   * Turn repeated failure into one message rather than silence. Latched, so a
   * long outage produces a single degraded alert and a single recovery alert.
   */
  private async updateHealth(
    failedKeywords: number,
    sourceFailures: number,
    workerDetail: string
  ): Promise<void> {
    if (failedKeywords === 0) {
      const { recoveredFromDegraded } = await this.health.recordSuccess();
      if (recoveredFromDegraded) {
        await this.notifier
          .sendText("✅ Market watcher recovered — scraping and delivery are working again.")
          .catch((error: unknown) => console.error(`Recovery alert failed: ${describeError(error)}`));
        console.log("Recovery alert sent");
      }
      return;
    }

    const state = await this.health.recordFailure();
    if (!this.health.shouldSendDegradedAlert(this.config.degradedAlertAfterFailures)) {
      return;
    }

    const since = state.firstFailureAt ? new Date(state.firstFailureAt).toISOString() : "unknown";
    const message = [
      "⚠️ Market watcher degraded",
      "",
      `Failing since ${since} (${state.consecutiveFailures} consecutive cycles).`,
      `${sourceFailures} source failure(s) this cycle.`,
      `Browser worker: ${workerDetail}`,
      "",
      "Listings matched during the outage are held and will be sent once delivery recovers."
    ].join("\n");

    try {
      await this.notifier.sendText(message);
      await this.health.markDegradedAlertSent();
      console.log("Degraded alert sent");
    } catch (error) {
      // If WhatsApp itself is the broken part there is nowhere left to shout.
      console.error(`Degraded alert could not be delivered: ${describeError(error)}`);
    }
  }

  private watchDisplayName(watch: Pick<MarketWatch, "name" | "terms">): string {
    return `${watch.name} (terms: ${watch.terms.join(", ")})`;
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

    const readyTransport = transportReadiness.mode === "openclaw" || transportReadiness.mode === "webhook";
    if (!readyTransport || !transportReadiness.ready) {
      const errorDetail =
        "Canary readiness gate failed: requires transportReadiness.mode=openclaw|webhook and transportReadiness.ready=true";
      console.error(errorDetail);
      await this.diagnostics.write({
        timestamp: new Date().toISOString(),
        runRef,
        outcome: "failure",
        transportReadiness,
        errorDetail,
        nextAction:
          "Escalate immediately: canary cannot validate delivery path until openclaw or webhook transport readiness is restored",
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
          `Canary fixture returned ${matches.length} matches for keyword '${this.config.deliveryCanaryKeyword}', expected ≥ 1`
        );
      }

      const canaryEntry = matches[0];
      if (this.store.has(canaryEntry.url)) {
        console.log("Delivery canary: URL already in dedupe store, skipping delivery test");
        return true;
      }

      await this.notifier.sendListingAlert(canaryEntry);
      await this.store.addEntry({
        url: canaryEntry.url,
        title: canaryEntry.title,
        matchedKeyword: canaryEntry.matchedKeyword,
        watchName: "delivery canary",
        source: canaryEntry.source,
        price: canaryEntry.price,
        location: canaryEntry.location
      });
      details.sent = 1;
      console.log(`Delivery canary passed: matched=${matches.length}, sent=1, keyword='${this.config.deliveryCanaryKeyword}'`);
      await this.diagnostics.write({
        timestamp: new Date().toISOString(),
        runRef,
        outcome: "success",
        transportReadiness,
        errorDetail: null,
        nextAction: "Continue next scheduled cycle",
        details
      });
      return true;
    } catch (error) {
      const message = describeError(error);
      console.error(`Delivery canary failed: ${message}`);
      await this.diagnostics.write({
        timestamp: new Date().toISOString(),
        runRef,
        outcome: "failure",
        transportReadiness,
        errorDetail: `canary: ${message}`,
        nextAction: "Escalate immediately: delivery path is broken",
        details
      });
      return false;
    }
  }
}