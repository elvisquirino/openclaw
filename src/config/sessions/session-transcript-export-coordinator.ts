import { stableStringify } from "@openclaw/normalization-core";
import type { SubsystemLogger } from "../../logging/subsystem.js";

export type TranscriptExportTelemetry = {
  caller: string;
  sessionId: string;
  sessionKey?: string;
};

type PendingExport<Value> = {
  promise: Promise<Value>;
  readers: number;
};

type TranscriptExportCoordinatorSnapshot = {
  coalescedReads: number;
  inFlight: number;
  physicalExports: number;
};

/** In-flight only: completed snapshots are never cached past their current receivers. */
export class TranscriptExportCoordinator {
  private readonly pending = new Map<string, PendingExport<unknown>>();
  private coalescedReads = 0;
  private physicalExports = 0;

  constructor(private readonly log: SubsystemLogger) {}

  getSnapshot(): TranscriptExportCoordinatorSnapshot {
    return {
      coalescedReads: this.coalescedReads,
      inFlight: this.pending.size,
      physicalExports: this.physicalExports,
    };
  }

  async run<Value>(params: {
    key: unknown;
    telemetry: TranscriptExportTelemetry;
    operation: () => Promise<Value>;
    size: (value: Value) => Record<string, number | undefined>;
  }): Promise<Value> {
    const startedAt = performance.now();
    const key = stableStringify(params.key);
    // SAFETY: one stable key is only populated by the same generic run contract while in flight.
    let pending = this.pending.get(key) as PendingExport<Value> | undefined;
    const coalesced = pending !== undefined;
    if (pending) {
      this.coalescedReads++;
    } else {
      this.physicalExports++;
      const promise = params.operation();
      pending = { promise, readers: 0 };
      // SAFETY: values are only recovered through the matching key-specific assertion above.
      this.pending.set(key, pending as PendingExport<unknown>);
      void promise
        .finally(() => {
          if (this.pending.get(key) === pending) {
            this.pending.delete(key);
          }
        })
        .catch(() => undefined);
    }
    pending.readers++;
    let value: Value;
    try {
      value = await pending.promise;
    } catch (error) {
      pending.readers--;
      this.log.warn("Session transcript export failed", {
        ...params.telemetry,
        coalesced,
        durationMs: Math.round(performance.now() - startedAt),
        error,
      });
      throw error;
    }
    pending.readers--;
    // Only the final receiver gets the worker-owned object; overlapping receivers get clones.
    const isolated = pending.readers === 0 ? value : structuredClone(value);
    const durationMs = Math.round(performance.now() - startedAt);
    const metadata = {
      ...params.telemetry,
      ...params.size(value),
      coalesced,
      durationMs,
      waitMs: coalesced ? durationMs : 0,
    };
    const message = "Session transcript export completed";
    if (durationMs >= 1_000) {
      this.log.info(message, metadata);
    } else {
      this.log.debug(message, metadata);
    }
    return isolated;
  }
}
