#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startApp } from "./app.js";

export type ParsedArgs =
  | { kind: "run"; dir: string }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export const HELP_TEXT = `Usage: sidelight [dir]

Read-only project-awareness TUI for the current directory.

Options:
  --help     Show this help
  --version  Show version
`;

export function parseArgs(args: readonly string[], cwd = process.cwd()): ParsedArgs {
  let dir: string | undefined;

  for (const arg of args) {
    if (arg === "--help") {
      return { kind: "help" };
    }
    if (arg === "--version") {
      return { kind: "version" };
    }
    if (arg.startsWith("-")) {
      return { kind: "error", message: `unknown option: ${arg}` };
    }
    if (dir !== undefined) {
      return { kind: "error", message: "expected at most one directory argument" };
    }
    dir = arg;
  }

  return { kind: "run", dir: resolve(cwd, dir ?? ".") };
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packagePath = resolve(here, "../../package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.kind === "help") {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (parsed.kind === "version") {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }

  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(parsed.dir)) {
    process.stderr.write(`directory does not exist: ${parsed.dir}\n`);
    process.exitCode = 1;
    return;
  }

  if (!statSync(parsed.dir).isDirectory()) {
    process.stderr.write(`not a directory: ${parsed.dir}\n`);
    process.exitCode = 1;
    return;
  }

  if (!process.stdout.isTTY) {
    process.stderr.write("sidelight requires an interactive terminal\n");
    process.exitCode = 1;
    return;
  }

  startApp({ projectDir: parsed.dir });
}

// argv[1] may be a symlink (npm link/installed bin); import.meta.url is the realpath.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
