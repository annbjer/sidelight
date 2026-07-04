import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyAgentStart,
  applyModelSelect,
  applyNameChange,
  applyShutdown,
  applyToolCall,
  applyTurnEnd,
  createSnapshot,
} from "../extension/snapshot.js";
import { cwdHash, stateDirFor } from "../extension/state-dir.js";

const cwd = "/tmp/project";

test("createSnapshot creates the v1 schema", () => {
  assert.deepEqual(createSnapshot("session-1", cwd, "startup", 1000), {
    v: 1,
    sessionId: "session-1",
    cwd,
    name: null,
    model: null,
    startedAt: 1000,
    lastActivityAt: 1000,
    endedAt: null,
    startReason: "startup",
    counts: { prompts: 0, turns: 0, toolCalls: {} },
    filesTouched: [],
    tokens: { input: 0, output: 0 },
    cost: 0,
  });
});

test("applyNameChange stores only a string session label", () => {
  const snapshot = createSnapshot("session-1", cwd, "startup", 1000);

  assert.equal(applyNameChange(snapshot, "API cleanup").name, "API cleanup");
  assert.equal(applyNameChange(snapshot, undefined).name, null);
});

test("applyModelSelect stores only string model ids", () => {
  const snapshot = createSnapshot("session-1", cwd, "startup", 1000);
  const selected = applyModelSelect(snapshot, "claude-sonnet-4");

  assert.equal(selected.model, "claude-sonnet-4");
  assert.equal(applyModelSelect(selected, { id: "ignored" }).model, "claude-sonnet-4");
});

test("applyAgentStart increments prompts and activity time without mutation", () => {
  const snapshot = createSnapshot("session-1", cwd, "startup", 1000);
  const next = applyAgentStart(snapshot, { prompt: "do not store" }, 2000);

  assert.equal(next.counts.prompts, 1);
  assert.equal(next.lastActivityAt, 2000);
  assert.equal(snapshot.counts.prompts, 0);
});

test("applyTurnEnd increments turns and aggregates usage numbers only", () => {
  const snapshot = createSnapshot("session-1", cwd, "startup", 1000);
  const next = applyTurnEnd(
    snapshot,
    {
      input: 11,
      output: 7,
      totalTokens: 18,
      cost: { input: 0.01, output: 0.02, total: 0.03 },
      content: "do not store",
    },
    2000,
  );

  assert.equal(next.counts.turns, 1);
  assert.deepEqual(next.tokens, { input: 11, output: 7 });
  assert.equal(next.cost, 0.03);
  assert.equal(next.lastActivityAt, 2000);
});

test("applyToolCall counts every tool and stores only allowed file paths", () => {
  const snapshot = createSnapshot("session-1", cwd, "startup", 1000);
  const next = applyToolCall(
    snapshot,
    "read",
    {
      path: "/tmp/project/src/app.ts",
      content: "secret prompt body",
      command: "cat .env",
    },
    2000,
  );
  const bash = applyToolCall(next, "bash", { command: "cat src/app.ts" }, 3000);

  assert.deepEqual(bash.counts.toolCalls, { read: 1, bash: 1 });
  assert.deepEqual(bash.filesTouched, ["src/app.ts"]);
});

test("applyToolCall supports file_path, dedupes, and excludes denied paths", () => {
  let snapshot = createSnapshot("session-1", cwd, "startup", 1000);

  snapshot = applyToolCall(snapshot, "write", { file_path: "src/app.ts" }, 2000);
  snapshot = applyToolCall(snapshot, "edit", { path: "src/app.ts" }, 3000);
  snapshot = applyToolCall(snapshot, "read", { path: ".env.local" }, 4000);
  snapshot = applyToolCall(snapshot, "read", { path: "node_modules/pkg/index.js" }, 5000);
  snapshot = applyToolCall(snapshot, "read", { path: "/tmp/elsewhere/file.ts" }, 6000);

  assert.deepEqual(snapshot.filesTouched, ["src/app.ts"]);
  assert.deepEqual(snapshot.counts.toolCalls, { write: 1, edit: 1, read: 3 });
});

test("applyToolCall caps filesTouched at 100", () => {
  let snapshot = createSnapshot("session-1", cwd, "startup", 1000);

  for (let index = 0; index < 105; index += 1) {
    snapshot = applyToolCall(snapshot, "read", { path: `src/file-${index}.ts` }, 2000 + index);
  }

  assert.equal(snapshot.filesTouched.length, 100);
  assert.equal(snapshot.filesTouched.at(0), "src/file-0.ts");
  assert.equal(snapshot.filesTouched.at(-1), "src/file-99.ts");
});

test("applyShutdown sets endedAt without mutation", () => {
  const snapshot = createSnapshot("session-1", cwd, "startup", 1000);
  const next = applyShutdown(snapshot, undefined, 2000);

  assert.equal(next.endedAt, 2000);
  assert.equal(snapshot.endedAt, null);
});

test("cwdHash uses the first 16 hex chars of sha256", () => {
  assert.equal(cwdHash("/tmp/project"), "f630ad93b344dd6b");
});

test("stateDirFor prefers XDG_STATE_HOME", () => {
  assert.equal(
    stateDirFor("/tmp/project", { XDG_STATE_HOME: "/state", HOME: "/home/alice" }),
    "/state/sidelight/sessions/f630ad93b344dd6b",
  );
});

test("stateDirFor falls back to HOME local state", () => {
  assert.equal(
    stateDirFor("/tmp/project", { HOME: "/home/alice" }),
    "/home/alice/.local/state/sidelight/sessions/f630ad93b344dd6b",
  );
});
