import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { applyHookEvent, processHookPayload } from "../adapters/claude-code/index.js";
import { createSnapshot, type SessionSnapshot } from "../adapters/core/snapshot.js";
import { stateDirFor } from "../adapters/core/state-dir.js";

test("applyHookEvent maps SessionStart and defaults missing title/model to null", () => {
  const next = applyHookEvent(null, {
    hook_event_name: "SessionStart",
    session_id: "claude-session",
    cwd: "/tmp/project",
    source: "resume",
  }, 1000);

  assertSnapshot(next);
  assert.equal(next.agent, "claude-code");
  assert.equal(next.name, null);
  assert.equal(next.model, null);
  assert.equal(next.startReason, "resume");
  assert.equal(next.startedAt, 1000);
  assert.equal(next.lastActivityAt, 1000);
  assert.deepEqual(next.tokens, { input: 0, output: 0 });
  assert.equal(next.cost, 0);
});

test("applyHookEvent maps clear SessionStart to new and stores allowlisted metadata", () => {
  const next = applyHookEvent(null, {
    hook_event_name: "SessionStart",
    session_id: "claude-session",
    cwd: "/tmp/project",
    source: "clear",
    model: "claude-sonnet-4-20250514",
    session_title: "Adapter work",
    user_input: "do not read or store",
    transcript_path: "/tmp/transcript.jsonl",
  }, 1000);

  assertSnapshot(next);
  assert.equal(next.name, "Adapter work");
  assert.equal(next.model, "claude-sonnet-4-20250514");
  assert.equal(next.startReason, "new");
  assertNoSensitiveData(next);
});

test("applyHookEvent maps lifecycle events and keeps usage totals at zero", () => {
  let snapshot: SessionSnapshot | null = createSnapshot("claude-session", "/tmp/project", "startup", 1000, "claude-code");

  snapshot = applyHookEvent(snapshot, payload("UserPromptSubmit", { user_input: "secret prompt" }), 2000);
  snapshot = applyHookEvent(snapshot, payload("Stop", { last_assistant_message: "secret answer" }), 3000);
  snapshot = applyHookEvent(snapshot, payload("SessionEnd"), 4000);

  assertSnapshot(snapshot);
  assert.equal(snapshot.counts.prompts, 1);
  assert.equal(snapshot.counts.turns, 1);
  assert.equal(snapshot.endedAt, 4000);
  assert.deepEqual(snapshot.tokens, { input: 0, output: 0 });
  assert.equal(snapshot.cost, 0);
  assertNoSensitiveData(snapshot);
});

test("applyHookEvent maps PreToolUse with only allowed tool_input paths", () => {
  const next = applyHookEvent(createSnapshot("claude-session", "/tmp/project", "startup", 1000, "claude-code"), {
    hook_event_name: "PreToolUse",
    session_id: "claude-session",
    cwd: "/tmp/project",
    tool_name: "Read",
    tool_input: {
      file_path: "/tmp/project/src/index.ts",
      content: "secret file content",
      command: "cat .env.local",
    },
    transcript_path: "/tmp/transcript.jsonl",
  }, 2000);

  assertSnapshot(next);
  assert.deepEqual(next.counts.toolCalls, { Read: 1 });
  assert.deepEqual(next.filesTouched, ["src/index.ts"]);
  assertNoSensitiveData(next);
});

test("applyHookEvent excludes deny-listed file paths", () => {
  const next = applyHookEvent(createSnapshot("claude-session", "/tmp/project", "startup", 1000, "claude-code"), {
    hook_event_name: "PreToolUse",
    session_id: "claude-session",
    cwd: "/tmp/project",
    tool_name: "Read",
    tool_input: { path: "/tmp/project/.env.local" },
  }, 2000);

  assertSnapshot(next);
  assert.deepEqual(next.counts.toolCalls, { Read: 1 });
  assert.deepEqual(next.filesTouched, []);
});

test("applyHookEvent ignores unknown events", () => {
  const snapshot = createSnapshot("claude-session", "/tmp/project", "startup", 1000, "claude-code");

  assert.equal(applyHookEvent(snapshot, payload("PostToolUse"), 2000), snapshot);
  assert.equal(applyHookEvent(null, payload("PostToolUse"), 2000), null);
});

test("processHookPayload serializes sequential invocations with a per-session lock", async (t) => {
  const fixture = await tempFixture(t, "sidelight-claude-lock-");

  processHookPayload({
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-session",
    cwd: fixture.project,
  }, fixture.env, 1000);
  processHookPayload({
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-session",
    cwd: fixture.project,
  }, fixture.env, 2000);

  const snapshot = await readSnapshot(fixture.stateDir, "claude-session");
  assert.equal(snapshot.counts.prompts, 2);
  assert.equal(snapshot.lastActivityAt, 2000);
});

test("processHookPayload breaks stale locks", async (t) => {
  const fixture = await tempFixture(t, "sidelight-claude-stale-lock-");
  await mkdir(fixture.stateDir, { recursive: true });
  const lockPath = join(fixture.stateDir, "claude-session.lock");
  await writeFile(lockPath, "stale\n", "utf8");
  const stale = new Date(Date.now() - 3000);
  await utimes(lockPath, stale, stale);

  processHookPayload({
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-session",
    cwd: fixture.project,
  }, fixture.env, 1000);

  const snapshot = await readSnapshot(fixture.stateDir, "claude-session");
  assert.equal(snapshot.counts.prompts, 1);
  await assert.rejects(readFile(lockPath, "utf8"));
});

test("compiled Claude Code hook reads stdin and writes a snapshot", async (t) => {
  const fixture = await tempFixture(t, "sidelight-claude-e2e-");
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "claude-code", "index.js");

  const result = await spawnHook(bin, {
    hook_event_name: "SessionStart",
    session_id: "claude-session",
    cwd: fixture.project,
    model: "claude-sonnet-4-20250514",
    session_title: "Live adapter",
  }, fixture.env);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const snapshot = await readSnapshot(fixture.stateDir, "claude-session");
  assert.equal(snapshot.agent, "claude-code");
  assert.equal(snapshot.name, "Live adapter");
  assert.equal(snapshot.model, "claude-sonnet-4-20250514");
});

test("--print-config prints Claude settings hooks for all supported events", async () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters", "claude-code", "index.js");
  const child = spawn(process.execPath, [bin, "--print-config"], { stdio: ["ignore", "pipe", "pipe"] });
  const result = await collect(child);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Merge this JSON into your existing ~\/\.claude\/settings\.json hooks\./);
  assert.match(result.stdout, /"SessionStart"/);
  assert.match(result.stdout, /"UserPromptSubmit"/);
  assert.match(result.stdout, /"PreToolUse"/);
  assert.match(result.stdout, /"matcher": "\*"/);
  assert.match(result.stdout, /"Stop"/);
  assert.match(result.stdout, /"SessionEnd"/);
  assert.match(result.stdout, /"async": true/);
});

function payload(hook_event_name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name,
    session_id: "claude-session",
    cwd: "/tmp/project",
    ...overrides,
  };
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
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("transcript"), false);
  assert.equal(serialized.includes("command"), false);
  assert.equal(serialized.includes(".env.local"), false);
}
