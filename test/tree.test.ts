import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTree, findVisibleParentDirIndex, flattenTree } from "../src/tree.js";

test("buildTree sorts directories first, then files alphabetically", () => {
  const root = buildTree(["zeta.ts", "src/index.ts", "README.md", "docs/spec.md", "src/app.ts"]);

  assert.deepEqual(
    root.children.map((node) => `${node.type}:${node.path}`),
    ["dir:docs", "dir:src", "file:README.md", "file:zeta.ts"],
  );
  assert.deepEqual(
    root.children.find((node) => node.path === "src")?.children.map((node) => node.path),
    ["src/app.ts", "src/index.ts"],
  );
});

test("flattenTree expands top-level directories by default", () => {
  const root = buildTree(["src/panels/files.ts", "src/app.ts", "README.md"]);
  const rows = flattenTree(root, (_path, depth) => depth === 0);

  assert.deepEqual(
    rows.map((row) => `${row.depth}:${row.type}:${row.path}:${row.expanded}`),
    [
      "0:dir:src:true",
      "1:dir:src/panels:false",
      "1:file:src/app.ts:false",
      "0:file:README.md:false",
    ],
  );
});

test("flattenTree expands nested directories when requested", () => {
  const root = buildTree(["src/panels/files.ts", "src/panels/git.ts", "src/app.ts"]);
  const rows = flattenTree(root, (path, depth) => depth === 0 || path === "src/panels");

  assert.deepEqual(
    rows.map((row) => `${row.depth}:${row.type}:${row.path}:${row.expanded}`),
    [
      "0:dir:src:true",
      "1:dir:src/panels:true",
      "2:file:src/panels/files.ts:false",
      "2:file:src/panels/git.ts:false",
      "1:file:src/app.ts:false",
    ],
  );
});

test("flattenTree respects explicitly collapsed top-level directories", () => {
  const root = buildTree(["src/panels/files.ts", "src/app.ts", "README.md"]);
  const rows = flattenTree(root, (path, depth) => depth === 0 && path !== "src");

  assert.deepEqual(
    rows.map((row) => `${row.depth}:${row.type}:${row.path}:${row.expanded}`),
    [
      "0:dir:src:false",
      "0:file:README.md:false",
    ],
  );
});

test("findVisibleParentDirIndex finds the visible parent of nested rows", () => {
  const root = buildTree(["src/panels/files.ts", "src/panels/git.ts", "src/app.ts"]);
  const rows = flattenTree(root, (path, depth) => depth === 0 || path === "src/panels");

  assert.equal(findVisibleParentDirIndex(rows, rows.findIndex((row) => row.path === "src/panels/files.ts")), 1);
  assert.equal(findVisibleParentDirIndex(rows, rows.findIndex((row) => row.path === "src/app.ts")), 0);
});

test("findVisibleParentDirIndex returns -1 for top-level rows", () => {
  const root = buildTree(["src/app.ts", "README.md"]);
  const rows = flattenTree(root, (_path, depth) => depth === 0);

  assert.equal(findVisibleParentDirIndex(rows, rows.findIndex((row) => row.path === "src")), -1);
  assert.equal(findVisibleParentDirIndex(rows, rows.findIndex((row) => row.path === "README.md")), -1);
});
