import { matchesKey, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import {
  getDiffStats,
  getGitStatus,
  type DiffStat,
  type GitDiffStats,
  type GitStatus,
  type GitStatusResult,
  type GitTrackedChange,
} from "../git.js";
import { highlightRow } from "../highlight.js";
import { jumpIndex } from "../navigation.js";
import type { RequestPreview } from "../preview.js";
import type { Panel, PanelKey } from "../app.js";
import { pathYankPayload } from "../yank.js";

export class GitPanel implements Panel, Component {
  readonly key: PanelKey = "git";
  readonly title = "Git";
  private result: GitStatusResult | null = null;
  private diffStats: GitDiffStats | null = null;
  private loading = false;
  private selectedIndex = 0;

  constructor(
    private readonly projectDir: string,
    private readonly requestPreview: RequestPreview,
  ) {}

  get status(): GitStatus | null {
    return this.result?.kind === "ok" ? this.result.status : null;
  }

  get headerState(): "loading" | "ok" | "no-repo" | "error" {
    if (this.loading || this.result === null) {
      return "loading";
    }
    return this.result.kind;
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.result = null;
    this.diffStats = null;
    try {
      const [status, diffStats] = await Promise.all([getGitStatus(this.projectDir), getDiffStats(this.projectDir)]);
      this.result = status.kind === "ok" && diffStats.kind === "error" ? diffStats : status;
      this.diffStats = diffStats.kind === "ok" ? diffStats.stats : null;
    } finally {
      this.loading = false;
      this.clampSelection();
    }
  }

  render(width: number): string[] {
    const fileLines = this.fileLines();

    if (this.loading) {
      return [truncateToWidth("loading…", width)];
    }

    if (this.result === null) {
      return [truncateToWidth("loading…", width)];
    }

    if (this.result.kind === "no-repo") {
      return [truncateToWidth("not a git repository", width)];
    }

    if (this.result.kind === "error") {
      return [truncateToWidth(this.result.message, width)];
    }

    if (fileLines.length === 0) {
      // All sections can be empty while dirty=true when the only changes are in
      // deny-listed files; say so without naming them.
      const cleanLine = this.result.status.dirty ? "changes only in deny-listed files" : "working tree clean";
      return [truncateToWidth(this.branchLine(this.result.status), width), truncateToWidth(cleanLine, width)];
    }

    let selectableIndex = 0;
    const rendered = [truncateToWidth(this.branchLine(this.result.status), width)];
    for (const line of fileLines) {
      if (!line.selectable) {
        rendered.push(truncateToWidth(line.text, width));
        continue;
      }
      const selected = selectableIndex === this.selectedIndex;
      selectableIndex += 1;
      rendered.push(selected ? highlightRow(line.text, width) : truncateToWidth(line.text, width));
    }
    return rendered;
  }

  handlePanelKey(data: string): void {
    const count = this.selectableLineCount();
    if (count === 0) {
      this.selectedIndex = 0;
      return;
    }

    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.selectedIndex = Math.min(this.selectedIndex + 1, count - 1);
      return;
    }

    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      return;
    }

    if (matchesKey(data, "g")) {
      this.selectedIndex = jumpIndex(count, "top");
      return;
    }

    if (matchesKey(data, "shift+g")) {
      this.selectedIndex = jumpIndex(count, "bottom");
      return;
    }

    if (matchesKey(data, "enter")) {
      const row = this.selectedRow();
      if (row?.selectable !== true) {
        return;
      }

      if (row.section === "untracked") {
        this.requestPreview({ path: row.change.path, targetLine: 1 });
        return;
      }

      this.requestPreview({
        kind: "diff",
        path: row.change.path,
        targetLine: 1,
        diffKind: row.section === "staged" ? "staged" : "unstaged",
      });
    }
  }

  yankPayload(): string | null {
    const row = this.selectedRow();
    return row?.selectable === true ? gitYankPayload(row.change) : null;
  }

  invalidate(): void {
    return;
  }

  private branchLine(status: GitStatus): string {
    const branch = status.branch.detached
      ? (status.branch.oid?.slice(0, 7) ?? "detached")
      : (status.branch.head ?? "no branch");
    const upstream = status.branch.upstream === null ? "" : ` -> ${status.branch.upstream}`;
    const ab = status.branch.ahead === 0 && status.branch.behind === 0
      ? ""
      : ` (+${status.branch.ahead}/-${status.branch.behind})`;
    return `${branch}${upstream}${ab}`;
  }

  private fileLines(): RenderLine[] {
    if (this.result?.kind !== "ok") {
      return [];
    }

    const { status } = this.result;
    const lines: RenderLine[] = [];
    const stats = this.statMaps();
    appendSection(lines, "Staged", "staged", status.staged, stats.staged);
    appendSection(lines, "Unstaged", "unstaged", status.unstaged, stats.unstaged);
    appendSection(lines, "Untracked", "untracked", status.untracked, new Map());
    appendSection(lines, "Conflicted", "conflicted", status.conflicted, stats.unstaged);
    return lines;
  }

  private selectedRow(): RenderLine | undefined {
    return this.fileLines().filter((line) => line.selectable)[this.selectedIndex];
  }

  private statMaps(): { staged: Map<string, DiffStat>; unstaged: Map<string, DiffStat> } {
    return {
      staged: new Map((this.diffStats?.staged ?? []).map((stat) => [stat.path, stat])),
      unstaged: new Map((this.diffStats?.unstaged ?? []).map((stat) => [stat.path, stat])),
    };
  }

  private selectableLineCount(): number {
    return this.fileLines().filter((line) => line.selectable).length;
  }

  private clampSelection(): void {
    const count = this.selectableLineCount();
    this.selectedIndex = count === 0 ? 0 : Math.min(this.selectedIndex, count - 1);
  }
}

type RenderLine =
  | { text: string; selectable: false }
  | { text: string; selectable: true; section: GitSection; change: GitTrackedChange };

type GitSection = "staged" | "unstaged" | "untracked" | "conflicted";

function appendSection(
  lines: RenderLine[],
  title: string,
  section: GitSection,
  changes: readonly GitTrackedChange[],
  stats: ReadonlyMap<string, DiffStat>,
): void {
  if (changes.length === 0) {
    return;
  }

  lines.push({ text: title, selectable: false });
  for (const change of changes) {
    lines.push({
      text: `${change.status} ${formatPath(change)}${formatStat(stats.get(change.path))}`,
      selectable: true,
      section,
      change,
    });
  }
}

function formatPath(change: GitTrackedChange): string {
  return change.originalPath === undefined ? change.path : `${change.originalPath} -> ${change.path}`;
}

export function gitYankPayload(change: GitTrackedChange): string | null {
  return pathYankPayload(change.path);
}

function formatStat(stat: DiffStat | undefined): string {
  if (stat === undefined) {
    return "";
  }
  if (stat.binary) {
    return " bin";
  }
  return ` +${stat.added} −${stat.deleted}`;
}
