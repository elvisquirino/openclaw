import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type {
  SessionEntryWorkerInput,
  SessionResetRecallWorkerInput,
  SessionTranscriptWorkerSuccess,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

type ExportInput = SessionEntryWorkerInput | SessionResetRecallWorkerInput;
type ExportValue =
  | SessionTranscriptWorkerValues["session-entry"]
  | SessionTranscriptWorkerValues["session-reset-recall"];

export async function runSessionTranscriptExportWorker(
  request: ExportInput,
  withDatabase: (
    database: { agentId: string; path: string },
    operation: () => Promise<ExportValue>,
  ) => Promise<SessionTranscriptWorkerSuccess<ExportValue>>,
): Promise<SessionTranscriptWorkerSuccess<ExportValue>> {
  const scope = request.kind === "session-reset-recall" ? request.scope : request.options;
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const database = {
    agentId: databaseOptions.agentId,
    path: resolveOpenClawAgentSqlitePath(databaseOptions),
  };
  return await withDatabase(database, async () => {
    if (request.kind === "session-reset-recall") {
      const { readSessionResetRecallCutoffInProcess } =
        await import("../../../packages/memory-host-sdk/src/host/session-reset-recall-read.js");
      return { cutoff: readSessionResetRecallCutoffInProcess(request.scope) };
    }
    const { buildSessionEntryInProcess, readSessionEntryResetRecallCutoff } =
      await import("../../../packages/memory-host-sdk/src/host/session-files.js");
    const { createSensitiveTextRedactor } = await import("../../logging/redact.js");
    const entry = await buildSessionEntryInProcess(
      request.absPath,
      request.options,
      createSensitiveTextRedactor(request.redaction),
    );
    return {
      entry,
      resetRecallCutoff: entry
        ? readSessionEntryResetRecallCutoff(entry)
        : { state: "absent" as const },
    };
  });
}
