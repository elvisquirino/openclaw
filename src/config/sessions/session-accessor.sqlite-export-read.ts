import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { loadTranscriptEventsPagedFromDatabase } from "./session-accessor.sqlite-paged-read.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { readTranscriptStatsFromDatabase } from "./session-accessor.sqlite-transcript-stats.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

/** Snapshot export payloads and their identity without opening the writable lifecycle. */
export function readTranscriptExportSnapshotReadOnlySync(
  scope: SessionTranscriptReadScope,
  options: {
    projection?: "reset-boundary";
    /** Reduce each decoded event synchronously before retaining the snapshot. */
    projectEvent?: (event: TranscriptEvent) => TranscriptEvent;
  } = {},
) {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const metadata = runSqliteDeferredTransactionSync(
      database.db,
      () => {
        assertSessionTranscriptHot(database.db, resolved.sessionId);
        const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
        const sessionKey =
          resolved.sessionKey ??
          executeSqliteQueryTakeFirstSync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("session_windows")
              .select("session_key")
              .where("session_id", "=", resolved.sessionId)
              .limit(1),
          )?.session_key;
        return {
          beforeEventSeq: fence?.beforeRawSeq,
          stats: readTranscriptStatsFromDatabase(database, resolved.sessionId),
          sessionKey,
          version: readTranscriptContextVersionInTransaction(database, resolved.sessionId),
        };
      },
      { operationLabel: "session transcript export snapshot" },
    );
    const events = loadTranscriptEventsPagedFromDatabase(database, resolved.sessionId, {
      beforeEventSeq: metadata.beforeEventSeq,
      maxEventBytes: scope.maxEventBytes,
      projection: options.projection,
      projectEvent: options.projectEvent,
      version: metadata.version,
    });
    return { events, stats: metadata.stats, sessionKey: metadata.sessionKey };
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : undefined;
}

/** Capture the authoritative export watermark before admitting coalesced work. */
export function readTranscriptExportVersionReadOnlySync(scope: SessionTranscriptReadScope) {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    assertSessionTranscriptHot(database.db, resolved.sessionId);
    return readTranscriptContextVersionInTransaction(database, resolved.sessionId);
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : undefined;
}
