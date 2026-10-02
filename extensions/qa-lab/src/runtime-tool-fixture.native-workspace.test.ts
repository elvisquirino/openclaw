import fs from "node:fs/promises";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRuntimeToolFixtureTempRoots,
  makeEnv,
  transcriptToolCall,
  transcriptToolResult,
  writeQaSessionTranscript,
} from "../test/runtime-tool-fixture-helpers.js";
import { getQaNativeWorkspaceBehavior } from "./native-workspace-behavior.js";
import { runRuntimeToolFixture } from "./runtime-tool-fixture.js";

const OPENCLAW_TOOL_BY_BEHAVIOR = {
  bash: "exec",
  edit: "edit",
  exec: "exec",
  "fs-read": "read",
  "fs-write": "write",
  grep: "exec",
} as const;

afterEach(() => {
  resetPluginStateStoreForTests({ closeDatabase: false });
});
afterAll(cleanupRuntimeToolFixtureTempRoots);

describe("Codex-native workspace runtime tool fixtures", () => {
  it.each(["bash", "edit", "exec", "fs-read", "fs-write", "grep"] as const)(
    "requires correlated native receipts and observable %s outcomes",
    async (behaviorId) => {
      const env = await makeEnv();
      env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
      const behavior = getQaNativeWorkspaceBehavior(behaviorId);
      const happyArguments =
        behavior.nativeToolName === "bash"
          ? { command: `/bin/zsh -lc ${JSON.stringify(behavior.happyArgs.cmd)}` }
          : {
              changes: [
                {
                  path: behavior.happyMutation?.path,
                  kind: { type: "update" },
                },
              ],
            };
      const failureArguments =
        behavior.nativeToolName === "bash"
          ? { command: `/bin/zsh -lc ${JSON.stringify(behavior.failureArgs.cmd)}` }
          : {
              changes: [
                {
                  path: behavior.failureSentinel?.path,
                  kind: { type: "update" },
                },
              ],
            };
      const runtimeToolName = OPENCLAW_TOOL_BY_BEHAVIOR[behaviorId];
      if (behaviorId === "fs-write" && behavior.happyMutation) {
        await fs.writeFile(
          path.join(env.gateway.workspaceDir, behavior.happyMutation.path),
          behavior.happyMutation.contents,
          "utf8",
        );
      }
      await writeQaSessionTranscript(env, `agent:qa:runtime-tool:${runtimeToolName}:happy`, [
        transcriptToolCall(behavior.nativeToolName, "happy", happyArguments),
        transcriptToolResult(
          behavior.nativeToolName,
          "happy",
          behavior.happyOutputMarker ?? "native workspace change completed",
        ),
      ]);
      await writeQaSessionTranscript(env, `agent:qa:runtime-tool:${runtimeToolName}:failure`, [
        transcriptToolCall(behavior.nativeToolName, "failure", failureArguments),
        transcriptToolResult(
          behavior.nativeToolName,
          "failure",
          behavior.failureOutputMarker ?? "path escapes workspace root",
          true,
        ),
      ]);

      const promptEvidence: Array<{
        transcriptToolName?: string;
        requireSuccessfulTranscriptToolResult?: boolean;
      }> = [];
      const details = await runRuntimeToolFixture(
        env,
        {
          toolName: OPENCLAW_TOOL_BY_BEHAVIOR[behaviorId],
          nativeWorkspaceBehavior: behaviorId,
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            required: true,
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(async (_env, params) => {
            promptEvidence.push({
              transcriptToolName: params.transcriptToolName,
              requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
            });
            if (params.sessionKey.endsWith(":happy") && behavior.happyMutation) {
              const mutationPath = path.join(env.gateway.workspaceDir, behavior.happyMutation.path);
              if (behaviorId === "fs-write") {
                await expect(fs.readFile(mutationPath, "utf8")).rejects.toThrow();
              }
              await fs.writeFile(mutationPath, behavior.happyMutation.contents, "utf8");
            }
            return {};
          }),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      );

      expect(promptEvidence).toEqual([
        {
          transcriptToolName: behavior.nativeToolName,
          requireSuccessfulTranscriptToolResult: true,
        },
        {
          transcriptToolName: behavior.nativeToolName,
          requireSuccessfulTranscriptToolResult: undefined,
        },
      ]);
      expect(details).toContain(`codex-native ${behaviorId} behavior passed`);
      if (behavior.happyMutation) {
        await expect(
          fs.readFile(path.join(env.gateway.workspaceDir, behavior.happyMutation.path), "utf8"),
        ).resolves.toBe(behavior.happyMutation.contents);
      }
      if (behavior.failureSentinel) {
        await expect(
          fs.readFile(
            path.resolve(env.gateway.workspaceDir, behavior.failureSentinel.path),
            "utf8",
          ),
        ).rejects.toThrow();
      }
    },
  );
});
