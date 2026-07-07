import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeJsonMerge,
  computeJsonRemoval,
  computeTomlAppend,
  computeTomlRemoval,
  hasTomlHooksTable,
  renderDiff,
  type JsonInstallEntries,
} from "../adapters/core/install.js";

test("computeJsonMerge creates Claude settings hooks when the file is missing", () => {
  const result = computeJsonMerge(null, claudeEntries());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(result.merged), claudeEntries().config);
});

test("computeJsonMerge merges into empty settings", () => {
  const result = computeJsonMerge("{}\n", claudeEntries());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changed, true);
  const merged = JSON.parse(result.merged) as Record<string, unknown>;
  assert.equal(typeof merged.hooks, "object");
});

test("computeJsonMerge preserves unrelated settings and hooks", () => {
  const before = json({
    theme: "dark",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/opt/other-hook" }] }],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "/opt/audit-hook" }] }],
    },
  });

  const result = computeJsonMerge(before, claudeEntries());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const merged = JSON.parse(result.merged) as {
    theme: string;
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  };
  const stopGroups = merged.hooks.Stop;
  const preToolUseGroups = merged.hooks.PreToolUse;
  assert.ok(stopGroups);
  assert.ok(preToolUseGroups);
  assert.equal(merged.theme, "dark");
  assert.equal(stopGroups[0]?.hooks[0]?.command, "/opt/other-hook");
  assert.equal(stopGroups[0]?.hooks[1]?.command, "/usr/local/bin/sidelight-claude-code-hook");
  assert.equal(preToolUseGroups[0]?.hooks[0]?.command, "/opt/audit-hook");
  assert.equal(preToolUseGroups[0]?.hooks[1]?.command, "/usr/local/bin/sidelight-claude-code-hook");
});

test("computeJsonMerge is idempotent when our hook command is already installed", () => {
  const first = computeJsonMerge(null, claudeEntries());
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const second = computeJsonMerge(first.merged, claudeEntries("/different/path/sidelight-claude-code-hook"));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.changed, false);
  assert.deepEqual(JSON.parse(second.merged), JSON.parse(first.merged));
});

test("computeJsonRemoval strips only Sidelight hook entries and restores unrelated structure", () => {
  const before = json({
    theme: "dark",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/opt/other-hook" }] }],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "/opt/audit-hook" }] }],
    },
  });
  const merged = computeJsonMerge(before, claudeEntries());
  assert.equal(merged.ok, true);
  if (!merged.ok) return;

  const removed = computeJsonRemoval(merged.merged, "sidelight-claude-code-hook");

  assert.equal(removed.ok, true);
  if (!removed.ok) return;
  assert.equal(removed.changed, true);
  assert.deepEqual(JSON.parse(removed.merged), JSON.parse(before));
});

test("computeJsonRemoval drops hooks entirely when only Sidelight entries remain", () => {
  const merged = computeJsonMerge(null, claudeEntries());
  assert.equal(merged.ok, true);
  if (!merged.ok) return;

  const removed = computeJsonRemoval(merged.merged, "sidelight-claude-code-hook");

  assert.equal(removed.ok, true);
  if (!removed.ok) return;
  assert.equal(removed.changed, true);
  assert.deepEqual(JSON.parse(removed.merged), {});
});

test("computeJsonMerge reports invalid JSON without throwing", () => {
  const result = computeJsonMerge("{ nope", claudeEntries());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "invalid-json");
});

test("Codex TOML helpers append only when no hooks table exists", () => {
  const block = codexBlock();
  const result = computeTomlAppend("model = \"gpt-5\"\n", block);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.changed, true);
  assert.equal(result.merged, `model = "gpt-5"\n\n${block}`);
  assert.equal(hasTomlHooksTable(result.merged), true);
});

test("Codex TOML append creates a missing config file", () => {
  const result = computeTomlAppend(null, codexBlock());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.merged, codexBlock());
});

test("Codex TOML append refuses an existing hooks table", () => {
  const result = computeTomlAppend("[hooks]\nStop = []\n", codexBlock());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "hooks-table-exists");
});

test("Codex TOML removal removes the appended block verbatim", () => {
  const block = codexBlock();
  const appended = computeTomlAppend("model = \"gpt-5\"\n", block);
  assert.equal(appended.ok, true);
  if (!appended.ok) return;

  const removed = computeTomlRemoval(appended.merged, block);

  assert.equal(removed.ok, true);
  if (!removed.ok) return;
  assert.equal(removed.merged, "model = \"gpt-5\"\n");
});

test("Codex TOML removal refuses when the block is not present verbatim", () => {
  const result = computeTomlRemoval("[hooks]\nStop = []\n", codexBlock());

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "block-not-found");
});

test("renderDiff labels created files and added lines", () => {
  const diff = renderDiff(null, "one\ntwo\n", "/tmp/settings.json");

  assert.match(diff, /^--- \/tmp\/settings\.json \(missing\)$/m);
  assert.match(diff, /^\+\+\+ \/tmp\/settings\.json$/m);
  assert.match(diff, /^\+one$/m);
  assert.match(diff, /^\+two$/m);
});

test("renderDiff shows modified lines", () => {
  const diff = renderDiff("one\ntwo\n", "one\nthree\n", "/tmp/settings.json");

  assert.match(diff, /^ one$/m);
  assert.match(diff, /^-two$/m);
  assert.match(diff, /^\+three$/m);
});

function claudeEntries(command = "/usr/local/bin/sidelight-claude-code-hook"): JsonInstallEntries {
  const hook = { type: "command", command, async: true };
  return {
    binFilename: "sidelight-claude-code-hook",
    config: {
      hooks: {
        SessionStart: [{ hooks: [hook] }],
        UserPromptSubmit: [{ hooks: [hook] }],
        PreToolUse: [{ matcher: "*", hooks: [hook] }],
        Stop: [{ hooks: [hook] }],
        SessionEnd: [{ hooks: [hook] }],
      },
    },
  };
}

function codexBlock(): string {
  return [
    "[hooks]",
    "SessionStart = [{ hooks = [{ type = \"command\", command = \"/usr/local/bin/sidelight-codex-hook\" }] }]",
    "UserPromptSubmit = [{ hooks = [{ type = \"command\", command = \"/usr/local/bin/sidelight-codex-hook\" }] }]",
    "PreToolUse = [{ matcher = \"*\", hooks = [{ type = \"command\", command = \"/usr/local/bin/sidelight-codex-hook\" }] }]",
    "PostToolUse = [{ matcher = \"*\", hooks = [{ type = \"command\", command = \"/usr/local/bin/sidelight-codex-hook\" }] }]",
    "Stop = [{ hooks = [{ type = \"command\", command = \"/usr/local/bin/sidelight-codex-hook\" }] }]",
    "",
  ].join("\n");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("renderDiff folds unchanged lines and shows only real changes on insertion", () => {
  const before = ["{", '  "a": 1,', '  "b": 2,', '  "c": 3,', '  "d": 4,', '  "e": 5,', '  "f": 6,', '  "g": 7', "}"].join("\n");
  const after = ["{", '  "a": 1,', '  "b": 2,', '  "hooks": {},', '  "c": 3,', '  "d": 4,', '  "e": 5,', '  "f": 6,', '  "g": 7', "}"].join("\n");
  const diff = renderDiff(before, after, "/tmp/x.json");
  assert.match(diff, /\+ {2}"hooks": \{\},/);
  assert.doesNotMatch(diff, /-\s+"c": 3/);
  assert.match(diff, /unchanged line/);
});
