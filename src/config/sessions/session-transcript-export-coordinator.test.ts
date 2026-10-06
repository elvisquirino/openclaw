import { describe, expect, it, vi } from "vitest";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { TranscriptExportCoordinator } from "./session-transcript-export-coordinator.js";

function createDeferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createLogger() {
  const logger: SubsystemLogger = {
    subsystem: "test",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => logger,
  };
  return logger;
}

describe("TranscriptExportCoordinator", () => {
  it("coalesces equivalent work and isolates every mutable result", async () => {
    const logger = createLogger();
    const coordinator = new TranscriptExportCoordinator(logger);
    const deferred = createDeferred<{ rows: Array<{ value: number }> }>();
    const operation = vi.fn(() => deferred.promise);

    const reads = Array.from({ length: 20 }, () =>
      coordinator.run({
        key: { sessionId: "same", projection: "entry" },
        telemetry: { caller: "test", sessionId: "same", sessionKey: "agent:main:same" },
        operation,
        size: (value) => ({ rows: value.rows.length }),
      }),
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot()).toEqual({
      coalescedReads: 19,
      inFlight: 1,
      physicalExports: 1,
    });

    deferred.resolve({ rows: [{ value: 1 }] });
    const results = await Promise.all(reads);
    expect(new Set(results).size).toBe(results.length);
    expect(new Set(results.map((result) => result.rows)).size).toBe(results.length);
    results[0]!.rows[0]!.value = 99;
    expect(results.slice(1).every((result) => result.rows[0]!.value === 1)).toBe(true);
    expect(coordinator.getSnapshot().inFlight).toBe(0);
    expect(logger.debug).toHaveBeenCalledWith(
      "Session transcript export completed",
      expect.objectContaining({
        caller: "test",
        coalesced: true,
        rows: 1,
        sessionId: "same",
        sessionKey: "agent:main:same",
      }),
    );
  });

  it("does not coalesce distinct keys", async () => {
    const coordinator = new TranscriptExportCoordinator(createLogger());
    const operation = vi.fn(async () => ({ value: 1 }));
    await Promise.all(
      ["a", "b"].map((sessionId) =>
        coordinator.run({
          key: { sessionId },
          telemetry: { caller: "test", sessionId },
          operation,
          size: () => ({}),
        }),
      ),
    );
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("forgets failed work so a later request can retry", async () => {
    const logger = createLogger();
    const coordinator = new TranscriptExportCoordinator(logger);
    const failure = createDeferred<{ value: number }>();
    const operation = vi
      .fn<() => Promise<{ value: number }>>()
      .mockImplementationOnce(() => failure.promise)
      .mockResolvedValueOnce({ value: 2 });
    const input = {
      key: { sessionId: "retry" },
      telemetry: { caller: "test", sessionId: "retry" },
      operation,
      size: () => ({}),
    };
    const first = coordinator.run(input);
    const joined = coordinator.run(input);
    failure.reject(new Error("expected failure"));
    await expect(first).rejects.toThrow("expected failure");
    await expect(joined).rejects.toThrow("expected failure");
    await expect(coordinator.run(input)).resolves.toEqual({ value: 2 });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot()).toEqual({
      coalescedReads: 1,
      inFlight: 0,
      physicalExports: 2,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Session transcript export failed",
      expect.objectContaining({ caller: "test", coalesced: true, sessionId: "retry" }),
    );
  });
});
