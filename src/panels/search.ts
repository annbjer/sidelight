import { decodeKittyPrintable, matchesKey, parseKey, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import { isGitRepo, listTrackedFiles, searchTracked, type GitSearchResult, type SearchMatch } from "../git.js";
import { highlightRow } from "../highlight.js";
import { jumpIndex } from "../navigation.js";
import type { RequestPreview } from "../preview.js";
import { filterFilenameMatches, highlightMatches, sectionHeader } from "../search-format.js";
import type { Panel, PanelKey } from "../app.js";
import { pathYankPayload } from "../yank.js";

export class SearchPanel implements Panel, Component {
  readonly key: PanelKey = "search";
  readonly title = "Search";
  private query = "";
  private lastRunQuery: string | null = null;
  private inputFocused = false;
  private loading = false;
  private result: GitSearchResult | null = null;
  private selectedIndex = 0;
  private windowOffset = 0;
  private searchGeneration = 0;
  private noRepo = false;
  private fileMatches: string[] = [];
  private fileMatchesCapped = false;

  constructor(
    private readonly projectDir: string,
    private readonly getHeightBudget: () => number,
    private readonly requestRender: () => void,
    private readonly requestPreview: RequestPreview,
  ) {}

  hasInputFocus(): boolean {
    return this.inputFocused;
  }

  focusInput(): void {
    this.inputFocused = true;
  }

  async refresh(): Promise<void> {
    this.noRepo = !(await isGitRepo(this.projectDir));
    if (this.lastRunQuery === null) {
      return;
    }
    await this.runSearch(this.lastRunQuery);
  }

  render(width: number): string[] {
    const lines = [this.inputLine(width)];
    const bodyBudget = Math.max(0, this.getHeightBudget() - 1);
    if (bodyBudget === 0) {
      return lines;
    }

    lines.push(...this.bodyLines(width, bodyBudget));
    return lines;
  }

  handlePanelKey(data: string): void {
    if (this.inputFocused) {
      this.handleInputKey(data);
      return;
    }

    const rows = this.resultRows();
    if (matchesKey(data, "escape")) {
      this.inputFocused = true;
      return;
    }

    if (matchesKey(data, "enter")) {
      const row = rows[this.selectedIndex];
      if (row?.type === "filematch") {
        this.requestPreview({ path: row.path, targetLine: 1 });
        return;
      }
      if (row?.type === "match") {
        this.requestPreview({
          path: row.match.path,
          targetLine: row.match.line,
          highlightQuery: this.lastRunQuery ?? this.query,
        });
        return;
      }

      if (this.query.length === 0) {
        this.inputFocused = true;
        return;
      }
      void this.runSearch(this.query).finally(() => {
        this.requestRender();
      });
      return;
    }

    if (rows.length === 0) {
      this.selectedIndex = 0;
      this.windowOffset = 0;
      return;
    }

    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.moveSelection(1);
      return;
    }

    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.moveSelection(-1);
      return;
    }

    if (matchesKey(data, "g")) {
      this.jumpSelection("top");
      return;
    }

    if (matchesKey(data, "shift+g")) {
      this.jumpSelection("bottom");
      return;
    }
  }

  yankPayload(): string | null {
    return searchRowYankPayload(this.resultRows()[this.selectedIndex]);
  }

  invalidate(): void {
    return;
  }

  private handleInputKey(data: string): void {
    if (matchesKey(data, "escape")) {
      this.inputFocused = false;
      return;
    }

    if (matchesKey(data, "enter")) {
      if (this.query.length === 0) {
        this.lastRunQuery = null;
        this.result = null;
        this.loading = false;
        return;
      }
      this.inputFocused = false;
      void this.runSearch(this.query).finally(() => {
        this.requestRender();
      });
      return;
    }

    if (matchesKey(data, "backspace")) {
      this.query = this.query.slice(0, -1);
      return;
    }

    const printable = printableInput(data);
    if (printable !== null) {
      this.query += printable;
    }
  }

  private async runSearch(query: string): Promise<void> {
    const generation = this.searchGeneration + 1;
    this.searchGeneration = generation;
    this.loading = true;
    this.result = null;
    this.lastRunQuery = query;
    this.selectedIndex = 0;
    this.windowOffset = 0;
    this.requestRender();

    const [result, files] = await Promise.all([
      searchTracked(this.projectDir, query),
      listTrackedFiles(this.projectDir),
    ]);
    if (this.searchGeneration !== generation) {
      return;
    }

    this.result = result;
    const filenameMatches =
      files.kind === "ok" ? filterFilenameMatches(files.paths, query) : { paths: [], capped: false };
    this.fileMatches = filenameMatches.paths;
    this.fileMatchesCapped = filenameMatches.capped;
    this.loading = false;
    this.clampSelection();
  }

  private inputLine(width: number): string {
    const cursor = this.inputFocused ? "█" : "";
    return truncateToWidth(`query: ${this.query}${cursor}`, width);
  }

  private bodyLines(width: number, bodyBudget: number): string[] {
    if (this.loading) {
      return [truncateToWidth("searching...", width)];
    }

    if (this.noRepo) {
      return [truncateToWidth("search requires a git repository in v0.1", width)];
    }

    if (this.lastRunQuery === null) {
      return [truncateToWidth("type a query, Enter to search", width)];
    }

    if (this.result === null) {
      return [truncateToWidth("searching...", width)];
    }

    if (this.result.kind === "no-repo") {
      return [truncateToWidth("search requires a git repository in v0.1", width)];
    }

    if (this.result.kind === "error") {
      return [truncateToWidth(this.result.message, width)];
    }

    if (this.result.matches.length === 0 && this.fileMatches.length === 0) {
      return [truncateToWidth("no matches", width)];
    }

    const query = this.lastRunQuery ?? "";
    const rows = this.resultRows();
    this.clampWindow(rows.length);
    const cappedLineBudget = this.result.capped ? 1 : 0;
    const rowBudget = Math.max(0, bodyBudget - cappedLineBudget);
    const visibleRows = rows.slice(this.windowOffset, this.windowOffset + rowBudget);
    const lines = visibleRows.map((row, index) => {
      if (row.type === "header") {
        return truncateToWidth(sectionHeader(row.label, row.count, row.capped), width);
      }

      const absoluteIndex = this.windowOffset + index;
      const selected = absoluteIndex === this.selectedIndex;
      let text: string;

      if (row.type === "filematch") {
        text = highlightMatches(row.path, query, selected);
      } else if (row.type === "file") {
        text = row.path;
      } else {
        const matchText = highlightMatches(row.match.text.trim(), query, selected);
        text = `${row.match.line}:${row.match.col}  ${matchText}`;
      }

      return selected ? highlightRow(text, width) : truncateToWidth(text, width);
    });

    if (this.result.capped) {
      lines.push(truncateToWidth("showing first 500 matches", width));
    }
    return lines;
  }

  private resultRows(): ResultRow[] {
    if (this.result?.kind !== "ok") {
      return [];
    }

    const rows: ResultRow[] = [];
    if (this.fileMatches.length > 0) {
      rows.push({ type: "header", label: "files", count: this.fileMatches.length, capped: this.fileMatchesCapped });
      for (const path of this.fileMatches) {
        rows.push({ type: "filematch", path });
      }
    }

    if (this.result.matches.length > 0) {
      if (this.fileMatches.length > 0) {
        rows.push({ type: "header", label: "content", count: this.result.matches.length, capped: this.result.capped });
      }
      let currentPath: string | null = null;
      for (const match of this.result.matches) {
        if (match.path !== currentPath) {
          currentPath = match.path;
          rows.push({ type: "file", path: match.path });
        }
        rows.push({ type: "match", match });
      }
    }
    return rows;
  }

  private clampSelection(): void {
    const rows = this.resultRows();
    const selectableIndexes = rows
      .map((row, index) => (isSelectable(row) ? index : -1))
      .filter((index) => index !== -1);
    if (selectableIndexes.length === 0) {
      this.selectedIndex = 0;
      this.windowOffset = 0;
      return;
    }

    if (!selectableIndexes.includes(this.selectedIndex)) {
      this.selectedIndex = selectableIndexes[0] ?? 0;
    }
    this.clampWindow(rows.length);
  }

  private moveSelection(delta: 1 | -1): void {
    const rows = this.resultRows();
    const selectableIndexes = rows
      .map((row, index) => (isSelectable(row) ? index : -1))
      .filter((index) => index !== -1);
    const currentPosition = selectableIndexes.indexOf(this.selectedIndex);
    if (currentPosition === -1) {
      this.selectedIndex = selectableIndexes[0] ?? 0;
      this.clampWindow(rows.length);
      return;
    }

    const nextPosition = Math.max(0, Math.min(currentPosition + delta, selectableIndexes.length - 1));
    this.selectedIndex = selectableIndexes[nextPosition] ?? this.selectedIndex;
    this.clampWindow(rows.length);
  }

  private jumpSelection(edge: "top" | "bottom"): void {
    const rows = this.resultRows();
    const selectableIndexes = rows
      .map((row, index) => (isSelectable(row) ? index : -1))
      .filter((index) => index !== -1);
    this.selectedIndex = selectableIndexes[jumpIndex(selectableIndexes.length, edge)] ?? 0;
    this.clampWindow(rows.length);
  }

  private clampWindow(rowCount: number): void {
    const capBudget = this.result?.kind === "ok" && this.result.capped ? 1 : 0;
    const budget = Math.max(1, this.getHeightBudget() - 1 - capBudget);
    if (this.selectedIndex < this.windowOffset) {
      this.windowOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.windowOffset + budget) {
      this.windowOffset = this.selectedIndex - budget + 1;
    }

    this.windowOffset = Math.max(0, Math.min(this.windowOffset, Math.max(0, rowCount - budget)));
  }
}

type ResultRow =
  | { type: "header"; label: string; count: number; capped: boolean }
  | { type: "filematch"; path: string }
  | { type: "file"; path: string }
  | { type: "match"; match: SearchMatch };

function isSelectable(row: ResultRow): boolean {
  return row.type === "match" || row.type === "filematch";
}

export function searchRowYankPayload(row: ResultRow | undefined): string | null {
  if (row === undefined) {
    return null;
  }
  if (row.type === "filematch") {
    return pathYankPayload(row.path);
  }
  if (row.type === "match") {
    return pathYankPayload(row.match.path, row.match.line);
  }
  return null;
}

function printableInput(data: string): string | null {
  const decoded = decodeKittyPrintable(data);
  if (decoded !== undefined && decoded.length > 0) {
    return decoded;
  }

  const parsed = parseKey(data);
  if (parsed === "space") {
    return " ";
  }

  if (parsed !== undefined && parsed.length === 1) {
    return parsed;
  }

  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 32 && code <= 126) {
      return data;
    }
  }

  return null;
}
