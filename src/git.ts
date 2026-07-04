import { execFile } from "node:child_process";
import { isDenied } from "./denylist.js";

const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface GitBranchStatus {
  head: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
}

export interface GitTrackedChange {
  path: string;
  originalPath?: string;
  status: string;
}

export interface GitStatus {
  branch: GitBranchStatus;
  staged: GitTrackedChange[];
  unstaged: GitTrackedChange[];
  untracked: GitTrackedChange[];
  conflicted: GitTrackedChange[];
  dirty: boolean;
}

export interface DiffStat {
  path: string;
  originalPath?: string;
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

export interface GitDiffStats {
  staged: DiffStat[];
  unstaged: DiffStat[];
}

export interface SearchMatch {
  path: string;
  line: number;
  col: number;
  text: string;
}

export interface SearchGrepParseResult {
  matches: SearchMatch[];
  capped: boolean;
}

export type GitStatusResult =
  | { kind: "ok"; status: GitStatus }
  | { kind: "no-repo" }
  | { kind: "error"; message: string };

export type GitFileListResult =
  | { kind: "ok"; paths: string[] }
  | { kind: "no-repo" }
  | { kind: "error"; message: string };

export type GitDiffStatsResult =
  | { kind: "ok"; stats: GitDiffStats }
  | { kind: "no-repo" }
  | { kind: "error"; message: string };

export type GitSearchResult =
  | { kind: "ok"; matches: SearchMatch[]; capped: boolean }
  | { kind: "no-repo" }
  | { kind: "error"; message: string };

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execGit(dir, ["rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function getGitStatus(dir: string): Promise<GitStatusResult> {
  if (!(await isGitRepo(dir))) {
    return { kind: "no-repo" };
  }

  try {
    const { stdout } = await execGit(dir, ["status", "--porcelain=v2", "--branch"]);
    const status = parsePorcelainV2(stdout);
    // Branch metadata and dirty reflect unfiltered git status, so the header stays truthful.
    return { kind: "ok", status: filterDeniedStatus(status) };
  } catch (error) {
    return { kind: "error", message: gitErrorMessage(error) };
  }
}

export async function getDiffStats(dir: string): Promise<GitDiffStatsResult> {
  if (!(await isGitRepo(dir))) {
    return { kind: "no-repo" };
  }

  try {
    const [unstaged, staged] = await Promise.all([
      execGit(dir, ["diff", "--numstat", "-z"]),
      execGit(dir, ["diff", "--cached", "--numstat", "-z"]),
    ]);
    return {
      kind: "ok",
      stats: {
        staged: filterDeniedDiffStats(parseNumstat(staged.stdout)),
        unstaged: filterDeniedDiffStats(parseNumstat(unstaged.stdout)),
      },
    };
  } catch (error) {
    return { kind: "error", message: gitErrorMessage(error) };
  }
}

export async function listTrackedFiles(dir: string): Promise<GitFileListResult> {
  if (!(await isGitRepo(dir))) {
    return { kind: "no-repo" };
  }

  try {
    const { stdout } = await execGit(dir, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    return {
      kind: "ok",
      paths: stdout.split("\0").filter((path) => path.length > 0 && !isDenied(path)),
    };
  } catch (error) {
    return { kind: "error", message: gitErrorMessage(error) };
  }
}

// Smart-case: an all-lowercase query searches case-insensitively; any
// uppercase character makes the search exact (ripgrep/editor convention).
export function grepArgs(query: string): string[] {
  const args = ["grep", "-n", "-I", "--column", "-F"];
  if (query === query.toLowerCase()) {
    args.push("-i");
  }
  args.push("-e", query);
  return args;
}

export async function searchTracked(dir: string, query: string): Promise<GitSearchResult> {
  if (!(await isGitRepo(dir))) {
    return { kind: "no-repo" };
  }

  try {
    const { stdout } = await execGit(dir, grepArgs(query));
    const parsed = parseGrepOutput(stdout);
    return { kind: "ok", matches: filterDeniedMatches(parsed.matches), capped: parsed.capped };
  } catch (error) {
    if (isGitExitCode(error, 1) && gitStdout(error).length === 0) {
      return { kind: "ok", matches: [], capped: false };
    }
    return { kind: "error", message: gitErrorMessage(error) };
  }
}

export function parsePorcelainV2(text: string): GitStatus {
  const status: GitStatus = {
    branch: {
      head: null,
      oid: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      detached: false,
    },
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    dirty: false,
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length === 0) {
      continue;
    }

    if (rawLine.startsWith("# ")) {
      parseHeader(rawLine, status);
      continue;
    }

    if (rawLine.startsWith("1 ")) {
      parseOrdinaryChange(rawLine, status);
      continue;
    }

    if (rawLine.startsWith("2 ")) {
      parseRenameOrCopy(rawLine, status);
      continue;
    }

    if (rawLine.startsWith("u ")) {
      parseUnmerged(rawLine, status);
      continue;
    }

    if (rawLine.startsWith("? ")) {
      status.untracked.push({ path: rawLine.slice(2), status: "?" });
      status.dirty = true;
      continue;
    }
  }

  return status;
}

export function parseGrepOutput(text: string): SearchGrepParseResult {
  const matches: SearchMatch[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length === 0) {
      continue;
    }

    const firstColon = rawLine.indexOf(":");
    const secondColon = firstColon === -1 ? -1 : rawLine.indexOf(":", firstColon + 1);
    const thirdColon = secondColon === -1 ? -1 : rawLine.indexOf(":", secondColon + 1);
    if (firstColon === -1 || secondColon === -1 || thirdColon === -1) {
      continue;
    }

    const line = Number(rawLine.slice(firstColon + 1, secondColon));
    const col = Number(rawLine.slice(secondColon + 1, thirdColon));
    if (!Number.isInteger(line) || !Number.isInteger(col)) {
      continue;
    }

    if (matches.length >= 500) {
      return { matches, capped: true };
    }

    matches.push({
      path: rawLine.slice(0, firstColon),
      line,
      col,
      text: rawLine.slice(thirdColon + 1),
    });
  }

  return { matches, capped: false };
}

export function filterDeniedStatus(status: GitStatus): GitStatus {
  return {
    branch: status.branch,
    staged: status.staged.filter((change) => !isDeniedChange(change)),
    unstaged: status.unstaged.filter((change) => !isDeniedChange(change)),
    untracked: status.untracked.filter((change) => !isDeniedChange(change)),
    conflicted: status.conflicted.filter((change) => !isDeniedChange(change)),
    dirty: status.dirty,
  };
}

export function filterDeniedMatches(matches: readonly SearchMatch[]): SearchMatch[] {
  return matches.filter((match) => !isDenied(match.path));
}

export function parseNumstat(text: string): DiffStat[] {
  const stats: DiffStat[] = [];
  const parts = text.split("\0");

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (record === undefined || record.length === 0) {
      continue;
    }

    const fields = record.split("\t");
    if (fields.length < 3) {
      continue;
    }

    const path = fields.slice(2).join("\t");
    const parsed = parseNumstatCounts(fields[0] ?? "", fields[1] ?? "");
    if (parsed === null) {
      continue;
    }

    if (path.length > 0) {
      stats.push({ path, ...parsed });
      continue;
    }

    const originalPath = parts[index + 1];
    const renamedPath = parts[index + 2];
    if (originalPath === undefined || renamedPath === undefined || renamedPath.length === 0) {
      continue;
    }

    stats.push({ path: renamedPath, originalPath, ...parsed });
    index += 2;
  }

