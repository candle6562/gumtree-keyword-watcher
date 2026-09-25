import { z } from "zod";
import { loadWatches, primaryWatch } from "./watches.js";

const envSchema = z.object({
  POSTCODE: z.string().trim().min(1, "POSTCODE is required"),
  WHATSAPP_TO: z.string().trim().min(1, "WHATSAPP_TO is required"),
  WHATSAPP_FROM: z.string().trim().default("whatsapp:+14155238886"),
  TWILIO_ACCOUNT_SID: z.string().trim().optional(),
  TWILIO_AUTH_TOKEN: z.string().trim().optional(),
  WHATSAPP_ALERT_WEBHOOK_URL: z.string().trim().optional(),
  WHATSAPP_ALERT_WEBHOOK_TOKEN: z.string().trim().optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().trim().optional(),
  OPENCLAW_TOOL_URL: z.string().trim().default("http://127.0.0.1:28889/tools/invoke"),
  WINDOWS_BROWSER_URL: z.string().url().optional(),
  WINDOWS_BROWSER_TOKEN: z.string().trim().optional(),
  WINDOWS_BROWSER_AUTOSTART_COMMAND: z.string().trim().default('/mnt/c/Windows/System32/schtasks.exe /Run /TN WindowsBrowser'),
  BROWSER_WORKER_URL: z.string().trim().default("http://100.95.126.123:3877"),
  BROWSER_WORKER_TOKEN: z.string().trim().optional(),
  BROWSER_WORKER_AUTOSTART_ENABLED: z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      if (value === undefined) return true;
      return value === "1" || value.toLowerCase() === "true";
    }),
  // The worker runs natively on the Windows host; WSL reaches it through interop.
  BROWSER_WORKER_AUTOSTART_COMMAND: z
    .string()
    .trim()
    .default('/mnt/c/Windows/System32/cmd.exe /c "cd /d C:\\fb-browser-worker && npm.cmd run start:if-needed"'),
  BROWSER_WORKER_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  BROWSER_WORKER_STARTUP_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),
  BROWSER_WORKER_RESTART_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(300000),
  HEALTH_STATE_PATH: z.string().trim().default(".data/health-state.json"),
  DETAIL_FETCH_ENABLED: z
    .string()
    .trim()
    .optional()
    .transform((value) => value === "1" || value?.toLowerCase() === "true"),
  DETAIL_MAX_PER_CYCLE: z.coerce.number().int().nonnegative().default(15),
  DETAIL_DELAY_MS: z.coerce.number().int().nonnegative().default(1500),
  DETAIL_CACHE_PATH: z.string().trim().default(".data/listing-details.json"),
  OPENROUTER_API_KEY: z.string().trim().optional(),
  OPENROUTER_TEXT_MODEL: z.string().trim().default("deepseek/deepseek-v4-flash-0731"),
  // DeepSeek is text-only, so plate reading needs a separate vision model.
  OPENROUTER_VISION_MODEL: z.string().trim().default("google/gemini-2.5-flash-lite"),
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),
  // Photo analysis is only used to read number plates. Off by default: cheap
  // (~$0.00007/listing) but an extra failure mode, and descriptions carry most
  // of the signal. Turn on when text-only triage produces too many false hits.
  TRIAGE_VISION_ENABLED: z
    .string()
    .trim()
    .optional()
    .transform((value) => value === "1" || value?.toLowerCase() === "true"),
  TRIAGE_VISION_MIN_SCORE: z.coerce.number().int().min(0).max(100).default(60),
  TRIAGE_CACHE_PATH: z.string().trim().default(".data/triage-results.json"),
  TRIAGE_SPEC_DIR: z.string().trim().default("config/specs"),
  DEGRADED_ALERT_AFTER_FAILURES: z.coerce.number().int().positive().default(3),
  MARKETPLACE_AREA_ID: z.string().trim().optional(),
  MARKET_WATCHES_FILE: z.string().trim().optional(),
  MARKETPLACE_FACEBOOK_ENABLED: z
    .string()
    .trim()
    .optional()
    .transform((value) => value === "1" || value?.toLowerCase() === "true"),
  SCRAPE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3600),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  RETRY_ATTEMPTS: z.coerce.number().int().positive().default(3),
  RETRY_DELAY_MS: z.coerce.number().int().positive().default(1000),
  DATA_PATH: z.string().trim().default(".data/seen-listings.json"),
  // Six months, not the thirty days a pure dedupe cache needed. The store now
  // also holds price history, and a drop is measured against what a listing
  // asked when we first saw it — evicting that would lose the comparison.
  // Gap between keywords within a cycle. A watch with several terms otherwise
  // fires them all at once, which reads as a burst to the source.
  //
  // Twenty seconds, because four was not enough: five terms at four-second
  // spacing still drew a Gumtree challenge after the second keyword. Five terms
  // now spread over eighty seconds, comfortably inside a ten-minute cycle.
  KEYWORD_SPACING_MS: z.coerce.number().int().nonnegative().default(20000),
  DEDUPE_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
  // Every sweep records the whole in-range market, not just what was alerted,
  // so the ceiling has to clear the size of that market with room to spare.
  DEDUPE_MAX_ENTRIES: z.coerce.number().int().positive().default(20000),
  DIAGNOSTICS_LOG_PATH: z.string().trim().default(".data/diagnostics.log"),
  DELIVERY_CANARY_ENABLED: z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      if (value === undefined) {
        return undefined;
      }
      return value === "1" || value.toLowerCase() === "true";
    }),
  DELIVERY_CANARY_FIXTURE_PATH: z.string().trim().default("test/fixtures/gumtree-search-stable.html"),
  DELIVERY_CANARY_KEYWORD: z.string().trim().min(1).default("lawnmower"),
  MARKET_WATCH_GROUP_NAME: z.string().trim().min(1).default("market watch"),
  MARKET_WATCH_SEND_NO_CHANGES: z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      return value === "1" || value.toLowerCase() === "true";
    }),
  HEALTH_METRICS_ENABLED: z
    .string()
    .trim()
    .optional()
    .transform((value) => value === "1" || value?.toLowerCase() === "true"),
  HEALTH_METRICS_HOST: z.string().trim().default("127.0.0.1"),
  HEALTH_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  HEALTH_METRICS_TOKEN: z.string().trim().optional(),
  HEALTH_MAX_STALENESS_SECONDS: z.coerce.number().int().nonnegative().default(0),
  DRY_RUN: z
    .string()
    .trim()
    .optional()
    .transform((value) => value === "1" || value?.toLowerCase() === "true")
});

