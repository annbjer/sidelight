import assert from "node:assert/strict";
import { test } from "node:test";
import { HELP_TEXT, parseArgs } from "../src/index.js";

test("defaults directory to cwd", () => {
  assert.deepEqual(parseArgs([], "/tmp/project"), {
    kind: "run",
    dir: "/tmp/project",
  });
});

test("resolves provided directory from cwd", () => {
  assert.deepEqual(parseArgs(["src"], "/tmp/project"), {
    kind: "run",
    dir: "/tmp/project/src",
  });
});

test("keeps absolute provided directory", () => {
  assert.deepEqual(parseArgs(["/var/tmp"], "/tmp/project"), {
    kind: "run",
    dir: "/var/tmp",
  });
});

test("--help requests help", () => {
  assert.deepEqual(parseArgs(["--help"], "/tmp/project"), { kind: "help" });
  assert.match(HELP_TEXT, /Usage: sidelight \[dir\]/);
});

test("--version requests version", () => {
  assert.deepEqual(parseArgs(["--version"], "/tmp/project"), { kind: "version" });
});

test("unknown flag returns error", () => {
  assert.deepEqual(parseArgs(["--wat"], "/tmp/project"), {
    kind: "error",
    message: "unknown option: --wat",
  });
});

test("more than one directory returns error", () => {
  assert.deepEqual(parseArgs(["one", "two"], "/tmp/project"), {
    kind: "error",
    message: "expected at most one directory argument",
  });
});
