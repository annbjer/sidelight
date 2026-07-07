#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  applyAgentStart,
  applyShutdown,
  applyToolCall,
  applyTurnEnd,
  createSnapshot,
  type SessionSnapshot,
  type StartReason,
} from "../core/snapshot.js";
import { stateDirFor, type StateDirEnv, writeSnapshotSync } from "../core/state-dir.js";

const KNOWN_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "SessionEnd",
]);
const LOCK_RETRIES = 10;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 2_000;

/*
 * Sanitization rules:
 * Only the allowlisted fields represented in SessionSnapshot are ever read from
 * event payloads. Never store message bodies, prompts, tool outputs, bash
 * command strings, or any other input field. Numbers, the model id, the
 * user-authored session name, and deny-list-filtered relative paths are the
 * entire surface.
 */

export function applyHookEvent(
  snapshot: SessionSnapshot | null,
  payload: unknown,
  now: number,
): SessionSnapshot | null {
  if (!isRecord(payload)) return snapshot;

  const eventName = readString(payload.hook_event_name);
  if (eventName === null || !KNOWN_EVENTS.has(eventName)) return snapshot;

  const sessionId = readString(payload.session_id);
  const cwd = readString(payload.cwd);
  if (sessionId === null || cwd === null) return snapshot;

  const safeSessionId = sanitizeSessionId(sessionId);
  const base = snapshot ?? createSnapshot(safeSessionId, cwd, "startup", now, "claude-code");

  if (eventName === "SessionStart") {
    return {
      ...base,
      agent: "claude-code",
      sessionId: safeSessionId,
      cwd,
      name: readString(payload.session_title),
      model: readString(payload.model),
      startReason: startReasonFromSource(payload),
      lastActivityAt: now,
      endedAt: null,
    };
  }

  if (eventName === "UserPromptSubmit") {
    return applyAgentStart(base, undefined, now);
  }

  if (eventName === "Stop") {
    return applyTurnEnd(base, undefined, now);
  }

  if (eventName === "PreToolUse") {
    return applyToolCall(base, readString(payload.tool_name), readToolInputPaths(payload), now);
  }

  return applyShutdown(base, undefined, now);
}

export function processHookPayload(payload: unknown, env: StateDirEnv = process.env, now = Date.now()): SessionSnapshot | null {
  if (!isRecord(payload)) return null;

  const eventName = readString(payload.hook_event_name);
  if (eventName === null || !KNOWN_EVENTS.has(eventName)) return null;

  const sessionId = readString(payload.session_id);
  const cwd = readString(payload.cwd);
  if (sessionId === null || cwd === null) return null;

  const safeSessionId = sanitizeSessionId(sessionId);
  const realCwd = realpathSync(cwd);
  const stateDir = stateDirFor(realCwd, env);
  mkdirSync(stateDir, { recursive: true });

  const lockPath = path.join(stateDir, `${safeSessionId}.lock`);
  return withSessionLock(lockPath, () => {
    const snapshotPath = path.join(stateDir, `${safeSessionId}.json`);
    const existing = loadSnapshot(snapshotPath);
    const next = applyHookEvent(existing, sanitizedPayload(payload, safeSessionId, realCwd), now);
    if (next !== null) {
      writeSnapshotSync(stateDir, realCwd, next);
    }
    return next;
  });
}

function loadSnapshot(snapshotPath: string): SessionSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown;
    return isSessionSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function withSessionLock<T>(lockPath: string, fn: () => T): T {
  acquireLock(lockPath);
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Hook cleanup must never disturb the agent.
    }
  }
}

function acquireLock(lockPath: string): void {
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      return;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if (breakStaleLock(lockPath)) continue;
      sleepSync(LOCK_RETRY_MS);
    }
  }

  writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
}

function breakStaleLock(lockPath: string): boolean {
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs <= STALE_LOCK_MS) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readToolInputPaths(payload: Record<string, unknown>): { path?: string; file_path?: string } {
  const toolInput = payload.tool_input;
  if (!isRecord(toolInput)) return {};

  const sanitized: { path?: string; file_path?: string } = {};
  if (typeof toolInput.path === "string") sanitized.path = toolInput.path;
  if (typeof toolInput.file_path === "string") sanitized.file_path = toolInput.file_path;
  return sanitized;
}

function sanitizedPayload(payload: Record<string, unknown>, sessionId: string, cwd: string): Record<string, unknown> {
  const next: Record<string, unknown> = {
    hook_event_name: readString(payload.hook_event_name),
    session_id: sessionId,
    cwd,
  };

  const model = readString(payload.model);
  if (model !== null) next.model = model;

  const title = readString(payload.session_title);
  if (title !== null) next.session_title = title;

  const toolName = readString(payload.tool_name);
  if (toolName !== null) next.tool_name = toolName;

  const toolInput = readToolInputPaths(payload);
  if (toolInput.path !== undefined || toolInput.file_path !== undefined) {
    next.tool_input = toolInput;
  }

  const source = readString(payload.source);
  if (source !== null) next.source = source;

  return next;
}

function startReasonFromSource(payload: Record<string, unknown>): StartReason {
  // `source` is allowlisted (resolved SPEC-QUESTION, Fable 2026-07-06): a benign
  // lifecycle enum (startup/resume/clear) with no content payload.
  const source = readString(payload.source);
  if (source === "resume") return "resume";
  if (source === "clear") return "new";
  return "startup";
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function printConfig(): void {
  const command = resolvedScriptPath();
  const hook = { type: "command", command, async: true };
  const config = {
    hooks: {
      SessionStart: [{ hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
      PreToolUse: [{ matcher: "*", hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
      SessionEnd: [{ hooks: [hook] }],
    },
  };

  process.stdout.write("// Merge this JSON into your existing ~/.claude/settings.json hooks.\n");
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(
    "Usage: sidelight-claude-code-hook [--print-config|--help]. Without flags, reads one Claude Code hook JSON object from stdin, updates Sidelight's local session snapshot, and exits silently on invalid input.\n",
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "--print-config") {
    printConfig();
    return;
  }
  if (arg === "--help" || arg === "-h") {
    printHelp();
    return;
  }

  const stdin = await readStdin();
  if (stdin.trim() === "") return;

  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return;
  }

  processHookPayload(payload);
}

function resolvedScriptPath(): string {
  const argvPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  const absolute = path.resolve(argvPath);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function isMain(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;

  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(script) === realpathSync(modulePath);
  } catch {
    return path.resolve(script) === modulePath;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  return (
    isRecord(value) &&
    value.v === 1 &&
    typeof value.sessionId === "string" &&
    typeof value.cwd === "string" &&
    isRecord(value.counts) &&
    isRecord(value.tokens) &&
    Array.isArray(value.filesTouched)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

if (isMain()) {
  main().catch(() => {
    // Hooks must never disturb Claude Code sessions.
  });
}
