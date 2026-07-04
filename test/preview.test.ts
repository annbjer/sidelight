import assert from "node:assert/strict";
import { test } from "node:test";
import {
  colorizeDiffLine,
  formatPreviewLine,
  loadDiff,
  loadPreview,
  movePreviewCursor,
  previewWindow,
  renderPreview,
  sniffBinary,
  targetCursorLine,
  type PreviewState,
} from "../src/preview.js";

test("sniffBinary treats empty and text buffers as text", () => {
  assert.equal(sniffBinary(new Uint8Array()), false);
  assert.equal(sniffBinary(Buffer.from("hello\nworld\n", "utf8")), false);
});

test("sniffBinary detects NUL in the first 8192 bytes", () => {
  const buf = Buffer.alloc(8192, 65);
  buf[8191] = 0;
  assert.equal(sniffBinary(buf), true);
});

test("sniffBinary ignores NUL after the first 8192 bytes", () => {
  const buf = Buffer.alloc(8193, 65);
  buf[8192] = 0;
  assert.equal(sniffBinary(buf), false);
});

test("previewWindow clamps target near top", () => {
  assert.equal(previewWindow(100, 1, 10), 0);
  assert.equal(previewWindow(100, 3, 10), 0);
});

test("previewWindow centers middle targets", () => {
  assert.equal(previewWindow(100, 50, 10), 44);
  assert.equal(previewWindow(100, 50, 9), 45);
});

test("previewWindow clamps target near bottom", () => {
  assert.equal(previewWindow(100, 100, 10), 90);
  assert.equal(previewWindow(100, 98, 10), 90);
});

test("previewWindow returns zero for short files", () => {
  assert.equal(previewWindow(3, 2, 10), 0);
  assert.equal(previewWindow(0, 1, 10), 0);
});

test("formatPreviewLine right-aligns the gutter and highlights matches", () => {
  assert.equal(formatPreviewLine(7, "see README.md", 3, 80, "readme"), "    7 │ see \x1b[7mREADME\x1b[27m.md");
  assert.equal(formatPreviewLine(12, "plain", 3, 80), "   12 │ plain");
});

test("formatPreviewLine highlights the selected line and underlines matches inside it", () => {
  assert.equal(
    formatPreviewLine(7, "see README.md", 3, 24, "readme", true),
    "\x1b[7m    7 │ see \x1b[4mREADME\x1b[24m.md   \x1b[27m",
  );
});

test("renderPreview breadcrumb reports the cursor line and highlights that line", () => {
  const state: PreviewState = {
    path: "src/app.ts",
    lines: ["one", "two", "three"],
    scrollOffset: 0,
    cursorLine: 1,
  };

  assert.deepEqual(renderPreview(state, 24, 4), [
    "src/app.ts · line 2/3",
    "  1 │ one",
    "\x1b[7m  2 │ two               \x1b[27m",
    "  3 │ three",
  ]);
});

test("movePreviewCursor moves, clamps, and scrolls minimally", () => {
  const state: PreviewState = {
    path: "src/app.ts",
    lines: ["one", "two", "three", "four", "five"],
    scrollOffset: 0,
    cursorLine: 0,
  };

  movePreviewCursor(state, 3, "down");
  assert.equal(state.cursorLine, 1);
  assert.equal(state.scrollOffset, 0);

  movePreviewCursor(state, 3, "down");
  movePreviewCursor(state, 3, "down");
  assert.equal(state.cursorLine, 3);
  assert.equal(state.scrollOffset, 1);

  movePreviewCursor(state, 3, "up");
  assert.equal(state.cursorLine, 2);
  assert.equal(state.scrollOffset, 1);

  movePreviewCursor(state, 3, "bottom");
  assert.equal(state.cursorLine, 4);
  assert.equal(state.scrollOffset, 2);

  movePreviewCursor(state, 3, "top");
  assert.equal(state.cursorLine, 0);
  assert.equal(state.scrollOffset, 0);
});

test("targetCursorLine converts matched target lines to clamped zero-based cursor lines", () => {
  assert.equal(targetCursorLine(10, 4), 3);
  assert.equal(targetCursorLine(10, 0), 0);
  assert.equal(targetCursorLine(10, 99), 9);
  assert.equal(targetCursorLine(0, 4), 0);
});

test("loadPreview refuses denied paths before filesystem access", async () => {
  const state = await loadPreview("/nonexistent", { path: ".env.local", targetLine: 1 }, 20);

  assert.deepEqual(state, {
    path: ".env.local",
    lines: ["deny-listed file — no preview"],
    scrollOffset: 0,
    cursorLine: 0,
    highlightQuery: undefined,
  });
});

test("colorizeDiffLine colors body changes and hunks only", () => {
  assert.equal(colorizeDiffLine("+added"), "\x1b[32m+added\x1b[39m");
  assert.equal(colorizeDiffLine("-removed"), "\x1b[31m-removed\x1b[39m");
  assert.equal(colorizeDiffLine("@@ -1 +1 @@"), "\x1b[2m@@ -1 +1 @@\x1b[22m");
  assert.equal(colorizeDiffLine("+++ b/src/app.ts"), "+++ b/src/app.ts");
  assert.equal(colorizeDiffLine("--- a/src/app.ts"), "--- a/src/app.ts");
});

test("loadDiff refuses denied paths before spawning git", async () => {
  const state = await loadDiff("/nonexistent", { kind: "diff", path: ".env.local", targetLine: 1 }, 20);

  assert.deepEqual(state, {
    path: ".env.local",
    lines: ["deny-listed file — no preview"],
    scrollOffset: 0,
    cursorLine: 0,
    breadcrumbKind: "unstaged diff",
  });
});
