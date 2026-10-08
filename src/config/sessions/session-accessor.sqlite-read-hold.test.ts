import path from "node:path";
import type { Message } from "openclaw/plugin-sdk/llm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptEventSync,
  replaceSessionEntry,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import { readTranscriptExportSnapshotReadOnlySync } from "./session-accessor.sqlite-export-read.js";
import { loadTranscriptReadSnapshotSync } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";

const holdLogger = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  raw: vi.fn(),
  isEnabled: vi.fn(() => true),
  child: vi.fn(),
  subsystem: "sqlite/transaction",
}));

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      subsystem === "sqlite/transaction" ? holdLogger : actual.createSubsystemLogger(subsystem),
  };
});

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

const sessionDirs = createTempDirTracker();
const MARKER = "bounded-hold-probe";

afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync();
  sessionDirs.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
  holdLogger.warn.mockClear();
});

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: 1 };
}

describe("bounded SQLite transcript snapshots", () => {
  async function seedSession() {
    const tempDir = sessionDirs.make("openclaw-transcript-hold-");
    const storePath = path.join(tempDir, "sessions.json");
    const sessionId = "session-hold";
    const sessionKey = "agent:main:hold";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId, updatedAt: 1 },
    );
    const events = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-04-01T05:46:39.000Z",
        cwd: tempDir,
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        type: "message",
        id: "entry-" + index,
        parentId: index === 0 ? null : "entry-" + (index - 1),
        timestamp: "2026-04-01T05:46:40.000Z",
        message: userMessage(MARKER + " " + "lobster ".repeat(600)),
      })),
    ];
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceTranscriptEvents(scope, events);
    return { events, scope };
  }

  function markTranscriptCold(
    scope: Awaited<ReturnType<typeof seedSession>>["scope"],
    options: { deleteHotRows?: boolean } = {},
  ) {
    const { db } = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "INSERT INTO session_transcript_cold_archives (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes, archive_bytes, last_seq, archived_at, storage) VALUES (?, 'cold-generation', 'synthetic-archive', ?, 41, 0, 0, 40, 1, 'file')",
      ).run(scope.sessionId, "0".repeat(64));
      if (options.deleteHotRows) {
        db.prepare("DELETE FROM transcript_events WHERE session_id = ?").run(scope.sessionId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function chargeJsonWork(millisecondsPerStep: number, marker: string | null = MARKER) {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const realParse = JSON.parse.bind(JSON);
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && (marker === null || text.includes(marker))) {
        now += millisecondsPerStep;
      }
      return realParse(text, reviver);
    });
  }

  function slowHolds() {
    return holdLogger.warn.mock.calls.filter(
      ([message]) => message === "slow SQLite transaction hold",
    );
  }

  it("decodes and projects full exports outside bounded transaction pages", async () => {
    const { events, scope } = await seedSession();
    chargeJsonWork(2_000);
    const projectEvent = vi.fn((event: unknown) => event);
    const snapshot = readTranscriptExportSnapshotReadOnlySync(scope, { projectEvent });
    expect(snapshot?.events).toEqual(events);
    expect(projectEvent).toHaveBeenCalledTimes(events.length);
    expect(slowHolds()).toEqual([]);
  });

  it("decodes fenced reads outside bounded transaction pages", async () => {
    const { events, scope } = await seedSession();
    chargeJsonWork(2_000);
    const snapshot = loadTranscriptReadSnapshotSync(scope, { readOnly: true });
    expect(snapshot.events).toEqual(events);
    expect(slowHolds()).toEqual([]);
  });

  it("parses reset-boundary exports outside bounded transaction pages", async () => {
    const { events, scope } = await seedSession();
    chargeJsonWork(2_000, null);
    const snapshot = readTranscriptExportSnapshotReadOnlySync(scope, {
      projection: "reset-boundary",
    });
    expect(snapshot?.events).toHaveLength(events.length);
    expect(slowHolds()).toEqual([]);
  });

  it.each([
    [
      "export snapshot",
      (scope: Parameters<typeof loadTranscriptReadSnapshotSync>[0]) =>
        readTranscriptExportSnapshotReadOnlySync(scope),
    ],
    [
      "fenced read",
      (scope: Parameters<typeof loadTranscriptReadSnapshotSync>[0]) =>
        loadTranscriptReadSnapshotSync(scope, { readOnly: true }),
    ],
  ])("rejects an already-cold transcript (%s)", async (_name, read) => {
    const { scope } = await seedSession();
    markTranscriptCold(scope);
    expect(() => read(scope)).toThrow(/cold storage/u);
  });

  it("rejects archival that removes hot rows between pages", async () => {
    const { scope } = await seedSession();
    let archived = false;
    expect(() =>
      readTranscriptExportSnapshotReadOnlySync(scope, {
        projectEvent: (event) => {
          if (!archived) {
            archived = true;
            markTranscriptCold(scope, { deleteHotRows: true });
          }
          return event;
        },
      }),
    ).toThrow(/cold storage/u);
  });

  it("keeps the initial sequence fence when a pure append lands between pages", async () => {
    const { events, scope } = await seedSession();
    let appended = false;
    const snapshot = readTranscriptExportSnapshotReadOnlySync(scope, {
      projectEvent: (event) => {
        if (!appended) {
          appended = true;
          const result = appendTranscriptEventSync(scope, {
            type: "model_change",
            id: "appended-during-export",
            parentId: "entry-39",
            timestamp: "2026-04-01T05:47:00.000Z",
            provider: "test",
            modelId: "append-probe",
          });
          expect(result.ok && result.value).toBe(true);
        }
        return event;
      },
    });
    expect(snapshot?.events).toEqual(events);
    expect(loadTranscriptReadSnapshotSync(scope, { readOnly: true }).events).toHaveLength(
      events.length + 1,
    );
  });

  it("rejects a mixed snapshot when a destructive rewrite lands between pages", async () => {
    const { events, scope } = await seedSession();
    let rewritten = false;
    expect(() =>
      readTranscriptExportSnapshotReadOnlySync(scope, {
        projectEvent: (event) => {
          if (!rewritten) {
            rewritten = true;
            expect(replaceTranscriptEventsSync(scope, events.slice(0, 2))).toBe(true);
          }
          return event;
        },
      }),
    ).toThrow("Session transcript changed while exporting; retry the operation.");
    expect(loadTranscriptReadSnapshotSync(scope, { readOnly: true }).events).toEqual(
      events.slice(0, 2),
    );
  });

  it.each([
    [
      "export snapshot",
      (scope: Parameters<typeof loadTranscriptReadSnapshotSync>[0]) =>
        readTranscriptExportSnapshotReadOnlySync(scope),
    ],
    [
      "fenced read",
      (scope: Parameters<typeof loadTranscriptReadSnapshotSync>[0]) =>
        loadTranscriptReadSnapshotSync(scope, { readOnly: true }),
    ],
  ])("surfaces corrupt compressed payload bounds (%s)", async (_name, read) => {
    const { scope } = await seedSession();
    const { db } = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    db.prepare(
      "UPDATE transcript_events SET event_utf8_bytes = event_utf8_bytes + 1 WHERE session_id = ? AND event_zstd IS NOT NULL",
    ).run(scope.sessionId);
    expect(() => read(scope)).toThrow(/Compressed transcript payload length does not match/u);
  });
});
