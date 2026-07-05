import { open, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { isDenied } from "./denylist.js";
import { pathYankPayload } from "./yank.js";
import { execGit } from "./git.js";
import { highlightRow } from "./highlight.js";
import { jumpIndex } from "./navigation.js";
import { highlightMatches } from "./search-format.js";

const PREVIEW_LIMIT_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

export interface PreviewRequest {
  kind?: "file" | "diff";
  path: string;
  targetLine: number;
  highlightQuery?: string;
  diffKind?: "staged" | "unstaged";
}

export type RequestPreview = (request: PreviewRequest) => void;

export interface PreviewState {
  path: string;
  lines: string[];
  scrollOffset: number;
  cursorLine: number;
  highlightQuery?: string;
  breadcrumbKind?: "staged diff" | "unstaged diff";
}

export type PreviewCursorMove = "up" | "down" | "top" | "bottom";

export function sniffBinary(buf: Uint8Array): boolean {
  const limit = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (buf[index] === 0) {
      return true;
    }
  }
  return false;
}

export function previewWindow(totalLines: number, targetLine: number, height: number): number {
  if (totalLines <= 0 || height <= 0) {
    return 0;
  }

  const normalizedTarget = Math.max(1, Math.min(targetLine, totalLines));
  const maxOffset = Math.max(0, totalLines - height);
  const centered = normalizedTarget - 1 - Math.floor(height / 2);
  return Math.max(0, Math.min(centered, maxOffset));
}

export async function loadPreview(projectDir: string, request: PreviewRequest, height: number): Promise<PreviewState> {
  if (request.kind === "diff") {
    return loadDiff(projectDir, request, height);
  }

  const path = request.path;
  if (isDenied(path)) {
    return {
      path,
      lines: ["deny-listed file — no preview"],
      scrollOffset: 0,
      cursorLine: 0,
      highlightQuery: request.highlightQuery,
    };
  }

  try {
    const absolutePath = join(projectDir, path);
    // Symlink containment: stat/open follow symlinks, so a tracked link
    // pointing outside the project could otherwise display foreign files
    // (e.g. a committed "notes.md -> ~/.ssh/id_rsa"). Resolve both ends and
    // require the real target to live inside the real project directory.
    const [realProject, realTarget] = await Promise.all([realpath(projectDir), realpath(absolutePath)]);
    if (realTarget !== realProject && !realTarget.startsWith(realProject + sep)) {
      return {
        path,
        lines: ["links outside the project — no preview"],
        scrollOffset: 0,
        cursorLine: 0,
        highlightQuery: request.highlightQuery,
      };
    }
    const info = await stat(absolutePath);
    const bytesToRead = Math.min(info.size, PREVIEW_LIMIT_BYTES);
    const file = await open(absolutePath, "r");
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(bytesToRead);
      if (bytesToRead > 0) {
        const result = await file.read(buffer, 0, bytesToRead, 0);
        buffer = buffer.subarray(0, result.bytesRead);
      }
    } finally {
      await file.close();
    }

    // Per DECISIONS.md D4, content is shown only on explicit user keypress.
    // The deny-list guard above is defense in depth for callers.
    if (sniffBinary(buffer)) {
      return {
        path,
        lines: ["binary file — no preview"],
        scrollOffset: 0,
        cursorLine: 0,
        highlightQuery: request.highlightQuery,
      };
    }

    const text = buffer.toString("utf8");
    const lines = splitPreviewLines(text);
    if (info.size > PREVIEW_LIMIT_BYTES) {
      lines.push(`— truncated (file is ${formatMegabytes(info.size)} MB) —`);
    }

    const cursorLine = targetCursorLine(lines.length, request.targetLine);
    return {
      path,
      lines,
      scrollOffset: previewWindow(lines.length, request.targetLine, Math.max(1, height - 1)),
      cursorLine,
      highlightQuery: request.highlightQuery,
    };
  } catch (error) {
    return {
      path,
      lines: [previewErrorMessage(error)],
      scrollOffset: 0,
      cursorLine: 0,
      highlightQuery: request.highlightQuery,
    };
  }
}

