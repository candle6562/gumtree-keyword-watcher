import { describe, expect, it } from "vitest";
import { loadConfig, normalizeWhatsappAddress, parseKeywords } from "../src/config.js";

describe("parseKeywords", () => {
  it("includes the default keyword and deduplicates", () => {
    expect(parseKeywords("chainsaw,lawnmower, strimmer")).toEqual([
      "lawnmower",
      "chainsaw",
      "strimmer"
    ]);
  });

  it("allows disabling the default keyword", () => {
    expect(parseKeywords("robot mower, automower", "")).toEqual(["robot mower", "automower"]);
  });
});

describe("loadConfig", () => {
  it("parses required fields", () => {
    const config = loadConfig({
      POSTCODE: "SW1A 1AA",
      WHATSAPP_TO: "whatsapp:+447700900000",
      WHATSAPP_FROM: "whatsapp:+14155238886",
      TWILIO_ACCOUNT_SID: "ACxxx",
      TWILIO_AUTH_TOKEN: "token",
      KEYWORDS: "shed"
    });

    expect(config.keywords).toEqual(["lawnmower", "shed"]);
    expect(config.postcode).toBe("SW1A 1AA");
    expect(config.scrapeIntervalSeconds).toBe(3600);
    expect(config.healthMetricsEnabled).toBe(false);
    expect(config.healthMetricsHost).toBe("127.0.0.1");
    expect(config.healthMetricsPort).toBe(9464);
    expect(config.dedupeRetentionDays).toBe(30);
    expect(config.dedupeMaxEntries).toBe(5000);
    expect(config.deliveryCanaryEnabled).toBe(true);
    expect(config.deliveryCanaryKeyword).toBe("lawnmower");
  });

  it("normalizes UK-local WhatsApp destination input", () => {
    const config = loadConfig({
      POSTCODE: "NE30 3SB",
      WHATSAPP_TO: "07791851722",
      WHATSAPP_FROM: "whatsapp:+14155238886",
      TWILIO_ACCOUNT_SID: "ACxxx",
      TWILIO_AUTH_TOKEN: "token",
      KEYWORDS: "lawnmower"
    });

    expect(config.whatsappTo).toBe("whatsapp:+447791851722");
  });

  it("allows webhook mode without twilio credentials", () => {
    const config = loadConfig({
      POSTCODE: "NE30 3SB",
      WHATSAPP_TO: "07791851722",
      WHATSAPP_ALERT_WEBHOOK_URL: "https://example.com/webhook",
      KEYWORDS: "lawnmower"
    });

    expect(config.whatsappAlertWebhookUrl).toBe("https://example.com/webhook");
  });

  it("defaults canary off in dry-run mode", () => {
    const config = loadConfig({
      POSTCODE: "NE30 3SB",
      WHATSAPP_TO: "07791851722",
      DRY_RUN: "true",
      KEYWORDS: "lawnmower"
    });

    expect(config.deliveryCanaryEnabled).toBe(false);
  });

  it("supports explicit canary enablement in dry-run mode", () => {
    const config = loadConfig({
      POSTCODE: "NE30 3SB",
      WHATSAPP_TO: "07791851722",
      DRY_RUN: "true",
      DELIVERY_CANARY_ENABLED: "true",
      KEYWORDS: "lawnmower"
    });

    expect(config.deliveryCanaryEnabled).toBe(true);
  });

  it("throws when no notifier mode configured", () => {
    expect(() =>
      loadConfig({
        POSTCODE: "NE30 3SB",
        WHATSAPP_TO: "07791851722",
        KEYWORDS: "lawnmower"
      })
    ).toThrow("Configure WHATSAPP_ALERT_WEBHOOK_URL, OPENCLAW_GATEWAY_TOKEN, or TWILIO_ACCOUNT_SID+TWILIO_AUTH_TOKEN");
  });

  it("requires token when binding observability to non-loopback host", () => {
    expect(() =>
      loadConfig({
        POSTCODE: "NE30 3SB",
        WHATSAPP_TO: "07791851722",
        KEYWORDS: "lawnmower",
        DRY_RUN: "true",
        HEALTH_METRICS_ENABLED: "true",
        HEALTH_METRICS_HOST: "0.0.0.0"
      })
    ).toThrow("HEALTH_METRICS_TOKEN is required when HEALTH_METRICS_HOST is not loopback");
  });
});

describe("normalizeWhatsappAddress", () => {
  it("keeps explicit whatsapp addresses", () => {
    expect(normalizeWhatsappAddress("whatsapp:+447700900000")).toBe("whatsapp:+447700900000");
  });
});
