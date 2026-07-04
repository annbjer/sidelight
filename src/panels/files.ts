import { matchesKey, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDenied } from "../denylist.js";
import { pathYankPayload } from "../yank.js";
import { listTrackedFiles, type GitFileListResult } from "../git.js";
import { highlightRow } from "../highlight.js";
import { jumpIndex } from "../navigation.js";
import type { RequestPreview } from "../preview.js";
import {
  buildTree,
  compareTreeNodes,
  findVisibleParentDirIndex,
  flattenTree,
  type TreeNode,
  type VisibleRow,
} from "../tree.js";
import type { Panel, PanelKey } from "../app.js";

export class FilesPanel implements Panel, Component {
  readonly key: PanelKey = "files";
  readonly title = "Files";
  private loading = false;
  private result: FilesResult | null = null;
  private root: TreeNode = createRoot();
  private selectedIndex = 0;
  private windowOffset = 0;
  private readonly expandedDirs = new Set<string>();
  private readonly collapsedTopLevelDirs = new Set<string>();
  private readonly loadedDirs = new Set<string>();
  private readonly loadingDirs = new Set<string>();

  constructor(
    private readonly projectDir: string,
    private readonly getHeightBudget: () => number,
    private readonly requestRender: () => void,
    private readonly requestPreview: RequestPreview,
  ) {}

  async refresh(): Promise<void> {
    this.loading = true;
    this.result = null;
    try {
      const result = await listTrackedFiles(this.projectDir);
      if (result.kind === "ok") {
        this.root = buildTree(result.paths);
        this.result = { kind: "git", files: result };
        this.loadedDirs.clear();
        this.loadingDirs.clear();
      } else if (result.kind === "no-repo") {
        this.result = { kind: "no-repo" };
        this.root = createRoot();
        this.loadedDirs.clear();
        this.loadingDirs.clear();
        await this.loadDirectory("");
      } else {
        this.result = { kind: "error", message: result.message };
        this.root = createRoot();
      }
    } finally {
      this.loading = false;
      this.clampSelection();
    }
  }

  render(width: number): string[] {
    if (this.loading || this.result === null) {
      return [truncateToWidth("loading...", width)];
    }

    if (this.result.kind === "error") {
      return [truncateToWidth(this.result.message, width)];
    }

    const rows = this.visibleRows();
    if (rows.length === 0) {
      return [truncateToWidth("(no files)", width)];
    }

    this.clampWindow(rows.length);
    const budget = Math.max(1, this.getHeightBudget());
    return rows.slice(this.windowOffset, this.windowOffset + budget).map((row, index) => {
      const absoluteIndex = this.windowOffset + index;
      const marker = row.type === "dir" ? (row.expanded ? "▾ " : "▸ ") : "  ";
      const indent = "  ".repeat(row.depth);
      const text = `${indent}${marker}${row.name}`;
      return absoluteIndex === this.selectedIndex ? highlightRow(text, width) : truncateToWidth(text, width);
    });
  }

