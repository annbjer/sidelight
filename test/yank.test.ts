import assert from "node:assert/strict";
import { test } from "node:test";
import { type VisibleRow } from "../src/tree.js";
import { previewYankPayload, type PreviewState } from "../src/preview.js";
import { gitYankPayload } from "../src/panels/git.js";
import { searchRowYankPayload } from "../src/panels/search.js";
import { selectedVisibleRowPath } from "../src/panels/files.js";
import { sessionYankPayload } from "../src/panels/sessions.js";
import { pathYankPayload, osc52, yankToClipboard } from "../src/yank.js";
import type { GitTrackedChange, SearchMatch } from "../src/git.js";
import type { SessionRow } from "../src/sessions.js";

test("osc52 encodes ASCII payloads as base64 UTF-8", () => {
  assert.equal(osc52("src/app.ts"), "\x1b]52;c;c3JjL2FwcC50cw==\x07");
});

test("osc52 encodes UTF-8 paths as base64 UTF-8", () => {
  assert.equal(osc52("src/éclair.ts"), `\x1b]52;c;${Buffer.from("src/éclair.ts", "utf8").toString("base64")}\x07`);
});

test("osc52 encodes line suffix payloads", () => {
  assert.equal(osc52("src/app.ts:42"), "\x1b]52;c;c3JjL2FwcC50czo0Mg==\x07");
});

test("yankToClipboard writes the OSC52 sequence directly to the terminal", () => {
  const writes: string[] = [];
  yankToClipboard("src/app.ts", {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: (data) => writes.push(data),
    columns: 80,
    rows: 24,
    kittyProtocolActive: false,
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  });

  assert.deepEqual(writes, ["\x1b]52;c;c3JjL2FwcC50cw==\x07"]);
});

test("files yank payload is the selected visible row path for files and directories", () => {
  const rows: VisibleRow[] = [
    visibleRow("src", "dir"),
    visibleRow("src/app.ts", "file"),
  ];

  assert.equal(selectedVisibleRowPath(rows, 0), "src");
  assert.equal(selectedVisibleRowPath(rows, 1), "src/app.ts");
  assert.equal(selectedVisibleRowPath(rows, 2), null);
});

test("search yank payloads distinguish file rows and content matches", () => {
  const match: SearchMatch = { path: "src/app.ts", line: 42, col: 7, text: "needle" };

  assert.equal(searchRowYankPayload({ type: "filematch", path: "src/app.ts" }), "src/app.ts");
  assert.equal(searchRowYankPayload({ type: "match", match }), "src/app.ts:42");
  assert.equal(searchRowYankPayload({ type: "file", path: "src/app.ts" }), null);
  assert.equal(searchRowYankPayload(undefined), null);
});

test("git yank payload is the current path", () => {
  const change: GitTrackedChange = { path: "src/new.ts", originalPath: "src/old.ts", status: "R" };

  assert.equal(gitYankPayload(change), "src/new.ts");
});

test("session yank payload is the resume command for list and detail", () => {
  assert.equal(sessionYankPayload(snapshotRow("abc123")), "pi --session abc123");
  assert.equal(
    sessionYankPayload({ kind: "unknown-version", path: "/tmp/def456.json", sessionId: "def456", version: 2, lastActivityAt: 0 }),
    "pi --session def456",
  );
  assert.equal(sessionYankPayload(undefined), null);
});

test("preview yank payload uses file line and diff path", () => {
  const state: PreviewState = {
    path: "src/app.ts",
    lines: ["one", "two"],
    scrollOffset: 0,
    cursorLine: 1,
  };

  assert.equal(previewYankPayload(state), "src/app.ts:2");
  assert.equal(previewYankPayload({ ...state, breadcrumbKind: "unstaged diff" }), "src/app.ts");
});

function visibleRow(path: string, type: "dir" | "file"): VisibleRow {
  return {
    node: { name: path.slice(path.lastIndexOf("/") + 1), path, type, children: [] },
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    type,
    depth: 0,
    expanded: false,
  };
}

function snapshotRow(sessionId: string): SessionRow {
  return {
    kind: "snapshot",
    path: `/tmp/${sessionId}.json`,
    snapshot: {
      v: 1,
      sessionId,
      cwd: "/tmp/project",
      name: null,
      model: null,
      startedAt: 0,
      lastActivityAt: 0,
      endedAt: null,
      startReason: "manual",
      counts: { prompts: 0, turns: 0, toolCalls: {} },
      filesTouched: [],
      tokens: { input: 0, output: 0 },
      cost: 0,
    },
  };
}

test("pathYankPayload refuses deny-listed paths (defense in depth)", () => {
  assert.equal(pathYankPayload(".env.local"), null);
  assert.equal(pathYankPayload("certs/server.key", 12), null);
  assert.equal(pathYankPayload("node_modules/x/y.js"), null);
  assert.equal(pathYankPayload("src/app.ts"), "src/app.ts");
  assert.equal(pathYankPayload("src/app.ts", 42), "src/app.ts:42");
});
