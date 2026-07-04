import assert from "node:assert/strict";
import { test } from "node:test";
import { isDenied } from "../src/denylist.js";

test("denies sensitive path segments", () => {
  assert.equal(isDenied("node_modules/x/y.js"), true);
  assert.equal(isDenied(".git/config"), true);
});

test("denies sensitive basenames", () => {
  assert.equal(isDenied(".env.local"), true);
  assert.equal(isDenied("server.key"), true);
  assert.equal(isDenied("id_rsa_backup"), true);
  assert.equal(isDenied(".DS_Store"), true);
});

test("allows lookalike names", () => {
  assert.equal(isDenied("envelope.ts"), false);
  assert.equal(isDenied("monkey.tsx"), false);
  assert.equal(isDenied("keys.md"), false);
});
