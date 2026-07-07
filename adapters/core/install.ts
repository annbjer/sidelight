import { createInterface } from "node:readline/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

type JsonObject = Record<string, unknown>;

export interface JsonInstallEntries {
  binFilename: string;
  config: {
    hooks: JsonObject;
  };
}

export type TextComputeResult =
  | { ok: true; merged: string; changed: boolean }
  | { ok: false; code: string; message: string };

export function computeJsonMerge(existingText: string | null, entries: JsonInstallEntries): TextComputeResult {
  const parsed = parseSettingsJson(existingText);
  if (!parsed.ok) return parsed;

  const settings = parsed.value;
  const hooks = ensureObject(settings, "hooks");
  const desiredCommands = commandsFromHooks(entries.config.hooks);
  let changed = false;

  for (const [eventName, desiredGroups] of Object.entries(entries.config.hooks)) {
    if (!Array.isArray(desiredGroups)) continue;

    const existingGroups = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
    if (!Array.isArray(hooks[eventName])) {
      hooks[eventName] = existingGroups;
      changed = true;
    }

    for (const desiredGroup of desiredGroups) {
      if (!isRecord(desiredGroup)) continue;
      if (eventHasOwnedHook(existingGroups, entries.binFilename, desiredCommands)) continue;

      const desiredHooks = Array.isArray(desiredGroup.hooks) ? desiredGroup.hooks : [];
      const group = findMatchingGroup(existingGroups, desiredGroup);
      if (group !== null && Array.isArray(group.hooks)) {
        group.hooks.push(...cloneJsonArray(desiredHooks));
      } else if (group !== null) {
        group.hooks = cloneJsonArray(desiredHooks);
      } else {
        existingGroups.push(cloneJson(desiredGroup));
      }
      changed = true;
    }
  }

  return { ok: true, merged: serializeJson(settings), changed };
}

export function computeJsonRemoval(existingText: string | null, binFilename: string): TextComputeResult {
  const parsed = parseSettingsJson(existingText);
  if (!parsed.ok) return parsed;

  const settings = parsed.value;
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return { ok: true, merged: serializeJson(settings), changed: false };

  let changed = false;
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;

    const keptGroups: unknown[] = [];
    let eventChanged = false;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }

      const beforeLength = group.hooks.length;
      const keptHooks = group.hooks.filter((hook) => !isOwnedHook(hook, binFilename, []));
      if (keptHooks.length !== beforeLength) {
        changed = true;
        eventChanged = true;
      }
      if (keptHooks.length > 0 || keptHooks.length === beforeLength) {
        keptGroups.push({ ...group, hooks: keptHooks });
      }
    }

    if (keptGroups.length > 0 || !eventChanged) {
      hooks[eventName] = keptGroups;
    } else {
      delete hooks[eventName];
    }
  }

  if (changed && Object.keys(hooks).length === 0) delete settings.hooks;
  return { ok: true, merged: serializeJson(settings), changed };
}

export function renderDiff(before: string | null, after: string, configPath: string): string {
  const beforeLines = splitLines(before ?? "");
  const afterLines = splitLines(after);
  const out = [
    `--- ${configPath}${before === null ? " (missing)" : ""}`,
    `+++ ${configPath}`,
  ];
  const max = Math.max(beforeLines.length, afterLines.length);

  for (let i = 0; i < max; i += 1) {
    const oldLine = beforeLines[i];
    const newLine = afterLines[i];
    if (oldLine === newLine && oldLine !== undefined) {
      out.push(` ${oldLine}`);
      continue;
    }
    if (oldLine !== undefined) out.push(`-${oldLine}`);
    if (newLine !== undefined) out.push(`+${newLine}`);
  }

  return `${out.join("\n")}\n`;
}

export async function confirmAndWrite(configPath: string, before: string | null, after: string): Promise<void> {
  process.stdout.write(renderDiff(before, after, configPath));

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write("re-run in an interactive terminal to apply, or use --print-config\n");
    process.exit(1);
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await readline.question("Apply? [y/N] ");
  readline.close();

  if (answer !== "y" && answer !== "Y") {
    process.stdout.write("no changes made\n");
    process.exit(0);
  }

  mkdirSync(path.dirname(configPath), { recursive: true });
  const backupPath = before === null ? null : `${configPath}.bak-${timestamp()}`;
  if (backupPath !== null) writeFileSync(backupPath, readFileSync(configPath));
  writeAtomic(configPath, after);

  if (backupPath !== null) {
    process.stdout.write(`applied — backup at ${backupPath}\n`);
  } else {
    process.stdout.write(`created ${configPath}\n`);
  }
}

