import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsappNotifier } from "../src/notifier.js";

describe("WhatsappNotifier", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends webhook payload when webhook mode is configured", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const notifier = new WhatsappNotifier(
      undefined,
      undefined,
      "whatsapp:+14155238886",
      "whatsapp:+447700900000",
      false,
      "https://example.com/webhook",
      "token",
      5_000
    );

    await notifier.sendListingAlert({
      title: "Bosch Lawnmower",
      url: "https://example.com/item/1",
      matchedKeyword: "lawnmower"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = (fetchMock as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("expected fetch to be called");
    }
    const [url, init] = firstCall;
    expect(url).toBe("https://example.com/webhook");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer token"
    });
  });

  it("throws when webhook returns non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const notifier = new WhatsappNotifier(
      undefined,
      undefined,
      "whatsapp:+14155238886",
      "whatsapp:+447700900000",
      false,
      "https://example.com/webhook"
    );

    await expect(
      notifier.sendListingAlert({
        title: "Bosch Lawnmower",
        url: "https://example.com/item/1",
        matchedKeyword: "lawnmower"
      })
    ).rejects.toThrow("Webhook notifier failed: status=503");
  });

  it("reports transport readiness mode", () => {
    const dryRunNotifier = new WhatsappNotifier(
      undefined,
      undefined,
      "whatsapp:+14155238886",
      "whatsapp:+447700900000",
      true
    );
    expect(dryRunNotifier.getTransportReadiness()).toEqual({
      mode: "dry_run",
      ready: false
    });

    const webhookNotifier = new WhatsappNotifier(
      undefined,
      undefined,
      "whatsapp:+14155238886",
      "whatsapp:+447700900000",
      false,
      "https://example.com/webhook"
    );
    expect(webhookNotifier.getTransportReadiness()).toEqual({
      mode: "webhook",
      ready: true
    });

    const unconfiguredNotifier = new WhatsappNotifier(
      undefined,
      undefined,
      "whatsapp:+14155238886",
      "whatsapp:+447700900000",
      false
    );
    expect(unconfiguredNotifier.getTransportReadiness()).toEqual({
      mode: "unconfigured",
      ready: false
    });
  });
});
