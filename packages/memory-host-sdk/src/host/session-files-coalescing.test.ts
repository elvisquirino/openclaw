import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptEventSync,
  replaceTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import { getSessionTranscriptExportWorkerSnapshot } from "../../../../src/config/sessions/session-transcript-read-worker-runtime.js";
import { WorkerTaskPool } from "../../../../src/infra/worker-task-pool.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../../../src/state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../../../src/state/openclaw-state-db.js";
import { buildSessionEntry } from "./session-files.js";

let tmpDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-export-coalesce-test-"));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", tmpDir);
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", previousStateDir);
  }
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedSession(sessionId: string) {
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: "agent:main:chat:" + sessionId,
    storePath: path.join(tmpDir, sessionId, "sessions", "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  expect(
    replaceTranscriptEventsSync(
      scope,
      Array.from({ length: 64 }, (_, index) => ({
        type: "message",
        id: "message-" + index,
        message: { role: "user", content: "payload " + "x".repeat(2_000) },
      })),
    ),
  ).toBe(true);
  return scope;
}

function openSyntheticDatabasePaths() {
  if (process.platform !== "linux") {
    return new Set<string>();
  }
  const targets = new Set<string>();
  for (const name of fs.readdirSync("/proc/self/fd")) {
    try {
      const target = fs.readlinkSync(path.join("/proc/self/fd", name));
      const match = target.match(/^(.*\.sqlite)(?:-(?:shm|wal))?$/u);
      if (match?.[1]?.startsWith(tmpDir) && path.basename(match[1]) === "openclaw-agent.sqlite") {
        targets.add(match[1]);
      }
    } catch {
      // Descriptors can close between listing and readlink.
    }
  }
  return targets;
}

describe("session transcript export worker resources", () => {
  it("coalesces 20 logical exports into one physical worker operation", async () => {
    const scope = await seedSession("same");
    await closeOpenClawAgentDatabasesAsync();
    const before = getSessionTranscriptExportWorkerSnapshot();
    const run = Reflect.get(WorkerTaskPool.prototype, "run") as typeof WorkerTaskPool.prototype.run;
    let physicalRuns = 0;
    const spy = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(function (
      this: WorkerTaskPool<unknown, unknown>,
      ...args
    ) {
      const input = args[0];
      if (typeof input !== "function" && input.kind === "session-entry") {
        physicalRuns++;
      }
      return Reflect.apply(run, this, args);
    });
    try {
      const entries = await Promise.all(
        Array.from({ length: 20 }, () => buildSessionEntry(scope.sessionKey, scope)),
      );
      expect(entries.every(Boolean)).toBe(true);
      expect(new Set(entries).size).toBe(entries.length);
      expect(physicalRuns).toBe(1);
      const after = getSessionTranscriptExportWorkerSnapshot();
      expect(after.coordinator.physicalExports - before.coordinator.physicalExports).toBe(1);
      expect(after.coordinator.coalescedReads - before.coordinator.coalescedReads).toBe(19);
      expect(after.pool.maxWorkers).toBe(1);
      expect(after.pool.workersCreated - before.pool.workersCreated).toBeLessThanOrEqual(1);
      expect(after.pool.pendingTasks).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not join an older in-flight export after a transcript append", async () => {
    const scope = await seedSession("append-version");
    await closeOpenClawAgentDatabasesAsync();
    const run = Reflect.get(WorkerTaskPool.prototype, "run") as typeof WorkerTaskPool.prototype.run;
    let signalEntered = () => {};
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseFirst = () => {};
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let holdFirst = true;
    let physicalRuns = 0;
    const spy = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(async function (
      this: WorkerTaskPool<unknown, unknown>,
      ...args
    ) {
      const input = args[0];
      if (typeof input !== "function" && input.kind === "session-entry") {
        physicalRuns++;
        if (holdFirst) {
          holdFirst = false;
          signalEntered();
          await release;
        }
      }
      return await Reflect.apply(run, this, args);
    });
    try {
      const first = buildSessionEntry(scope.sessionKey, scope);
      await entered;
      expect(
        appendTranscriptEventSync(scope, {
          type: "model_change",
          id: "append-between-exports",
          provider: "test",
          modelId: "new-version",
        }),
      ).toMatchObject({ ok: true, value: true });
      const second = buildSessionEntry(scope.sessionKey, scope);
      await vi.waitFor(() => {
        expect(physicalRuns).toBe(2);
      });
      releaseFirst();
      const entries = await Promise.all([first, second]);
      expect(entries.every(Boolean)).toBe(true);
    } finally {
      releaseFirst();
      spy.mockRestore();
    }
  });

  it.skipIf(process.platform !== "linux")(
    "retains at most four SQLite handles after six synthetic stores",
    async () => {
      const scopes = [];
      for (let index = 0; index < 6; index++) {
        scopes.push(await seedSession("resource-" + index));
        await closeOpenClawAgentDatabasesAsync();
        await buildSessionEntry(scopes[index]!.sessionKey, scopes[index]);
      }
      expect(openSyntheticDatabasePaths().size).toBeLessThanOrEqual(4);
    },
  );
});
