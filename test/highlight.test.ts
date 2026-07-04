import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { highlightRow, matchHighlightStyle } from "../src/highlight.js";

test("highlightRow wraps exact-width plain text in inverse video", () => {
  assert.equal(highlightRow("abcdef", 6), "\x1b[7mabcdef\x1b[27m");
});

test("highlightRow pads short plain text to the requested visible width", () => {
  const row = highlightRow("abc", 6);

  assert.equal(row, "\x1b[7mabc   \x1b[27m");
  assert.equal(visibleWidth(row), 6);
});

test("highlightRow truncates and pads through ANSI-containing text", () => {
  const row = highlightRow("\x1b[31mred\x1b[39m", 5);

  assert.equal(visibleWidth(row), 5);
  assert.match(row, /^\x1b\[7m\x1b\[31mred/);
  assert.match(row, /\x1b\[27m$/);
});

test("highlightRow keeps inverse active after ANSI resets inserted during truncation", () => {
  const row = highlightRow("\x1b[31mred\x1b[39m blue", 5);

  assert.equal(visibleWidth(row), 5);
  assert.match(row, /\x1b\[0m\x1b\[7m/);
  assert.match(row, /\x1b\[27m$/);
});

test("matchHighlightStyle uses inverse normally and underline in selected rows", () => {
  assert.deepEqual(matchHighlightStyle(false), { on: "\x1b[7m", off: "\x1b[27m" });
  assert.deepEqual(matchHighlightStyle(true), { on: "\x1b[4m", off: "\x1b[24m" });
});
