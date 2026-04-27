import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config.js";

interface CycleSummary {
  ok: boolean;
  failedKeywords: number;
}

export interface RuntimeSnapshot {
  startedAtMs: number;
  totalCycles: number;
  successfulCycles: number;
  failedCycles: number;
  lastCycleStartedAtMs: number | null;
  lastCycleCompletedAtMs: number | null;
  lastCycleFailedKeywords: number;
  lastCycleOk: boolean | null;
}

export class RuntimeStats {
  private readonly startedAtMs = Date.now();
  private totalCycles = 0;
  private successfulCycles = 0;
  private failedCycles = 0;
  private lastCycleStartedAtMs: number | null = null;
  private lastCycleCompletedAtMs: number | null = null;
  private lastCycleFailedKeywords = 0;
  private lastCycleOk: boolean | null = null;

  markCycleStart(nowMs = Date.now()): void {
    this.lastCycleStartedAtMs = nowMs;
  }

  markCycleComplete(summary: CycleSummary, nowMs = Date.now()): void {
    this.totalCycles += 1;
    this.lastCycleCompletedAtMs = nowMs;
    this.lastCycleFailedKeywords = summary.failedKeywords;
    this.lastCycleOk = summary.ok;
    if (summary.ok) {
      this.successfulCycles += 1;
    } else {
      this.failedCycles += 1;
    }
  }

  snapshot(): RuntimeSnapshot {
    return {
      startedAtMs: this.startedAtMs,
      totalCycles: this.totalCycles,
      successfulCycles: this.successfulCycles,
      failedCycles: this.failedCycles,
      lastCycleStartedAtMs: this.lastCycleStartedAtMs,
      lastCycleCompletedAtMs: this.lastCycleCompletedAtMs,
      lastCycleFailedKeywords: this.lastCycleFailedKeywords,
      lastCycleOk: this.lastCycleOk
    };
  }
}

function writeBaseHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'");
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(actualBuf, expectedBuf);
}

function getProvidedToken(request: IncomingMessage): string | null {
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  const raw = request.headers["x-health-token"];
  if (typeof raw === "string") {
    return raw.trim();
  }
  return null;
}

function getHealthStatus(
  stats: RuntimeSnapshot,
  maxStalenessSeconds: number,
  nowMs = Date.now()
): { code: number; payload: Record<string, unknown> } {
  if (stats.lastCycleCompletedAtMs === null) {
    return {
      code: 503,
      payload: {
        status: "starting",
        reason: "no_completed_cycle",
        uptimeSeconds: Math.floor((nowMs - stats.startedAtMs) / 1000)
      }
    };
  }

  const ageSeconds = Math.floor((nowMs - stats.lastCycleCompletedAtMs) / 1000);
  if (maxStalenessSeconds > 0 && ageSeconds > maxStalenessSeconds) {
    return {
      code: 503,
      payload: {
        status: "stale",
        reason: "last_cycle_too_old",
        lastCycleAgeSeconds: ageSeconds,
        maxStalenessSeconds
      }
    };
  }

  if (stats.lastCycleOk === false) {
    return {
      code: 503,
      payload: {
        status: "degraded",
        reason: "last_cycle_failed",
        lastCycleFailedKeywords: stats.lastCycleFailedKeywords
      }
    };
  }

  return {
    code: 200,
    payload: {
      status: "ok",
      totalCycles: stats.totalCycles,
      successfulCycles: stats.successfulCycles
    }
  };
}

export function createObservabilityServer(
  config: Pick<
    AppConfig,
    "healthMetricsHost" | "healthMetricsPort" | "healthMetricsToken" | "healthMaxStalenessSeconds"
  >,
  runtimeStats: RuntimeStats
): Server {
  return createServer((request, response) => {
    writeBaseHeaders(response);

    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, HEAD");
      response.end();
      return;
    }

    if (config.healthMetricsToken) {
      const provided = getProvidedToken(request);
      if (!provided || !tokenMatches(provided, config.healthMetricsToken)) {
        response.statusCode = 401;
        response.setHeader("WWW-Authenticate", 'Bearer realm="gumtree-observability"');
        response.end();
        return;
      }
    }

    const path = request.url?.split("?")[0] ?? "/";
    const snapshot = runtimeStats.snapshot();
    if (path === "/health") {
      const health = getHealthStatus(snapshot, config.healthMaxStalenessSeconds);
      response.statusCode = health.code;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      const body = JSON.stringify({
        ...health.payload,
        startedAt: new Date(snapshot.startedAtMs).toISOString(),
        lastCycleStartedAt:
          snapshot.lastCycleStartedAtMs === null
            ? null
            : new Date(snapshot.lastCycleStartedAtMs).toISOString(),
        lastCycleCompletedAt:
          snapshot.lastCycleCompletedAtMs === null
            ? null
            : new Date(snapshot.lastCycleCompletedAtMs).toISOString()
      });
      if (method === "HEAD") {
        response.end();
      } else {
        response.end(body);
      }
      return;
    }

    if (path === "/metrics") {
      const now = Date.now();
      const lines = [
        "# HELP gumtree_watcher_uptime_seconds Process uptime in seconds",
        "# TYPE gumtree_watcher_uptime_seconds gauge",
        `gumtree_watcher_uptime_seconds ${Math.floor((now - snapshot.startedAtMs) / 1000)}`,
        "# HELP gumtree_watcher_cycles_total Number of completed scrape cycles",
        "# TYPE gumtree_watcher_cycles_total counter",
        `gumtree_watcher_cycles_total ${snapshot.totalCycles}`,
        "# HELP gumtree_watcher_cycle_failures_total Number of failed scrape cycles",
        "# TYPE gumtree_watcher_cycle_failures_total counter",
        `gumtree_watcher_cycle_failures_total ${snapshot.failedCycles}`,
        "# HELP gumtree_watcher_last_cycle_failed_keywords Number of keywords that failed in last cycle",
        "# TYPE gumtree_watcher_last_cycle_failed_keywords gauge",
        `gumtree_watcher_last_cycle_failed_keywords ${snapshot.lastCycleFailedKeywords}`,
        "# HELP gumtree_watcher_last_cycle_completed_timestamp_seconds Unix timestamp of last completed cycle",
        "# TYPE gumtree_watcher_last_cycle_completed_timestamp_seconds gauge",
        `gumtree_watcher_last_cycle_completed_timestamp_seconds ${
          snapshot.lastCycleCompletedAtMs === null ? 0 : Math.floor(snapshot.lastCycleCompletedAtMs / 1000)
        }`,
        ""
      ];
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      if (method === "HEAD") {
        response.end();
      } else {
        response.end(lines.join("\n"));
      }
      return;
    }

    response.statusCode = 404;
    response.end();
  });
}

export function startObservabilityServer(
  config: Pick<
    AppConfig,
    "healthMetricsHost" | "healthMetricsPort" | "healthMetricsToken" | "healthMaxStalenessSeconds"
  >,
  runtimeStats: RuntimeStats
): Server {
  const server = createObservabilityServer(config, runtimeStats);
  server.listen(config.healthMetricsPort, config.healthMetricsHost);
  return server;
}
