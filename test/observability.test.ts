import { afterEach, describe, expect, it } from "vitest";
import { createObservabilityServer, RuntimeStats } from "../src/observability.js";

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0, servers.length)) {
    server.close();
  }
});

async function startServer(
  options: {
    token?: string;
    maxStalenessSeconds?: number;
  } = {}
): Promise<{ baseUrl: string; runtimeStats: RuntimeStats }> {
  const runtimeStats = new RuntimeStats();
  const server = createObservabilityServer(
    {
      healthMetricsHost: "127.0.0.1",
      healthMetricsPort: 0,
      healthMetricsToken: options.token,
      healthMaxStalenessSeconds: options.maxStalenessSeconds ?? 0
    },
    runtimeStats
  );

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push(server);

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }

  return { baseUrl: `http://127.0.0.1:${address.port}`, runtimeStats };
}

describe("observability server", () => {
  it("returns 503 health before first completed cycle", async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("starting");
  });

  it("returns health ok and prometheus metrics after successful cycle", async () => {
    const { baseUrl, runtimeStats } = await startServer();
    runtimeStats.markCycleStart(Date.now() - 1000);
    runtimeStats.markCycleComplete({ ok: true, failedKeywords: 0 }, Date.now() - 500);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    expect(healthBody.status).toBe("ok");

    const metrics = await fetch(`${baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
    const raw = await metrics.text();
    expect(raw).toContain("gumtree_watcher_cycles_total 1");
    expect(raw).toContain("gumtree_watcher_cycle_failures_total 0");
  });

  it("returns 503 health when last cycle failed", async () => {
    const { baseUrl, runtimeStats } = await startServer();
    runtimeStats.markCycleStart();
    runtimeStats.markCycleComplete({ ok: false, failedKeywords: 2 });

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect(body.lastCycleFailedKeywords).toBe(2);
  });

  it("returns 503 stale health when max staleness is exceeded", async () => {
    const { baseUrl, runtimeStats } = await startServer({ maxStalenessSeconds: 1 });
    runtimeStats.markCycleStart(Date.now() - 5_000);
    runtimeStats.markCycleComplete({ ok: true, failedKeywords: 0 }, Date.now() - 5_000);

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("stale");
  });

  it("requires auth token when configured", async () => {
    const { baseUrl, runtimeStats } = await startServer({ token: "secret-token" });
    runtimeStats.markCycleStart();
    runtimeStats.markCycleComplete({ ok: true, failedKeywords: 0 });

    const unauthorized = await fetch(`${baseUrl}/health`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: "Bearer secret-token" }
    });
    expect(authorized.status).toBe(200);
  });

  it("rejects unsupported methods and unknown routes", async () => {
    const { baseUrl } = await startServer();

    const methodResponse = await fetch(`${baseUrl}/health`, { method: "POST" });
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("GET, HEAD");

    const notFound = await fetch(`${baseUrl}/unknown`);
    expect(notFound.status).toBe(404);
  });
});
