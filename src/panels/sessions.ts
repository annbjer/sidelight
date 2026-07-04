import { matchesKey, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import { highlightRow } from "../highlight.js";
import { jumpIndex } from "../navigation.js";
import type { Panel, PanelKey } from "../app.js";
import {
  formatCost,
  loadSnapshots,
  sessionRowLabel,
  stateDirForProjectDir,
  type SessionRow,
  type SessionSnapshotView,
} from "../sessions.js";

export class SessionsPanel implements Panel, Component {
  readonly key: PanelKey = "sessions";
  readonly title = "Sessions";
  readonly stateDir: string;
  private loading = false;
  private rows: SessionRow[] = [];
  private selectedIndex = 0;
  private windowOffset = 0;
  private detailOpen = false;
  private detailScrollOffset = 0;
  private detailCursorLine = 0;

  constructor(
    projectDir: string,
    private readonly getHeightBudget: () => number,
  ) {
    this.stateDir = stateDirForProjectDir(projectDir);
  }

  isDetailOpen(): boolean {
    return this.detailOpen;
  }

  async refresh(): Promise<void> {
    this.loading = true;
    try {
      this.rows = await loadSnapshots(this.stateDir);
    } finally {
      this.loading = false;
      this.clampSelection();
      this.clampDetail();
    }
  }

  render(width: number): string[] {
    if (this.detailOpen) {
      return this.renderDetail(width);
    }

    if (this.loading) {
      return [truncateToWidth("loading...", width)];
    }

    if (this.rows.length === 0) {
      return [truncateToWidth("no PI session metadata — see README to enable the extension", width)];
    }

    this.clampWindow(this.rows.length);
    const budget = Math.max(1, this.getHeightBudget());
    const nowMs = Date.now();
    return this.rows.slice(this.windowOffset, this.windowOffset + budget).map((row, index) => {
      const absoluteIndex = this.windowOffset + index;
      const text = rowLine(row, nowMs);
      return absoluteIndex === this.selectedIndex ? highlightRow(text, width) : truncateToWidth(text, width);
    });
  }

  handlePanelKey(data: string): void {
    if (this.detailOpen) {
      this.handleDetailKey(data);
      return;
    }

    if (this.rows.length === 0) {
      this.selectedIndex = 0;
      this.windowOffset = 0;
      return;
    }

    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.rows.length - 1);
      this.clampWindow(this.rows.length);
      return;
    }

    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.clampWindow(this.rows.length);
      return;
    }

    if (matchesKey(data, "g")) {
      this.selectedIndex = jumpIndex(this.rows.length, "top");
      this.clampWindow(this.rows.length);
      return;
    }

    if (matchesKey(data, "shift+g")) {
      this.selectedIndex = jumpIndex(this.rows.length, "bottom");
      this.clampWindow(this.rows.length);
      return;
    }

    if (matchesKey(data, "enter")) {
      this.detailOpen = true;
      this.detailScrollOffset = 0;
      this.detailCursorLine = 0;
    }
  }

  yankPayload(): string | null {
    return sessionYankPayload(this.rows[this.selectedIndex]);
  }

  invalidate(): void {
    return;
  }

  private renderDetail(width: number): string[] {
    const row = this.rows[this.selectedIndex];
    if (row === undefined) {
      this.detailOpen = false;
      return this.render(width);
    }

    const lines = detailLines(row);
    const budget = Math.max(1, this.getHeightBudget());
    this.clampDetail();
    return lines
      .slice(this.detailScrollOffset, this.detailScrollOffset + budget)
      .map((line, index) => {
        const lineIndex = this.detailScrollOffset + index;
        return lineIndex === this.detailCursorLine ? highlightRow(line, width) : truncateToWidth(line, width);
      });
  }

  private handleDetailKey(data: string): void {
    if (matchesKey(data, "escape")) {
      this.detailOpen = false;
      this.detailScrollOffset = 0;
      this.detailCursorLine = 0;
      return;
    }

    const row = this.rows[this.selectedIndex];
    const lineCount = row === undefined ? 0 : detailLines(row).length;
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.detailCursorLine = Math.min(this.detailCursorLine + 1, Math.max(0, lineCount - 1));
      this.clampDetail();
      return;
    }

    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.detailCursorLine = Math.max(this.detailCursorLine - 1, 0);
      this.clampDetail();
      return;
    }

    if (matchesKey(data, "g")) {
      this.detailCursorLine = jumpIndex(lineCount, "top");
      this.clampDetail();
      return;
    }

    if (matchesKey(data, "shift+g")) {
      this.detailCursorLine = jumpIndex(lineCount, "bottom");
      this.clampDetail();
      return;
    }
  }

  private clampSelection(): void {
    this.selectedIndex = this.rows.length === 0 ? 0 : Math.min(this.selectedIndex, this.rows.length - 1);
    this.clampWindow(this.rows.length);
    if (this.rows.length === 0) {
      this.detailOpen = false;
    }
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

  private clampDetail(): void {
    const row = this.rows[this.selectedIndex];
    const lineCount = row === undefined ? 0 : detailLines(row).length;
    this.detailCursorLine = lineCount === 0 ? 0 : Math.min(this.detailCursorLine, lineCount - 1);
    const budget = Math.max(1, this.getHeightBudget());
    if (this.detailCursorLine < this.detailScrollOffset) {
      this.detailScrollOffset = this.detailCursorLine;
    } else if (this.detailCursorLine >= this.detailScrollOffset + budget) {
      this.detailScrollOffset = this.detailCursorLine - budget + 1;
    }
    this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset, this.maxDetailOffset()));
  }

  private maxDetailOffset(): number {
    const row = this.rows[this.selectedIndex];
    if (row === undefined) return 0;
    return Math.max(0, detailLines(row).length - Math.max(1, this.getHeightBudget()));
  }
}

