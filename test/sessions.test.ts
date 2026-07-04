import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stateDirFor } from "../extension/state-dir.js";
import {
  loadSnapshots,
  sessionRowLabel,
  stateDirForProjectDir,
  type SessionSnapshotView,
} from "../src/sessions.js";
import { detailLines } from "../src/panels/sessions.js";

test("sessionRowLabel renders active sessions with explicit names", () => {
  const label = sessionRowLabel(snapshot({ name: "API cleanup", endedAt: null }), 1_000_000);

  assert.deepEqual(label.parts, ["● API cleanup", "now", "3 prompts", "sonnet-4", "$0.04"]);
});

test("sessionRowLabel renders ended sessions with session id fallback", () => {
  const label = sessionRowLabel(
    snapshot({
      sessionId: "abcdef1234567890",
      name: null,
      lastActivityAt: 900_000,
      endedAt: 900_000,
      counts: { prompts: 1, turns: 2, toolCalls: {} },
    }),
    1_000_000,
  );

  assert.deepEqual(label.parts, ["○ abcdef12", "1m ago", "1 prompt", "sonnet-4", "$0.04"]);
});

test("sessionRowLabel formats relative ages", () => {
  const now = 10 * 24 * 60 * 60 * 1000;

  assert.equal(sessionRowLabel(snapshot({ lastActivityAt: now }), now).age, "now");
  assert.equal(sessionRowLabel(snapshot({ lastActivityAt: now - 3 * 60 * 1000 }), now).age, "3m");
  assert.equal(sessionRowLabel(snapshot({ lastActivityAt: now - 2 * 60 * 60 * 1000 }), now).age, "2h");
  assert.equal(sessionRowLabel(snapshot({ lastActivityAt: now - 5 * 24 * 60 * 60 * 1000 }), now).age, "5d");
});

test("sessionRowLabel shortens provider-prefixed model ids", () => {
  assert.equal(sessionRowLabel(snapshot({ model: "anthropic/claude-opus-4" }), 1_000_000).model, "claude-opus-4");
  assert.equal(sessionRowLabel(snapshot({ model: "sonnet" }), 1_000_000).model, "sonnet");
  assert.equal(sessionRowLabel(snapshot({ model: null }), 1_000_000).model, "unknown");
});

test("sessionRowLabel formats cost with two decimals and sub-cent as zero", () => {
  assert.equal(sessionRowLabel(snapshot({ cost: 0.0421 }), 1_000_000).cost, "$0.04");
  assert.equal(sessionRowLabel(snapshot({ cost: 0.009 }), 1_000_000).cost, "$0.00");
  assert.equal(sessionRowLabel(snapshot({ cost: 1 }), 1_000_000).cost, "$1.00");
});

test("loadSnapshots reads valid rows, skips malformed JSON, ignores dir.json, and preserves unknown versions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sidelight-sessions-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  await writeFile(join(dir, "dir.json"), JSON.stringify({ cwd: "/tmp/project" }), "utf8");
  await writeFile(join(dir, "newer.json"), JSON.stringify(snapshot({ sessionId: "newer", lastActivityAt: 3000 })), "utf8");
  await writeFile(join(dir, "older.json"), JSON.stringify(snapshot({ sessionId: "older", lastActivityAt: 1000 })), "utf8");
  await writeFile(join(dir, "bad.json"), "{nope", "utf8");
  await writeFile(
    join(dir, "future.json"),
    JSON.stringify({ v: 2, sessionId: "future-session", lastActivityAt: 2000 }),
    "utf8",
  );

  const rows = await loadSnapshots(dir);

  assert.deepEqual(
    rows.map((row) => row.kind === "snapshot" ? row.snapshot.sessionId : `${row.kind}:${row.sessionId}`),
    ["newer", "unknown-version:future-session", "older"],
  );
  assert.equal(rows.length, 3);
});

test("loadSnapshots returns an empty list for a missing directory", async () => {
  assert.deepEqual(await loadSnapshots(join(tmpdir(), "sidelight-missing-sessions-dir")), []);
});

test("stateDirForProjectDir hashes the realpath of the project dir", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sidelight-realpath-"));
  const realProject = join(dir, "project");
  const linkProject = join(dir, "link-project");
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  await mkdir(realProject);
  await symlink(realProject, linkProject);

  assert.equal(stateDirForProjectDir(linkProject), stateDirFor(realpathSync(realProject)));
});

test("detailLines appends resume hint for ended sessions only", () => {
  const ended = detailLines({ kind: "snapshot", path: "/tmp/session.json", snapshot: snapshot({ endedAt: 1234 }) });
  const active = detailLines({ kind: "snapshot", path: "/tmp/session.json", snapshot: snapshot({ endedAt: null }) });

  assert.equal(ended.at(-1), "resume: pi --session session-1234567890");
  assert.equal(active.includes("resume: pi --session session-1234567890"), false);
});

function snapshot(overrides: Partial<SessionSnapshotView> = {}): SessionSnapshotView {
  return {
    v: 1,
    sessionId: "session-1234567890",
    cwd: "/tmp/project",
    name: "Session name",
    model: "anthropic/sonnet-4",
    startedAt: 1000,
    lastActivityAt: 1_000_000,
    endedAt: null,
    startReason: "startup",
    counts: { prompts: 3, turns: 4, toolCalls: { bash: 2, read: 1 } },
    filesTouched: ["src/app.ts"],
    tokens: { input: 100, output: 50 },
    cost: 0.0421,
    ...overrides,
  };
}
