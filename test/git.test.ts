import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  filterDeniedMatches,
  filterDeniedStatus,
  getDiffStats,
  parseGrepOutput,
  parseNumstat,
  parsePorcelainV2,
} from "../src/git.js";

test("parses clean branch headers with upstream and ahead/behind", () => {
  const status = parsePorcelainV2(`# branch.oid 0123456789abcdef
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
`);

  assert.deepEqual(status.branch, {
    head: "main",
    oid: "0123456789abcdef",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    detached: false,
  });
  assert.deepEqual(status.staged, []);
  assert.deepEqual(status.unstaged, []);
  assert.deepEqual(status.untracked, []);
  assert.deepEqual(status.conflicted, []);
});

test("parses staged, unstaged, and untracked entries", () => {
  const status = parsePorcelainV2(`# branch.oid abcdef0123456789
# branch.head feature
1 M. N... 100644 100644 100644 aaaaaa bbbbbb src/staged.ts
1 .M N... 100644 100644 100644 aaaaaa aaaaaa src/unstaged.ts
1 AM N... 100644 100644 100644 aaaaaa bbbbbb src/both.ts
? src/new-file.ts
! ignored.log
`);

  assert.deepEqual(status.staged, [
    { path: "src/staged.ts", status: "M" },
    { path: "src/both.ts", status: "A" },
  ]);
  assert.deepEqual(status.unstaged, [
    { path: "src/unstaged.ts", status: "M" },
    { path: "src/both.ts", status: "M" },
  ]);
  assert.deepEqual(status.untracked, [{ path: "src/new-file.ts", status: "?" }]);
  assert.equal(status.dirty, true);
});

test("parses rename entries with original path", () => {
  const status = parsePorcelainV2(`# branch.oid abcdef0123456789
# branch.head feature
2 R. N... 100644 100644 100644 aaaaaa bbbbbb R100 src/new-name.ts\tsrc/old-name.ts
`);

  assert.deepEqual(status.staged, [
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      status: "R",
    },
  ]);
  assert.deepEqual(status.unstaged, []);
});

test("parses unmerged conflict entries", () => {
  const status = parsePorcelainV2(`# branch.oid abcdef0123456789
# branch.head feature
u UU N... 100644 100644 100644 100644 aaaaaa bbbbbb cccccc src/conflict.ts
`);

  assert.deepEqual(status.conflicted, [{ path: "src/conflict.ts", status: "UU" }]);
});

test("parses detached HEAD", () => {
  const status = parsePorcelainV2(`# branch.oid fedcba9876543210
# branch.head (detached)
1 .M N... 100644 100644 100644 aaaaaa aaaaaa README.md
`);

  assert.deepEqual(status.branch, {
    head: null,
    oid: "fedcba9876543210",
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: true,
  });
  assert.deepEqual(status.unstaged, [{ path: "README.md", status: "M" }]);
});

test("filters denied paths from every status section while preserving clean entries", () => {
  const status = filterDeniedStatus(
    parsePorcelainV2(`# branch.oid abcdef0123456789
# branch.head feature
1 A. N... 100644 100644 100644 aaaaaa bbbbbb .env
1 M. N... 100644 100644 100644 aaaaaa bbbbbb src/clean-staged.ts
1 .M N... 100644 100644 100644 aaaaaa aaaaaa notes.key
1 .M N... 100644 100644 100644 aaaaaa aaaaaa src/clean-unstaged.ts
2 R. N... 100644 100644 100644 aaaaaa bbbbbb R100 src/public-cert.txt\tsecrets.pem
? src/clean-untracked.ts
? .env.local
u UU N... 100644 100644 100644 100644 aaaaaa bbbbbb cccccc src/clean-conflict.ts
u UU N... 100644 100644 100644 100644 aaaaaa bbbbbb cccccc private.key
`),
  );

  assert.deepEqual(status.staged, [{ path: "src/clean-staged.ts", status: "M" }]);
  assert.deepEqual(status.unstaged, [{ path: "src/clean-unstaged.ts", status: "M" }]);
  assert.deepEqual(status.untracked, [{ path: "src/clean-untracked.ts", status: "?" }]);
  assert.deepEqual(status.conflicted, [{ path: "src/clean-conflict.ts", status: "UU" }]);
  assert.equal(status.dirty, true);
});

test("filters denied grep content matches", () => {
  const parsed = parseGrepOutput(`src/app.ts:4:2:token
.env.local:1:1:token=secret
src/config.ts:9:8:token
`);

  assert.deepEqual(filterDeniedMatches(parsed.matches), [
    { path: "src/app.ts", line: 4, col: 2, text: "token" },
    { path: "src/config.ts", line: 9, col: 8, text: "token" },
  ]);
});

test("parses regular numstat entries", () => {
  assert.deepEqual(parseNumstat("12\t3\tsrc/app.ts\0"), [
    { path: "src/app.ts", added: 12, deleted: 3, binary: false },
  ]);
});

test("parses rename numstat entries in -z two-path form", () => {
  assert.deepEqual(parseNumstat("5\t1\t\0src/old-name.ts\0src/new-name.ts\0"), [
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      added: 5,
      deleted: 1,
      binary: false,
    },
  ]);
});

test("parses binary numstat entries", () => {
  assert.deepEqual(parseNumstat("-\t-\tassets/image.png\0"), [
    { path: "assets/image.png", added: null, deleted: null, binary: true },
  ]);
});

test("getDiffStats filters denied paths from staged and unstaged stats", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sidelight-diff-stats-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  await git(dir, ["init"]);
  await writeFile(join(dir, "public.ts"), "one\n", "utf8");
  await writeFile(join(dir, ".env.local"), "secret=one\n", "utf8");
  await git(dir, ["add", "public.ts", ".env.local"]);
  await writeFile(join(dir, "public.ts"), "one\ntwo\n", "utf8");
  await writeFile(join(dir, ".env.local"), "secret=two\n", "utf8");

  const result = await getDiffStats(dir);

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    return;
  }
  assert.deepEqual(result.stats.staged.map((stat) => stat.path), ["public.ts"]);
  assert.deepEqual(result.stats.unstaged.map((stat) => stat.path), ["public.ts"]);
});

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, shell: false }, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