  return stats;
}

export function execGit(dir: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd: dir,
        encoding: "utf8",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function parseHeader(line: string, status: GitStatus): void {
  const body = line.slice(2);

  if (body.startsWith("branch.oid ")) {
    const oid = body.slice("branch.oid ".length);
    status.branch.oid = oid === "(initial)" ? null : oid;
    return;
  }

  if (body.startsWith("branch.head ")) {
    const head = body.slice("branch.head ".length);
    status.branch.detached = head === "(detached)";
    status.branch.head = status.branch.detached ? null : head;
    return;
  }

  if (body.startsWith("branch.upstream ")) {
    status.branch.upstream = body.slice("branch.upstream ".length);
    return;
  }

  if (body.startsWith("branch.ab ")) {
    const match = /^\+(\d+) -(\d+)$/.exec(body.slice("branch.ab ".length));
    if (match !== null) {
      status.branch.ahead = Number(match[1]);
      status.branch.behind = Number(match[2]);
    }
  }
}

function parseOrdinaryChange(line: string, status: GitStatus): void {
  const fields = line.split(" ");
  const xy = fields[1];
  const path = fields.slice(8).join(" ");
  if (xy === undefined || path.length === 0) {
    return;
  }
  addTrackedChanges(status, xy, path);
}

function parseRenameOrCopy(line: string, status: GitStatus): void {
  const fields = line.split(" ");
  const xy = fields[1];
  const pathAndOriginal = fields.slice(9).join(" ");
  const tabIndex = pathAndOriginal.indexOf("\t");
  if (xy === undefined || tabIndex === -1) {
    return;
  }

  addTrackedChanges(status, xy, pathAndOriginal.slice(0, tabIndex), pathAndOriginal.slice(tabIndex + 1));
}

function parseUnmerged(line: string, status: GitStatus): void {
  const fields = line.split(" ");
  const xy = fields[1];
  const path = fields.slice(10).join(" ");
  if (xy === undefined || path.length === 0) {
    return;
  }
  status.conflicted.push({ path, status: xy });
  status.dirty = true;
}

function addTrackedChanges(status: GitStatus, xy: string, path: string, originalPath?: string): void {
  const staged = xy[0];
  const unstaged = xy[1];
  const change = (letter: string): GitTrackedChange =>
    originalPath === undefined ? { path, status: letter } : { path, originalPath, status: letter };

  if (staged !== undefined && staged !== ".") {
    status.staged.push(change(staged));
    status.dirty = true;
  }

  if (unstaged !== undefined && unstaged !== ".") {
    status.unstaged.push(change(unstaged));
    status.dirty = true;
  }
}

function isDeniedChange(change: GitTrackedChange): boolean {
  return isDenied(change.path) || (change.originalPath !== undefined && isDenied(change.originalPath));
}

function filterDeniedDiffStats(stats: readonly DiffStat[]): DiffStat[] {
  return stats.filter((stat) => !isDenied(stat.path) && (stat.originalPath === undefined || !isDenied(stat.originalPath)));
}

function parseNumstatCounts(addedText: string, deletedText: string): Omit<DiffStat, "path" | "originalPath"> | null {
  if (addedText === "-" && deletedText === "-") {
    return { added: null, deleted: null, binary: true };
  }

  const added = Number(addedText);
  const deleted = Number(deletedText);
  if (!Number.isInteger(added) || !Number.isInteger(deleted)) {
    return null;
  }

  return { added, deleted, binary: false };
}

function gitErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.split(/\r?\n/, 1)[0] ?? "git error";
  }
  return "git error";
}

function isGitExitCode(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function gitStdout(error: unknown): string {
  if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string") {
    return error.stdout;
  }
  return "";
}