export function hasTomlHooksTable(text: string): boolean {
  return /^\s*\[hooks\]\s*$/m.test(text);
}

export function computeTomlAppend(existingText: string | null, block: string): TextComputeResult {
  if (existingText !== null && hasTomlHooksTable(existingText)) {
    return {
      ok: false,
      code: "hooks-table-exists",
      message: "manual merge required because sidelight does not parse TOML",
    };
  }

  const before = existingText ?? "";
  const merged = before.trim() === ""
    ? block
    : `${before.endsWith("\n") ? before : `${before}\n`}\n${block}`;
  return { ok: true, merged, changed: merged !== before };
}

export function computeTomlRemoval(existingText: string | null, block: string): TextComputeResult {
  if (existingText === null) {
    return {
      ok: false,
      code: "block-not-found",
      message: "manual uninstall required because sidelight does not parse TOML",
    };
  }

  const index = existingText.indexOf(block);
  if (index < 0) {
    return {
      ok: false,
      code: "block-not-found",
      message: "manual uninstall required because sidelight does not parse TOML",
    };
  }

  let before = existingText.slice(0, index);
  const after = existingText.slice(index + block.length);
  if (before.endsWith("\n\n")) before = before.slice(0, -1);
  const merged = before + after;
  return { ok: true, merged, changed: true };
}

function parseSettingsJson(existingText: string | null): { ok: true; value: JsonObject } | { ok: false; code: string; message: string } {
  if (existingText === null) return { ok: true, value: {} };

  try {
    const parsed = JSON.parse(existingText) as unknown;
    if (!isRecord(parsed) || Array.isArray(parsed)) {
      return { ok: false, code: "invalid-json", message: "settings JSON must be an object" };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown parse error";
    return { ok: false, code: "invalid-json", message: `invalid JSON: ${detail}` };
  }
}

function ensureObject(parent: JsonObject, key: string): JsonObject {
  const existing = parent[key];
  if (isRecord(existing) && !Array.isArray(existing)) return existing;
  const next: JsonObject = {};
  parent[key] = next;
  return next;
}

function eventHasOwnedHook(groups: unknown[], binFilename: string, desiredCommands: string[]): boolean {
  return groups.some((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
    return group.hooks.some((hook) => isOwnedHook(hook, binFilename, desiredCommands));
  });
}

function isOwnedHook(hook: unknown, binFilename: string, desiredCommands: string[]): boolean {
  if (!isRecord(hook) || typeof hook.command !== "string") return false;
  return isOwnedCommand(hook.command, binFilename, desiredCommands);
}

function isOwnedCommand(command: string, binFilename: string, desiredCommands: string[]): boolean {
  if (desiredCommands.includes(command)) return true;
  if (command === binFilename || command.endsWith(`/${binFilename}`)) return true;
  if (binFilename === "sidelight-claude-code-hook" && command.endsWith("/adapters/claude-code/index.js")) return true;
  if (binFilename === "sidelight-codex-hook" && command.endsWith("/adapters/codex/index.js")) return true;
  return false;
}

function findMatchingGroup(groups: unknown[], desiredGroup: JsonObject): JsonObject | null {
  for (const group of groups) {
    if (!isRecord(group)) continue;
    if ((group.matcher ?? null) === (desiredGroup.matcher ?? null)) return group;
  }
  return null;
}

function commandsFromHooks(hooks: JsonObject): string[] {
  const commands: string[] = [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) {
        if (isRecord(hook) && typeof hook.command === "string") commands.push(hook.command);
      }
    }
  }
  return commands;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneJsonArray(value: unknown[]): unknown[] {
  return cloneJson(value);
}

function serializeJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized === "" ? [] : normalized.split("\n");
}

function timestamp(): string {
  const now = new Date();
  const part = (value: number) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    part(now.getMonth() + 1),
    part(now.getDate()),
    "-",
    part(now.getHours()),
    part(now.getMinutes()),
    part(now.getSeconds()),
  ].join("");
}

function writeAtomic(finalPath: string, contents: string): void {
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, contents, "utf8");
  renameSync(tempPath, finalPath);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}
