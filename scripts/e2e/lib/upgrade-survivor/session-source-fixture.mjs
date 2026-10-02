import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function captureLegacySessionSources(directory, names) {
  const sourceNames =
    names ??
    fs.readdirSync(directory).filter((name) => name === "sessions.json" || name.endsWith(".jsonl"));
  const sources = Object.fromEntries(
    sourceNames.map((name) => [
      name,
      createHash("sha256")
        .update(fs.readFileSync(path.join(directory, name)))
        .digest("hex"),
    ]),
  );
  assert(sources["sessions.json"], "Legacy session metadata was not seeded");
  return sources;
}

function usesMissingPathFixture() {
  // Artifact-only base/manual rows seed sessions without the missing-path scenario.
  return process.env.OPENCLAW_UPGRADE_SURVIVOR_MISSING_LOAD_PATH_SEEDED === "1";
}

function fixturePath() {
  return path.join(
    process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT,
    "missing-load-path/fixture.json",
  );
}

export function recordLegacySessionSources(stateDir) {
  if (!usesMissingPathFixture()) {
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath(), "utf8"));
  fixture.legacySessionSources = captureLegacySessionSources(
    path.join(stateDir, "agents", "main", "sessions"),
  );
  fs.writeFileSync(fixturePath(), `${JSON.stringify(fixture, null, 2)}\n`);
}

export function assertLegacySessionSourceDisposition(legacyStorePath, source, candidateVersion) {
  if (!usesMissingPathFixture()) {
    if (source === "file") {
      // The July 1 regular releases still owned file-backed sessions.
      assert(
        /^2026\.7\.1(?:-(?:[12]|beta\.[1-6]))?$/.test(candidateVersion ?? ""),
        "SQLite session import missing for candidate",
      );
      return;
    }
    assert(
      !fs.existsSync(legacyStorePath),
      `legacy sessions.json survived migration: ${legacyStorePath}`,
    );
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath(), "utf8"));
  assert.notEqual(source, "file", "Retained legacy sources must have canonical SQLite sessions");
  // Pending plugin migrations retain their sources after canonical SQLite import.
  assert.deepEqual(
    captureLegacySessionSources(
      path.dirname(legacyStorePath),
      Object.keys(fixture.legacySessionSources),
    ),
    fixture.legacySessionSources,
    "Uninspected legacy session source bytes changed",
  );
}