function rowLine(row: SessionRow, nowMs: number): string {
  if (row.kind === "unknown-version") {
    const version = typeof row.version === "number" || typeof row.version === "string" ? ` v${row.version}` : "";
    return `○ ${row.sessionId.slice(0, 8)} · update sidelight for snapshot${version}`;
  }
  return sessionRowLabel(row.snapshot, nowMs).text;
}

export function sessionYankPayload(row: SessionRow | undefined): string | null {
  if (row === undefined) {
    return null;
  }
  const sessionId = row.kind === "snapshot" ? row.snapshot.sessionId : row.sessionId;
  return `pi --session ${sessionId}`;
}

export function detailLines(row: SessionRow): string[] {
  if (row.kind === "unknown-version") {
    return [
      row.sessionId,
      `schema: unknown${formatUnknownVersion(row.version)}`,
      "update sidelight to read this snapshot",
      `path: ${row.path}`,
    ];
  }

  const snapshot = row.snapshot;
  const lines = [
    snapshot.sessionId,
    `v: ${snapshot.v}`,
    `cwd: ${snapshot.cwd}`,
    `name: ${snapshot.name ?? "null"}`,
    `model: ${snapshot.model ?? "null"}`,
    `startedAt: ${formatTimestamp(snapshot.startedAt)}`,
    `lastActivityAt: ${formatTimestamp(snapshot.lastActivityAt)}`,
    `endedAt: ${snapshot.endedAt === null ? "null" : formatTimestamp(snapshot.endedAt)}`,
    `startReason: ${snapshot.startReason}`,
    `counts.prompts: ${snapshot.counts.prompts}`,
    `counts.turns: ${snapshot.counts.turns}`,
    "counts.toolCalls:",
    ...toolCallLines(snapshot),
    `tokens.input: ${snapshot.tokens.input}`,
    `tokens.output: ${snapshot.tokens.output}`,
    `cost: ${formatCost(snapshot.cost)}`,
    "filesTouched:",
    ...fileLines(snapshot),
  ];
  if (snapshot.endedAt !== null) {
    lines.push(`resume: pi --session ${snapshot.sessionId}`);
  }
  return lines;
}

function toolCallLines(snapshot: SessionSnapshotView): string[] {
  const entries = Object.entries(snapshot.counts.toolCalls).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? ["  (none)"] : entries.map(([tool, count]) => `  ${tool}: ${count}`);
}

function fileLines(snapshot: SessionSnapshotView): string[] {
  return snapshot.filesTouched.length === 0 ? ["  (none)"] : snapshot.filesTouched.map((path) => `  ${path}`);
}

function formatTimestamp(ms: number): string {
  return `${ms} (${new Date(ms).toISOString()})`;
}

function formatUnknownVersion(version: unknown): string {
  return typeof version === "number" || typeof version === "string" ? ` v${version}` : "";
}
