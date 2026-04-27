import { z } from "zod";

const envSchema = z.object({
  POSTCODE: z.string().trim().min(1, "POSTCODE is required"),
  WHATSAPP_TO: z.string().trim().min(1, "WHATSAPP_TO is required"),
  WHATSAPP_FROM: z.string().trim().default("whatsapp:+14155238886"),
  TWILIO_ACCOUNT_SID: z.string().trim().optional(),
  TWILIO_AUTH_TOKEN: z.string().trim().optional(),
  WHATSAPP_ALERT_WEBHOOK_URL: z.string().trim().optional(),
  WHATSAPP_ALERT_WEBHOOK_TOKEN: z.string().trim().optional(),
  KEYWORDS: z.string().trim().optional(),
  SCRAPE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3600),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  RETRY_ATTEMPTS: z.coerce.number().int().positive().default(3),
  RETRY_DELAY_MS: z.coerce.number().int().positive().default(1000),
  DATA_PATH: z.string().trim().default(".data/seen-listings.json"),
  DEDUPE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  DEDUPE_MAX_ENTRIES: z.coerce.number().int().positive().default(5000),
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
  dedupeRetentionDays: number;
  dedupeMaxEntries: number;
  diagnosticsLogPath: string;
  deliveryCanaryEnabled: boolean;
  deliveryCanaryFixturePath: string;
  deliveryCanaryKeyword: string;
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
  dryRun: boolean;
}

export function parseKeywords(raw: string | undefined): string[] {
  const extras = (raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(["lawnmower", ...extras]));
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
    // UK-local style input like 07791851722 -> +447791851722
    return `whatsapp:+44${compact.slice(1)}`;
  }
  if (/^\d+$/.test(compact)) {
    return `whatsapp:+${compact}`;
  }

  throw new Error("WHATSAPP_TO must be a valid phone number or whatsapp:+E164");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const hasWebhook = Boolean(parsed.WHATSAPP_ALERT_WEBHOOK_URL);
  const hasTwilio = Boolean(parsed.TWILIO_ACCOUNT_SID && parsed.TWILIO_AUTH_TOKEN);

  if (!parsed.DRY_RUN && !hasWebhook && !hasTwilio) {
    throw new Error(
      "Configure either WHATSAPP_ALERT_WEBHOOK_URL or TWILIO_ACCOUNT_SID+TWILIO_AUTH_TOKEN (or set DRY_RUN=true)"
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
    keywords: parseKeywords(parsed.KEYWORDS),
    scrapeIntervalSeconds: parsed.SCRAPE_INTERVAL_SECONDS,
    httpTimeoutMs: parsed.HTTP_TIMEOUT_MS,
    retryAttempts: parsed.RETRY_ATTEMPTS,
    retryDelayMs: parsed.RETRY_DELAY_MS,
    dataPath: parsed.DATA_PATH,
    dedupeRetentionDays: parsed.DEDUPE_RETENTION_DAYS,
    dedupeMaxEntries: parsed.DEDUPE_MAX_ENTRIES,
    diagnosticsLogPath: parsed.DIAGNOSTICS_LOG_PATH,
    deliveryCanaryEnabled,
    deliveryCanaryFixturePath: parsed.DELIVERY_CANARY_FIXTURE_PATH,
    deliveryCanaryKeyword: parsed.DELIVERY_CANARY_KEYWORD.trim().toLowerCase(),
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
    dryRun: parsed.DRY_RUN
  };
}