export interface AppConfig {
  postcode: string;
  keywords: string[];
  scrapeIntervalSeconds: number;
  httpTimeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  dataPath: string;
  keywordSpacingMs: number;
  dedupeRetentionDays: number;
  dedupeMaxEntries: number;
  diagnosticsLogPath: string;
  deliveryCanaryEnabled: boolean;
  deliveryCanaryFixturePath: string;
  deliveryCanaryKeyword: string;
  marketWatchGroupName: string;
  marketWatchSendNoChanges: boolean;
  healthMetricsEnabled: boolean;
  healthMetricsHost: string;
  healthMetricsPort: number;
  healthMetricsToken?: string;
  healthMaxStalenessSeconds: number;
  whatsappTo: string;
  whatsappFrom: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  whatsappAlertWebhookUrl?: string;
  whatsappAlertWebhookToken?: string;
  openclawGatewayToken?: string;
  openclawToolUrl: string;
  dryRun: boolean;
  browserWorkerUrl: string;
  browserWorkerToken?: string;
  browserWorkerAutostartEnabled: boolean;
  browserWorkerAutostartCommand: string;
  browserWorkerHealthTimeoutMs: number;
  browserWorkerStartupTimeoutMs: number;
  browserWorkerRestartCooldownMs: number;
  healthStatePath: string;
  degradedAlertAfterFailures: number;
  detailFetchEnabled: boolean;
  detailMaxPerCycle: number;
  detailDelayMs: number;
  detailCachePath: string;
  openrouterApiKey?: string;
  openrouterTextModel: string;
  openrouterVisionModel: string;
  openrouterTimeoutMs: number;
  triageVisionEnabled: boolean;
  triageVisionMinScore: number;
  triageCachePath: string;
  triageSpecDir: string;
  marketplaceAreaId?: string;
  marketplaceFacebookEnabled: boolean;
}

