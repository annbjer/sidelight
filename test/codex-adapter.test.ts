import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { applyHookEvent } from "../adapters/codex/index.js";
import { type SessionSnapshot } from "../adapters/core/snapshot.js";
import { stateDirFor } from "../adapters/core/state-dir.js";

test("applyHookEvent maps captured Codex SessionStart fixture", async () => {
  const payload = await fixture("session-start.json");
  const next = applyHookEvent(null, payload, 1000);

  assertSnapshot(next);
  assert.equal(next.agent, "codex");
  assert.equal(next.sessionId, "019f3d6d-de2c-7f50-9227-a197949c6301");
  assert.equal(next.cwd, "/private/tmp/sidelight-codex-capture/work");
  assert.equal(next.name, null);
  assert.equal(next.model, "gpt-5.5");
  assert.equal(next.startReason, "startup");
  assert.equal(next.startedAt, 1000);
  assert.equal(next.lastActivityAt, 1000);
  assert.deepEqual(next.tokens, { input: 0, output: 0 });
  assert.equal(next.cost, 0);
  assertNoSensitiveData(next);
});

test("applyHookEvent maps captured Codex UserPromptSubmit fixture without storing prompt text", async () => {
  const start = applyHookEvent(null, await fixture("session-start.json"), 1000);
  const next = applyHookEvent(start, await fixture("user-prompt-submit.json"), 2000);

  assertSnapshot(next);
  assert.equal(next.counts.prompts, 1);
  assert.equal(next.counts.turns, 0);
  assert.equal(next.lastActivityAt, 2000);
  assertNoSensitiveData(next);
});

test("compiled Codex hook reads a captured fixture on stdin and writes a snapshot", async (t) => {
  const temp = await tempFixture(t, "sidelight-codex-e2e-");
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "codex", "index.js");
  const payload = {
    ...await fixture("session-start.json"),
    cwd: temp.project,
  };

  const result = await spawnHook(bin, payload, temp.env);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const snapshot = await readSnapshot(temp.stateDir, "019f3d6d-de2c-7f50-9227-a197949c6301");
  assert.equal(snapshot.agent, "codex");
  assert.equal(snapshot.model, "gpt-5.5");
  assert.equal(snapshot.name, null);
  assertNoSensitiveData(snapshot);
});

test("--print-config prints Codex config.toml hooks for supported events", async () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "codex", "index.js");
  const child = spawn(process.execPath, [bin, "--print-config"], { stdio: ["ignore", "pipe", "pipe"] });
  const result = await collect(child);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Merge this \[hooks\] table into your existing ~\/\.codex\/config\.toml\./);
  assert.match(result.stdout, /^\[hooks\]$/m);
  assert.match(result.stdout, /SessionStart = \[/);
  assert.match(result.stdout, /UserPromptSubmit = \[/);
  assert.match(result.stdout, /PreToolUse = \[/);
  assert.match(result.stdout, /PostToolUse = \[/);
  assert.match(result.stdout, /Stop = \[/);
  assert.match(result.stdout, /matcher = "\*"/);
  assert.match(result.stdout, /type = "command"/);
  assert.match(result.stdout, /command = ".+\/adapters\/codex\/index\.js"/);
});

test("--help describes Codex hook usage and install flags", async () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "codex", "index.js");
  const child = spawn(process.execPath, [bin, "--help"], { stdio: ["ignore", "pipe", "pipe"] });
  const result = await collect(child);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Usage: sidelight-codex-hook \[--print-config\|--install\|--uninstall\|--help\]\./);
  assert.match(result.stdout, /--install\s+Print the config diff/);
  assert.match(result.stdout, /--uninstall\s+Print the config diff/);
});

async function fixture(name: string): Promise<Record<string, unknown>> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const raw = await readFile(join(root, "test", "fixtures", "codex-hooks", name), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function tempFixture(t: TestContext, prefix: string): Promise<{
  root: string;
  project: string;
  stateHome: string;
  stateDir: string;
  env: { HOME: string; XDG_STATE_HOME: string };
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const project = join(root, "project");
  const stateHome = join(root, "state");
  await mkdir(project);
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    project,
    stateHome,
    stateDir: stateDirFor(realpathSync(project), { XDG_STATE_HOME: stateHome, HOME: root }),
    env: { HOME: root, XDG_STATE_HOME: stateHome },
  };
}

async function readSnapshot(stateDir: string, sessionId: string): Promise<SessionSnapshot> {
  const parsed = JSON.parse(await readFile(join(stateDir, `${sessionId}.json`), "utf8")) as unknown;
  assertSnapshot(parsed);
  return parsed;
}

async function spawnHook(
  bin: string,
  fixturePayload: Record<string, unknown>,
  env: { HOME: string; XDG_STATE_HOME: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [bin], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(`${JSON.stringify(fixturePayload)}\n`);
  return collect(child);
}

async function collect(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });
  return { code, stdout, stderr };
}

function assertSnapshot(value: unknown): asserts value is SessionSnapshot {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal((value as SessionSnapshot).v, 1);
}

function assertNoSensitiveData(snapshot: SessionSnapshot): void {
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("Reply with ok only"), false);
  assert.equal(serialized.includes("transcript"), false);
  assert.equal(serialized.includes("permission"), false);
  assert.equal(serialized.includes("bypassPermissions"), false);
}
