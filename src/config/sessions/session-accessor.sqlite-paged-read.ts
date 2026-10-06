import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { assertSqliteJsonlReadBudget } from "../../infra/sqlite-jsonl-budget.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptContextVersion,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import {
  decodeTranscriptEventPayload,
  transcriptEventResetNavigationSql,
  TRANSCRIPT_EVENT_PAYLOAD_COLUMNS,
  type TranscriptEventPayloadColumns,
} from "./transcript-payload.js";

const TRANSCRIPT_EXPORT_PAGE_ROWS = 16;
type TranscriptPayloadPageRow = TranscriptEventPayloadColumns & { seq: number };

export function prepareTranscriptEventReadQuery(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  options: {
    beforeEventSeq?: number;
    throughEventSeq?: number;
    maxEventBytes?: number;
  } = {},
) {
  const { beforeEventSeq, throughEventSeq, maxEventBytes } = options;
  const db = getSessionKysely(database.db);
  if (maxEventBytes !== undefined && Number.isFinite(maxEventBytes) && maxEventBytes >= 0) {
    assertSqliteJsonlReadBudget(
      database.db,
      db
        .selectFrom("transcript_events")
        .select(["event_json", "event_utf8_bytes"])
        .where("session_id", "=", sessionId)
        .$if(beforeEventSeq !== undefined, (query) => query.where("seq", "<", beforeEventSeq!))
        .$if(throughEventSeq !== undefined, (query) => query.where("seq", "<=", throughEventSeq!))
        .as("events"),
      Math.floor(maxEventBytes),
      "Trajectory transcript store",
      { hasExactUtf8Bytes: true },
    );
  }
  return db
    .selectFrom("transcript_events")
    .where("session_id", "=", sessionId)
    .$if(beforeEventSeq !== undefined, (query) => query.where("seq", "<", beforeEventSeq!))
    .$if(throughEventSeq !== undefined, (query) => query.where("seq", "<=", throughEventSeq!));
}

/**
 * Decode bounded pages after each short read hold. A destructive rewrite rotates the
 * generation and refuses a mixed result; pure appends stay beyond the initial sequence fence.
 */
export function loadTranscriptEventsPagedFromDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  options: {
    beforeEventSeq?: number;
    maxEventBytes?: number;
    projection?: "reset-boundary";
    projectEvent?: (event: TranscriptEvent) => TranscriptEvent;
    version: SessionTranscriptContextVersion;
  },
): TranscriptEvent[] {
  const throughSeq = Math.min(
    options.version.rawSeq ?? -1,
    options.beforeEventSeq === undefined ? Number.MAX_SAFE_INTEGER : options.beforeEventSeq - 1,
  );
  if (throughSeq < 0) {
    return [];
  }
  const events: TranscriptEvent[] = [];
  let afterSeq = -1;
  while (afterSeq < throughSeq) {
    const rows = runSqliteDeferredTransactionSync(
      database.db,
      () => {
        assertSessionTranscriptHot(database.db, sessionId);
        const pageVersion = readTranscriptContextVersionInTransaction(database, sessionId);
        if (pageVersion.generation !== options.version.generation) {
          throw new Error("Session transcript changed while exporting; retry the operation.");
        }
        if (afterSeq < 0 && options.maxEventBytes !== undefined) {
          prepareTranscriptEventReadQuery(database, sessionId, {
            beforeEventSeq: options.beforeEventSeq,
            throughEventSeq: throughSeq,
            maxEventBytes: options.maxEventBytes,
          });
        }
        const query = getSessionKysely(database.db)
          .selectFrom("transcript_events")
          .where("session_id", "=", sessionId)
          .where("seq", ">", afterSeq)
          .where("seq", "<=", throughSeq)
          .orderBy("seq", "asc")
          .limit(TRANSCRIPT_EXPORT_PAGE_ROWS);
        return options.projection === "reset-boundary"
          ? executeSqliteQuerySync(
              database.db,
              query.select(["seq", transcriptEventResetNavigationSql().as("event_json")]),
            ).rows
          : executeSqliteQuerySync(
              database.db,
              query.select(["seq", ...TRANSCRIPT_EVENT_PAYLOAD_COLUMNS]),
            ).rows;
      },
      { operationLabel: "session transcript export page" },
    );
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      afterSeq = sqliteNumber(row.seq);
      let eventJson: string;
      if (options.projection === "reset-boundary") {
        // SAFETY: the reset-boundary query selects event_json for every returned row.
        eventJson = (row as { event_json: string }).event_json;
      } else {
        // SAFETY: the payload query selects every TRANSCRIPT_EVENT_PAYLOAD_COLUMNS field.
        eventJson = decodeTranscriptEventPayload(row as TranscriptPayloadPageRow);
      }
      const event: TranscriptEvent = JSON.parse(eventJson);
      events.push(options.projectEvent ? options.projectEvent(event) : event);
    }
    // Release native BLOB wrappers before reading the next page.
    rows.length = 0;
  }
  const finalVersion = runSqliteDeferredTransactionSync(
    database.db,
    () => {
      assertSessionTranscriptHot(database.db, sessionId);
      return readTranscriptContextVersionInTransaction(database, sessionId);
    },
    { operationLabel: "session transcript export generation check" },
  );
  if (finalVersion.generation !== options.version.generation) {
    throw new Error("Session transcript changed while exporting; retry the operation.");
  }
  return events;
}
