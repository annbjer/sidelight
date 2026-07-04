import path from "node:path";
import { isDenied } from "../src/denylist.js";

export type StartReason = "startup" | "reload" | "new" | "resume" | "fork";

export interface SessionSnapshot {
  v: 1;
  sessionId: string;
  cwd: string;
  name: string | null;
  model: string | null;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  startReason: StartReason;
  counts: {
    prompts: number;
    turns: number;
    toolCalls: Record<string, number>;
  };
  filesTouched: string[];
  tokens: {
    input: number;
    output: number;
  };
  cost: number;
}

/*
 * Sanitization rules:
 * Only the allowlisted fields represented in SessionSnapshot are ever read from
 * event payloads. Never store message bodies, prompts, tool outputs, bash
 * command strings, or any other input field. Numbers, the model id, the
 * user-authored session name, and deny-list-filtered relative paths are the
 * entire surface.
 */

const FILE_TOOLS = new Set(["read", "write", "edit"]);
const MAX_FILES_TOUCHED = 100;

export function createSnapshot(
  sessionId: string,
  cwd: string,
  startReason: StartReason,
  now: number,
): SessionSnapshot {
  return {
    v: 1,
    sessionId,
    cwd,
    name: null,
    model: null,
    startedAt: now,
    lastActivityAt: now,
    endedAt: null,
    startReason,
    counts: { prompts: 0, turns: 0, toolCalls: {} },
    filesTouched: [],
    tokens: { input: 0, output: 0 },
    cost: 0,
  };
}

export function applyNameChange(snapshot: SessionSnapshot, name: unknown, _now?: number): SessionSnapshot {
  return {
    ...snapshot,
    name: typeof name === "string" ? name : null,
  };
}

export function applyModelSelect(snapshot: SessionSnapshot, modelId: unknown, _now?: number): SessionSnapshot {
  if (typeof modelId !== "string") return snapshot;
  return { ...snapshot, model: modelId };
}

export function applyAgentStart(snapshot: SessionSnapshot, _payload: unknown, now: number): SessionSnapshot {
  return {
    ...snapshot,
    lastActivityAt: now,
    counts: {
      ...snapshot.counts,
      prompts: snapshot.counts.prompts + 1,
    },
  };
}

export function applyTurnEnd(snapshot: SessionSnapshot, usage: unknown, now: number): SessionSnapshot {
  const input = readNumber(usage, "input");
  const output = readNumber(usage, "output");
  const cost = readNestedNumber(usage, "cost", "total");

  return {
    ...snapshot,
    lastActivityAt: now,
    counts: {
      ...snapshot.counts,
      turns: snapshot.counts.turns + 1,
    },
    tokens: {
      input: snapshot.tokens.input + input,
      output: snapshot.tokens.output + output,
    },
    cost: snapshot.cost + cost,
  };
}

export function applyToolCall(
  snapshot: SessionSnapshot,
  toolName: unknown,
  input: unknown,
  _now: number,
): SessionSnapshot {
  if (typeof toolName !== "string") return snapshot;

  const toolCalls = {
    ...snapshot.counts.toolCalls,
    [toolName]: (snapshot.counts.toolCalls[toolName] ?? 0) + 1,
  };
  let filesTouched = snapshot.filesTouched;

  if (FILE_TOOLS.has(toolName)) {
    const relPath = extractRelativeSafePath(snapshot.cwd, input);
    if (
      relPath !== null &&
      filesTouched.length < MAX_FILES_TOUCHED &&
      !filesTouched.includes(relPath)
    ) {
      filesTouched = [...filesTouched, relPath];
    }
  }

  return {
    ...snapshot,
    counts: {
      ...snapshot.counts,
      toolCalls,
    },
    filesTouched,
  };
}

export function applyShutdown(snapshot: SessionSnapshot, _payload: unknown, now: number): SessionSnapshot {
  return { ...snapshot, endedAt: now };
}

function readNumber(value: unknown, key: string): number {
  if (!isRecord(value)) return 0;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function readNestedNumber(value: unknown, key: string, nestedKey: string): number {
  if (!isRecord(value)) return 0;
  return readNumber(value[key], nestedKey);
}

function extractRelativeSafePath(cwd: string, input: unknown): string | null {
  if (!isRecord(input)) return null;

  const rawPath = typeof input.path === "string"
    ? input.path
    : typeof input.file_path === "string"
      ? input.file_path
      : null;
  if (rawPath === null) return null;

  const relative = path.isAbsolute(rawPath) ? path.relative(cwd, rawPath) : rawPath;
  const normalized = path.normalize(relative).replace(/\\/g, "/");
  if (normalized === "" || normalized.startsWith("../") || normalized === "..") return null;
  if (isDenied(normalized)) return null;
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