  handlePanelKey(data: string): void {
    const rows = this.visibleRows();
    if (rows.length === 0) {
      this.selectedIndex = 0;
      this.windowOffset = 0;
      return;
    }

    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.selectedIndex = Math.min(this.selectedIndex + 1, rows.length - 1);
      this.clampWindow(rows.length);
      return;
    }

    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.clampWindow(rows.length);
      return;
    }

    if (matchesKey(data, "g")) {
      this.selectedIndex = jumpIndex(rows.length, "top");
      this.clampWindow(rows.length);
      return;
    }

    if (matchesKey(data, "shift+g")) {
      this.selectedIndex = jumpIndex(rows.length, "bottom");
      this.clampWindow(rows.length);
      return;
    }

    if (matchesKey(data, "enter")) {
      const row = rows[this.selectedIndex];
      if (row?.type === "dir") {
        this.toggleDirectory(row);
      } else if (row?.type === "file") {
        this.requestPreview({ path: row.path, targetLine: 1 });
      }
      return;
    }

    if (matchesKey(data, "right")) {
      const row = rows[this.selectedIndex];
      if (row?.type === "dir" && !row.expanded) {
        this.toggleDirectory(row);
      }
      return;
    }

    if (matchesKey(data, "left")) {
      const row = rows[this.selectedIndex];
      if (row?.type === "dir" && row.expanded) {
        this.toggleDirectory(row);
        return;
      }

      const parentIndex = findVisibleParentDirIndex(rows, this.selectedIndex);
      if (parentIndex !== -1) {
        this.selectedIndex = parentIndex;
        this.clampWindow(rows.length);
      }
    }
  }

  yankPayload(): string | null {
    const path = selectedVisibleRowPath(this.visibleRows(), this.selectedIndex);
    return path === null ? null : pathYankPayload(path);
  }

  invalidate(): void {
    return;
  }

  private toggleDirectory(row: VisibleRow): void {
    if (row.depth === 0) {
      if (this.collapsedTopLevelDirs.has(row.path)) {
        this.collapsedTopLevelDirs.delete(row.path);
      } else {
        this.collapsedTopLevelDirs.add(row.path);
      }
    } else if (this.expandedDirs.has(row.path)) {
      this.expandedDirs.delete(row.path);
    } else {
      this.expandedDirs.add(row.path);
    }

    if (this.result?.kind === "no-repo" && this.isExpanded(row) && !this.loadedDirs.has(row.path)) {
      this.loadingDirs.add(row.path);
      void this.loadDirectory(row.path).finally(() => {
        this.loadingDirs.delete(row.path);
        this.clampSelection();
        this.requestRender();
      });
    }

    this.clampSelection();
  }

  private visibleRows(): VisibleRow[] {
    return flattenTree(this.root, (path, depth) => this.isExpanded({ path, depth }));
  }

  private isExpanded(row: Pick<VisibleRow, "path" | "depth">): boolean {
    if (row.depth === 0) {
      return !this.collapsedTopLevelDirs.has(row.path);
    }
    return this.expandedDirs.has(row.path);
  }

  private async loadDirectory(relPath: string): Promise<void> {
    try {
      const entries = await readdir(join(this.projectDir, relPath), { withFileTypes: true });
      const node = this.findDirectory(relPath);
      if (node === undefined) {
        return;
      }

      node.children = entries
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .map((entry): TreeNode => {
          const path = relPath.length === 0 ? entry.name : `${relPath}/${entry.name}`;
          return {
            name: entry.name,
            path,
            type: entry.isDirectory() ? "dir" : "file",
            children: [],
          };
        })
        .filter((entry) => !isDenied(entry.path))
        .sort(compareTreeNodes);
      this.loadedDirs.add(relPath);
    } catch (error) {
      this.result = { kind: "error", message: errorMessage(error) };
    }
  }

  private findDirectory(path: string): TreeNode | undefined {
    if (path.length === 0) {
      return this.root;
    }

    let node = this.root;
    for (const part of path.split("/")) {
      const next = node.children.find((child) => child.type === "dir" && child.name === part);
      if (next === undefined) {
        return undefined;
      }
      node = next;
    }
    return node;
  }

  private clampSelection(): void {
    const count = this.visibleRows().length;
    this.selectedIndex = count === 0 ? 0 : Math.min(this.selectedIndex, count - 1);
    this.clampWindow(count);
  }

  private clampWindow(rowCount: number): void {
    const budget = Math.max(1, this.getHeightBudget());
    if (this.selectedIndex < this.windowOffset) {
      this.windowOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.windowOffset + budget) {
      this.windowOffset = this.selectedIndex - budget + 1;
    }

    this.windowOffset = Math.max(0, Math.min(this.windowOffset, Math.max(0, rowCount - budget)));
  }
}

type FilesResult =
  | { kind: "git"; files: Extract<GitFileListResult, { kind: "ok" }> }
  | { kind: "no-repo" }
  | { kind: "error"; message: string };

function createRoot(): TreeNode {
  return { name: "", path: "", type: "dir", children: [] };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.split(/\r?\n/, 1)[0] ?? "file error";
  }
  return "file error";
}

export function selectedVisibleRowPath(rows: readonly VisibleRow[], selectedIndex: number): string | null {
  return rows[selectedIndex]?.path ?? null;
}
