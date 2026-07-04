import assert from "node:assert/strict";
import { test } from "node:test";
import { jumpIndex, jumpScrollOffset } from "../src/navigation.js";

test("jumpIndex clamps empty lists and jumps to list bounds", () => {
  assert.equal(jumpIndex(0, "top"), 0);
  assert.equal(jumpIndex(0, "bottom"), 0);
  assert.equal(jumpIndex(5, "top"), 0);
  assert.equal(jumpIndex(5, "bottom"), 4);
});

test("jumpScrollOffset clamps top and bottom to scrollable bounds", () => {
  assert.equal(jumpScrollOffset(100, 10, "top"), 0);
  assert.equal(jumpScrollOffset(100, 10, "bottom"), 90);
  assert.equal(jumpScrollOffset(3, 10, "bottom"), 0);
  assert.equal(jumpScrollOffset(3, 0, "bottom"), 2);
});