export function normalizeWhatsappAddress(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error("WHATSAPP_TO is required");
  }
  if (value.startsWith("whatsapp:")) {
    return value;
  }

  const compact = value.replace(/\s+/g, "");
  if (compact.startsWith("+")) {
    return `whatsapp:${compact}`;
  }
  if (compact.startsWith("00")) {
    return `whatsapp:+${compact.slice(2)}`;
  }
  if (/^0\d+$/.test(compact)) {
    return `whatsapp:+44${compact.slice(1)}`;
  }
  if (/^\d+$/.test(compact)) {
    return `whatsapp:+${compact}`;
  }

  throw new Error("WHATSAPP_TO must be a valid phone number or whatsapp:+E164");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const watch = primaryWatch(loadWatches(parsed.MARKET_WATCHES_FILE));
  const hasWebhook = Boolean(parsed.WHATSAPP_ALERT_WEBHOOK_URL);
  const hasTwilio = Boolean(parsed.TWILIO_ACCOUNT_SID && parsed.TWILIO_AUTH_TOKEN);
  const hasOpenClaw = Boolean(parsed.OPENCLAW_GATEWAY_TOKEN);

  if (!parsed.DRY_RUN && !hasWebhook && !hasTwilio && !hasOpenClaw) {
    throw new Error(
      "Configure WHATSAPP_ALERT_WEBHOOK_URL, OPENCLAW_GATEWAY_TOKEN, or TWILIO_ACCOUNT_SID+TWILIO_AUTH_TOKEN (or set DRY_RUN=true)"
    );
  }

  const host = parsed.HEALTH_METRICS_HOST.toLowerCase();
  const isLoopbackHost = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (parsed.HEALTH_METRICS_ENABLED && !isLoopbackHost && !parsed.HEALTH_METRICS_TOKEN) {
    throw new Error("HEALTH_METRICS_TOKEN is required when HEALTH_METRICS_HOST is not loopback");
  }

  const deliveryCanaryEnabled = parsed.DELIVERY_CANARY_ENABLED ?? !parsed.DRY_RUN;

  return {
    postcode: parsed.POSTCODE,
    keywords: watch?.terms.length ? watch.terms : [parsed.MARKET_WATCH_GROUP_NAME.trim().toLowerCase()],
    scrapeIntervalSeconds: parsed.SCRAPE_INTERVAL_SECONDS,
    httpTimeoutMs: parsed.HTTP_TIMEOUT_MS,
    retryAttempts: parsed.RETRY_ATTEMPTS,
    retryDelayMs: parsed.RETRY_DELAY_MS,
    dataPath: parsed.DATA_PATH,
    keywordSpacingMs: parsed.KEYWORD_SPACING_MS,
    dedupeRetentionDays: parsed.DEDUPE_RETENTION_DAYS,
    dedupeMaxEntries: parsed.DEDUPE_MAX_ENTRIES,
    diagnosticsLogPath: parsed.DIAGNOSTICS_LOG_PATH,
    deliveryCanaryEnabled,
    deliveryCanaryFixturePath: parsed.DELIVERY_CANARY_FIXTURE_PATH,
    deliveryCanaryKeyword: parsed.DELIVERY_CANARY_KEYWORD.trim().toLowerCase(),
    marketWatchGroupName: watch?.name || parsed.MARKET_WATCH_GROUP_NAME,
    marketWatchSendNoChanges: parsed.MARKET_WATCH_SEND_NO_CHANGES ?? watch?.noChange ?? false,
    healthMetricsEnabled: parsed.HEALTH_METRICS_ENABLED,
    healthMetricsHost: parsed.HEALTH_METRICS_HOST,
    healthMetricsPort: parsed.HEALTH_METRICS_PORT,
    healthMetricsToken: parsed.HEALTH_METRICS_TOKEN,
    healthMaxStalenessSeconds: parsed.HEALTH_MAX_STALENESS_SECONDS,
    whatsappTo: normalizeWhatsappAddress(parsed.WHATSAPP_TO),
    whatsappFrom: parsed.WHATSAPP_FROM,
    twilioAccountSid: parsed.TWILIO_ACCOUNT_SID,
    twilioAuthToken: parsed.TWILIO_AUTH_TOKEN,
    whatsappAlertWebhookUrl: parsed.WHATSAPP_ALERT_WEBHOOK_URL,
    whatsappAlertWebhookToken: parsed.WHATSAPP_ALERT_WEBHOOK_TOKEN,
    openclawGatewayToken: parsed.OPENCLAW_GATEWAY_TOKEN,
    openclawToolUrl: parsed.OPENCLAW_TOOL_URL,
    dryRun: parsed.DRY_RUN ?? false,
    browserWorkerUrl: parsed.WINDOWS_BROWSER_URL || parsed.BROWSER_WORKER_URL,
    browserWorkerToken: parsed.WINDOWS_BROWSER_TOKEN || parsed.BROWSER_WORKER_TOKEN,
    browserWorkerAutostartEnabled: parsed.BROWSER_WORKER_AUTOSTART_ENABLED,
    browserWorkerAutostartCommand: parsed.WINDOWS_BROWSER_URL
      ? parsed.WINDOWS_BROWSER_AUTOSTART_COMMAND
      : parsed.BROWSER_WORKER_AUTOSTART_COMMAND,
    browserWorkerHealthTimeoutMs: parsed.BROWSER_WORKER_HEALTH_TIMEOUT_MS,
    browserWorkerStartupTimeoutMs: parsed.BROWSER_WORKER_STARTUP_TIMEOUT_MS,
    browserWorkerRestartCooldownMs: parsed.BROWSER_WORKER_RESTART_COOLDOWN_MS,
    healthStatePath: parsed.HEALTH_STATE_PATH,
    detailFetchEnabled: parsed.DETAIL_FETCH_ENABLED ?? false,
    detailMaxPerCycle: parsed.DETAIL_MAX_PER_CYCLE,
    detailDelayMs: parsed.DETAIL_DELAY_MS,
    detailCachePath: parsed.DETAIL_CACHE_PATH,
    openrouterApiKey: parsed.OPENROUTER_API_KEY,
    openrouterTextModel: parsed.OPENROUTER_TEXT_MODEL,
    openrouterVisionModel: parsed.OPENROUTER_VISION_MODEL,
    openrouterTimeoutMs: parsed.OPENROUTER_TIMEOUT_MS,
    triageVisionEnabled: parsed.TRIAGE_VISION_ENABLED ?? false,
    triageVisionMinScore: parsed.TRIAGE_VISION_MIN_SCORE,
    triageCachePath: parsed.TRIAGE_CACHE_PATH,
    triageSpecDir: parsed.TRIAGE_SPEC_DIR,
    degradedAlertAfterFailures: parsed.DEGRADED_ALERT_AFTER_FAILURES,
    marketplaceAreaId: parsed.MARKETPLACE_AREA_ID,
    marketplaceFacebookEnabled: parsed.MARKETPLACE_FACEBOOK_ENABLED ?? false,
  };
}