export async function loadDiff(projectDir: string, request: PreviewRequest, height: number): Promise<PreviewState> {
  const path = request.path;
  const diffKind = request.diffKind ?? "unstaged";
  if (isDenied(path)) {
    return {
      path,
      lines: ["deny-listed file — no preview"],
      scrollOffset: 0,
      cursorLine: 0,
      breadcrumbKind: `${diffKind} diff`,
    };
  }

  try {
    const args = diffKind === "staged"
      ? ["diff", "--cached", "--", path]
      : ["diff", "--", path];
    const { stdout } = await execGit(projectDir, args);
    const lines = splitPreviewLines(stdout).map(colorizeDiffLine);
    const cursorLine = targetCursorLine(lines.length, request.targetLine);
    return {
      path,
      lines,
      scrollOffset: previewWindow(lines.length, request.targetLine, Math.max(1, height - 1)),
      cursorLine,
      breadcrumbKind: `${diffKind} diff`,
    };
  } catch (error) {
    return {
      path,
      lines: [previewErrorMessage(error)],
      scrollOffset: 0,
      cursorLine: 0,
      breadcrumbKind: `${diffKind} diff`,
    };
  }
}

export function renderPreview(state: PreviewState, width: number, height: number): string[] {
  const bodyHeight = Math.max(1, height);
  const totalLines = state.lines.length;
  const cursorLine = totalLines === 0 ? 0 : Math.max(0, Math.min(state.cursorLine, totalLines - 1));
  const crumb = state.breadcrumbKind === undefined ? "" : ` · ${state.breadcrumbKind}`;
  const lines = [truncateToWidth(`${state.path}${crumb} · line ${cursorLine + 1}/${totalLines}`, width)];
  const contentBudget = Math.max(0, bodyHeight - 1);
  const gutterWidth = Math.max(1, String(Math.max(1, totalLines)).length);

  for (let index = 0; index < contentBudget; index += 1) {
    const lineIndex = state.scrollOffset + index;
    const text = state.lines[lineIndex];
    if (text === undefined) {
      break;
    }
    lines.push(formatPreviewLine(lineIndex + 1, text, gutterWidth, width, state.highlightQuery, lineIndex === cursorLine));
  }

  return lines;
}

export function previewYankPayload(state: PreviewState): string | null {
  if (state.breadcrumbKind !== undefined) {
    return pathYankPayload(state.path);
  }
  return pathYankPayload(state.path, state.cursorLine + 1);
}

export function formatPreviewLine(
  lineNumber: number,
  text: string,
  gutterWidth: number,
  width: number,
  highlightQuery?: string,
  selected = false,
): string {
  const gutter = String(lineNumber).padStart(gutterWidth, " ");
  const content = highlightQuery === undefined ? text : highlightMatches(text, highlightQuery, selected);
  const line = `  ${gutter} │ ${content}`;
  return selected ? highlightRow(line, width) : truncateToWidth(line, width);
}

export function colorizeDiffLine(line: string): string {
  if (line.startsWith("@@")) {
    return `\x1b[2m${line}\x1b[22m`;
  }

  if (line.startsWith("+") && !line.startsWith("++")) {
    return `\x1b[32m${line}\x1b[39m`;
  }

  if (line.startsWith("-") && !line.startsWith("--")) {
    return `\x1b[31m${line}\x1b[39m`;
  }

  return line;
}

function splitPreviewLines(text: string): string[] {
  if (text.length === 0) {
    return [""];
  }
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length === 0 ? [""] : lines;
}

export function targetCursorLine(totalLines: number, targetLine: number): number {
  if (totalLines <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(targetLine - 1, totalLines - 1));
}

export function movePreviewCursor(state: PreviewState, contentHeight: number, move: PreviewCursorMove): void {
  if (move === "down") {
    state.cursorLine = Math.min(state.cursorLine + 1, Math.max(0, state.lines.length - 1));
  } else if (move === "up") {
    state.cursorLine = Math.max(state.cursorLine - 1, 0);
  } else if (move === "top") {
    state.cursorLine = jumpIndex(state.lines.length, "top");
  } else {
    state.cursorLine = jumpIndex(state.lines.length, "bottom");
  }
  keepCursorVisible(state, contentHeight);
}

export function keepCursorVisible(state: PreviewState, contentHeight: number): void {
  const budget = Math.max(1, contentHeight);
  state.cursorLine = Math.max(0, Math.min(state.cursorLine, Math.max(0, state.lines.length - 1)));
  const maxOffset = Math.max(0, state.lines.length - budget);
  if (state.cursorLine < state.scrollOffset) {
    state.scrollOffset = state.cursorLine;
  } else if (state.cursorLine >= state.scrollOffset + budget) {
    state.scrollOffset = state.cursorLine - budget + 1;
  }
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxOffset));
}

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
}

function previewErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.split(/\r?\n/, 1)[0] ?? "preview error";
  }
  return "preview error";
}
