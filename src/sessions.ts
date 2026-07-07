import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { stateDirFor } from "../adapters/core/state-dir.js";

export type SnapshotAgent = "pi" | "claude-code" | "codex";

export interface SessionSnapshotView {
  v: 1;
  agent?: SnapshotAgent;
  sessionId: string;
  cwd: string;
  name: string | null;
  model: string | null;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  startReason: string;
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

export type SessionRow =
  | { kind: "snapshot"; path: string; snapshot: SessionSnapshotView }
  | { kind: "unknown-version"; path: string; sessionId: string; version: unknown; lastActivityAt: number };

export interface SessionRowLabel {
  marker: "●" | "○";
  displayName: string;
  age: string;
  prompts: string;
  model: string;
  cost: string;
  agent: SnapshotAgent;
  parts: string[];
  text: string;
}

export function stateDirForProjectDir(projectDir: string): string {
  return stateDirFor(realpathSync(projectDir));
}

export async function loadSnapshots(stateDir: string): Promise<SessionRow[]> {
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    return [];
  }

  const rows = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json") && entry !== "dir.json")
      .map(async (entry): Promise<SessionRow | null> => {
        const path = join(stateDir, entry);
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(path, "utf8"));
        } catch {
          return null;
        }

        if (!isRecord(parsed)) {
          return null;
        }

        if (parsed.v !== 1) {
          return {
            kind: "unknown-version",
            path,
            sessionId: readString(parsed.sessionId) ?? basename(entry, ".json"),
            version: parsed.v,
            lastActivityAt: readFiniteNumber(parsed.lastActivityAt) ?? 0,
          };
        }

        const snapshot = parseV1Snapshot(parsed);
        return snapshot === null ? null : { kind: "snapshot", path, snapshot };
      }),
  );

  return rows
    .filter((row): row is SessionRow => row !== null)
    .sort((a, b) => lastActivityFor(b) - lastActivityFor(a));
}

export function sessionRowLabel(snapshot: SessionSnapshotView, nowMs: number): SessionRowLabel {
  const marker = snapshot.endedAt === null ? "●" : "○";
  const displayName = snapshot.name ?? snapshot.sessionId.slice(0, 8);
  const age = relativeAge(snapshot.lastActivityAt, nowMs);
  const prompts = `${snapshot.counts.prompts} ${snapshot.counts.prompts === 1 ? "prompt" : "prompts"}`;
  const model = shortModel(snapshot.model);
  const cost = formatCost(snapshot.cost);
  const agent = agentForDisplay(snapshot);
  const agePart = age === "now" ? "now" : `${age} ago`;
  const parts = [`${marker} ${displayName}`, agePart, prompts, model, cost];
  if (snapshot.agent !== undefined && snapshot.agent !== "pi") {
    parts.push(snapshot.agent);
  }
  return {
    marker,
    displayName,
    age,
    prompts,
    model,
    cost,
    agent,
    parts,
    text: parts.join(" · "),
  };
}

function parseV1Snapshot(value: Record<string, unknown>): SessionSnapshotView | null {
  const sessionId = readString(value.sessionId);
  const cwd = readString(value.cwd);
  const name = readNullableString(value.name);
  const model = readNullableString(value.model);
  const startedAt = readFiniteNumber(value.startedAt);
  const lastActivityAt = readFiniteNumber(value.lastActivityAt);
  const endedAt = readNullableNumber(value.endedAt);
  const startReason = readString(value.startReason);
  const counts = parseCounts(value.counts);
  const filesTouched = parseStringArray(value.filesTouched);
  const tokens = parseTokens(value.tokens);
  const cost = readFiniteNumber(value.cost);
  const agent = readAgent(value.agent);

  if (
    sessionId === null ||
    cwd === null ||
    name === undefined ||
    model === undefined ||
    startedAt === null ||
    lastActivityAt === null ||
    endedAt === undefined ||
    startReason === null ||
    counts === null ||
    filesTouched === null ||
    tokens === null ||
    cost === null
  ) {
    return null;
  }

  return {
    v: 1,
    ...(agent === undefined ? {} : { agent }),
    sessionId,
    cwd,
    name,
    model,
    startedAt,
    lastActivityAt,
    endedAt,
    startReason,
    counts,
    filesTouched,
    tokens,
    cost,
  };
}

export function agentForDisplay(snapshot: SessionSnapshotView): SnapshotAgent {
  return snapshot.agent ?? "pi";
}

function readAgent(value: unknown): SnapshotAgent | undefined {
  return value === "pi" || value === "claude-code" || value === "codex" ? value : undefined;
}

function parseCounts(value: unknown): SessionSnapshotView["counts"] | null {
  if (!isRecord(value)) return null;
  const prompts = readFiniteNumber(value.prompts);
  const turns = readFiniteNumber(value.turns);
  if (prompts === null || turns === null || !isRecord(value.toolCalls)) return null;

  const toolCalls: Record<string, number> = {};
  for (const [tool, count] of Object.entries(value.toolCalls)) {
    const parsed = readFiniteNumber(count);
    if (parsed === null) return null;
    toolCalls[tool] = parsed;
  }
  return { prompts, turns, toolCalls };
}

function parseTokens(value: unknown): SessionSnapshotView["tokens"] | null {
  if (!isRecord(value)) return null;
  const input = readFiniteNumber(value.input);
  const output = readFiniteNumber(value.output);
  return input === null || output === null ? null : { input, output };
}

function parseStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

function lastActivityFor(row: SessionRow): number {
  return row.kind === "snapshot" ? row.snapshot.lastActivityAt : row.lastActivityAt;
}

function relativeAge(lastActivityAt: number, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - lastActivityAt);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function shortModel(model: string | null): string {
  if (model === null || model.length === 0) return "unknown";
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return "$0.00";
  return `$${cost.toFixed(2)}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function readNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
