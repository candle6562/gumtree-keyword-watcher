import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TransportReadinessSignal } from "./notifier.js";

export interface DiagnosticsEntry {
  timestamp: string;
  runRef: string;
  outcome: "success" | "failure";
  transportReadiness: TransportReadinessSignal;
  errorDetail: string | null;
  nextAction: string;
  details: Record<string, unknown>;
}

export class DiagnosticsSink {
  constructor(private readonly filePath: string) {}

  async write(entry: DiagnosticsEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    await appendFile(this.filePath, line, "utf8");
  }
}
