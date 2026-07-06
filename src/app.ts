import {
  Container,
  ProcessTerminal,
  TUI,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { FilesPanel } from "./panels/files.js";
import { GitPanel } from "./panels/git.js";
import { SearchPanel } from "./panels/search.js";
import { SessionsPanel } from "./panels/sessions.js";
import {
  loadPreview,
  movePreviewCursor,
  previewYankPayload,
  renderPreview,
  type PreviewRequest,
  type PreviewState,
} from "./preview.js";
import { yankToClipboard } from "./yank.js";

export type PanelKey = "files" | "git" | "search" | "sessions";

export interface Panel extends Component {
  readonly key: PanelKey;
  readonly title: string;
  handlePanelKey(data: string): void;
  hasInputFocus?(): boolean;
  refresh?(): Promise<void>;
  yankPayload?(): string | null;
}

export interface AppOptions {
  projectDir: string;
  terminal?: Terminal;
}

const TAB_KEYS: readonly PanelKey[] = ["files", "git", "search", "sessions"];
const GIT_REFRESH_DEBOUNCE_MS = 300;
const SESSIONS_REFRESH_DEBOUNCE_MS = 300;
const YANK_FLASH_MS = 1500;

class AppShell extends Container {
  private activeTab: PanelKey = "files";
  private readonly panels: Record<PanelKey, Panel>;
  private readonly gitPanel: GitPanel;
  private readonly searchPanel: SearchPanel;
  private readonly sessionsPanel: SessionsPanel;
  private preview: PreviewState | null = null;
  private previewGeneration = 0;
  private flashMessage: string | null = null;
  private flashTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly projectDir: string,
    private readonly terminal: Terminal,
    private readonly getBodyHeight: () => number,
    private readonly requestRender: () => void,
  ) {
    super();
    const requestPreview = (request: PreviewRequest): void => {
      this.openPreview(request, requestRender);
    };
    this.gitPanel = new GitPanel(projectDir, requestPreview);
    this.searchPanel = new SearchPanel(projectDir, getBodyHeight, requestRender, requestPreview);
    this.sessionsPanel = new SessionsPanel(projectDir, getBodyHeight);
    this.panels = {
      files: new FilesPanel(projectDir, getBodyHeight, requestRender, requestPreview),
      git: this.gitPanel,
      search: this.searchPanel,
      sessions: this.sessionsPanel,
    };
  }

  override render(width: number): string[] {
    const panel = this.panels[this.activeTab];
    const body = this.preview === null
      ? panel.render(width)
      : renderPreview(this.preview, width, this.getBodyHeight());
    return [
      this.header(width),
      this.tabBar(width),
      "",
      ...body,
      "",
      this.footer(width),
    ];
  }

  override invalidate(): void {
    for (const panel of Object.values(this.panels)) {
      panel.invalidate();
    }
  }

  handleInput(data: string): void {
    if (this.preview !== null) {
      this.handlePreviewKey(data);
      return;
    }

    if (this.hasInputFocus()) {
      this.panels[this.activeTab].handlePanelKey(data);
      return;
    }

    if (matchesKey(data, "/")) {
      this.activeTab = "search";
      this.searchPanel.focusInput();
      return;
    }

    if (matchesKey(data, "y")) {
      this.yankActivePayload();
      return;
    }

    if (matchesKey(data, "1")) {
      this.closePreview();
      this.activeTab = "files";
      return;
    }
    if (matchesKey(data, "2")) {
      this.closePreview();
      this.activeTab = "git";
      return;
    }
    if (matchesKey(data, "3")) {
      this.closePreview();
      this.activeTab = "search";
      return;
    }
    if (matchesKey(data, "4")) {
      this.closePreview();
      this.activeTab = "sessions";
      return;
    }

    if (
      matchesKey(data, "j") ||
      matchesKey(data, "k") ||
      matchesKey(data, "g") ||
      matchesKey(data, "shift+g") ||
      matchesKey(data, "up") ||
      matchesKey(data, "down") ||
      matchesKey(data, "left") ||
      matchesKey(data, "right") ||
      matchesKey(data, "escape") ||
      matchesKey(data, "enter") ||
      matchesKey(data, "y")
    ) {
      this.panels[this.activeTab].handlePanelKey(data);
    }
  }

  hasInputFocus(): boolean {
    if (this.preview !== null) {
      return false;
    }
    return this.panels[this.activeTab].hasInputFocus?.() ?? false;
  }

  closePreview(): void {
    this.previewGeneration += 1;
    this.preview = null;
  }

  refreshGit(): Promise<void> {
    return this.gitPanel.refresh();
  }

  refreshSessions(): Promise<void> {
    return this.sessionsPanel.refresh();
  }

  sessionsStateDir(): string {
    return this.sessionsPanel.stateDir;
  }

  async refreshAll(): Promise<void> {
    await Promise.all(Object.values(this.panels).map((panel) => panel.refresh?.() ?? Promise.resolve()));
  }

  dispose(): void {
    if (this.flashTimer !== null) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
  }

  private header(width: number): string {
    const projectName = basename(this.projectDir) || this.projectDir;
    const headerState = this.gitPanel.headerState;
    if (headerState === "loading") {
      return truncateToWidth(`${projectName} · loading…`, width);
    }
    if (headerState === "no-repo") {
      return truncateToWidth(`${projectName} · no git`, width);
    }
    if (headerState === "error") {
      return truncateToWidth(`${projectName} · git error`, width);
    }

    const status = this.gitPanel.status;
    if (status === null) {
      return truncateToWidth(`${projectName} · loading…`, width);
    }

    const branch = status.branch.detached
      ? (status.branch.oid?.slice(0, 7) ?? "detached")
      : (status.branch.head ?? "no branch");
    return truncateToWidth(`${projectName} · ${branch}${status.dirty ? " *" : ""}`, width);
  }

  private tabBar(width: number): string {
    const labels: Record<PanelKey, string> = {
      files: "[1] Files",
      git: "[2] Git",
      search: "[3] Search",
      sessions: "[4] Sessions",
    };
    const line = TAB_KEYS.map((key) =>
      key === this.activeTab ? `\x1b[7m${labels[key]}\x1b[27m` : labels[key],
    ).join("  ");
    return truncateToWidth(line, width);
  }

  // Footer shows discoverable actions only; j/k/g/G movement is a power-user
  // convention kept out of the guide (Daniel, 2026-07-04).
  private footer(width: number): string {
    if (this.flashMessage !== null) {
      return truncateToWidth(this.flashMessage, width);
    }
    if (this.preview !== null) {
      return truncateToWidth("Esc back · r refresh · q quit · y yank", width);
    }
    if (this.hasInputFocus()) {
      return truncateToWidth("Enter search · Esc results · Ctrl+C quit", width);
    }
    if (this.activeTab === "search") {
      return truncateToWidth("/ focus · Enter preview · r refresh · q quit · y yank", width);
    }
    if (this.activeTab === "files") {
      return truncateToWidth("Enter preview/toggle · ←/→ collapse/expand · r refresh · q quit · y yank", width);
    }
    if (this.activeTab === "sessions") {
      if (this.sessionsPanel.isDetailOpen()) {
        return truncateToWidth("Esc back · r refresh · q quit · y yank", width);
      }
      return truncateToWidth("Enter details · r refresh · q quit · y yank", width);
    }
    return truncateToWidth("Enter diff · r refresh · q quit · y yank", width);
  }

  private openPreview(request: PreviewRequest, requestRender: () => void): void {
    const generation = this.previewGeneration + 1;
    this.previewGeneration = generation;
    this.preview = {
      path: request.path,
      lines: ["loading preview..."],
      scrollOffset: 0,
      cursorLine: 0,
      highlightQuery: request.highlightQuery,
      breadcrumbKind: request.kind === "diff" ? `${request.diffKind ?? "unstaged"} diff` : undefined,
    };
    requestRender();

    void loadPreview(this.projectDir, request, this.getBodyHeight()).then((preview) => {
      if (this.previewGeneration !== generation) {
        return;
      }
      this.preview = preview;
      requestRender();
    });
  }

  private handlePreviewKey(data: string): void {
    if (matchesKey(data, "escape")) {
      this.closePreview();
      return;
    }

    if (matchesKey(data, "1")) {
      this.closePreview();
      this.activeTab = "files";
      return;
    }
    if (matchesKey(data, "2")) {
      this.closePreview();
      this.activeTab = "git";
      return;
    }
    if (matchesKey(data, "3")) {
      this.closePreview();
      this.activeTab = "search";
      return;
    }
    if (matchesKey(data, "4")) {
      this.closePreview();
      this.activeTab = "sessions";
      return;
    }
    if (matchesKey(data, "/")) {
      this.closePreview();
      this.activeTab = "search";
      this.searchPanel.focusInput();
      return;
    }

    if (this.preview === null) {
      return;
    }

    if (matchesKey(data, "y")) {
      this.yankActivePayload();
      return;
    }

    const contentHeight = Math.max(1, this.getBodyHeight() - 1);
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      movePreviewCursor(this.preview, contentHeight, "down");
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      movePreviewCursor(this.preview, contentHeight, "up");
      return;
    }
    if (matchesKey(data, "g")) {
      movePreviewCursor(this.preview, contentHeight, "top");
      return;
    }
    if (matchesKey(data, "shift+g")) {
      movePreviewCursor(this.preview, contentHeight, "bottom");
      return;
    }
  }

  private yankActivePayload(): void {
    const payload = this.preview === null
      ? (this.panels[this.activeTab].yankPayload?.() ?? null)
      : previewYankPayload(this.preview);
    if (payload === null) {
      return;
    }

    yankToClipboard(payload, this.terminal);
    this.flash(`yanked ${payload}`);
  }

  private flash(message: string): void {
    this.flashMessage = message;
    if (this.flashTimer !== null) {
      clearTimeout(this.flashTimer);
    }
    this.flashTimer = setTimeout(() => {
      this.flashMessage = null;
      this.flashTimer = null;
      this.requestRender();
    }, YANK_FLASH_MS);
    this.requestRender();
  }
}

export function startApp(options: AppOptions): void {
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TUI(terminal);
  const shell = new AppShell(
    options.projectDir,
    terminal,
    // header + tab bar + blank + blank + footer = 5 chrome rows
    () => Math.max(1, terminal.rows - 5),
    () => tui.requestRender(),
  );
  let exiting = false;
  let gitWatcher: GitAutoWatcher | null = null;
  let sessionsWatcher: SessionsAutoWatcher | null = null;

  tui.addChild(shell);
  const refreshAll = (): void => {
    void shell.refreshAll().finally(() => {
      sessionsWatcher?.ensureWatching();
      tui.requestRender();
    });
  };
  const refreshGit = (): void => {
    void shell.refreshGit().finally(() => {
      tui.requestRender();
    });
  };
  const refreshSessions = (): void => {
    void shell.refreshSessions().finally(() => {
      sessionsWatcher?.ensureWatching();
      tui.requestRender();
    });
  };
  const quit = (): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    gitWatcher?.close();
    sessionsWatcher?.close();
    shell.dispose();
    tui.stop();
    void terminal.drainInput(250, 25).finally(() => {
      process.exit(0);
    });
  };

  tui.addInputListener((data) => {
    // Kitty keyboard protocol (active in Ghostty) reports key releases as
    // separate events; TUI only filters them for focused components, not
    // input listeners. Without this, every keypress is handled twice.
    if (isKeyRelease(data)) {
      return { consume: true };
    }

    if (matchesKey(data, "ctrl+c")) {
      quit();
      return { consume: true };
    }

    if (shell.hasInputFocus()) {
      shell.handleInput(data);
      tui.requestRender();
      return { consume: true };
    }

    if (matchesKey(data, "q")) {
      quit();
      return { consume: true };
    }

    if (matchesKey(data, "r")) {
      shell.closePreview();
      refreshAll();
      tui.requestRender();
      return { consume: true };
    }

    shell.handleInput(data);
    tui.requestRender();
    return { consume: true };
  });

  tui.start();
  gitWatcher = new GitAutoWatcher(options.projectDir, refreshGit);
  sessionsWatcher = new SessionsAutoWatcher(() => shell.sessionsStateDir(), refreshSessions);
  refreshAll();
}

class GitAutoWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    projectDir: string,
    private readonly onRefresh: () => void,
  ) {
    const gitDir = join(projectDir, ".git");
    this.watchPath(join(gitDir, "HEAD"));
    this.watchPath(join(gitDir, "index"));
  }

  close(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  private watchPath(path: string): void {
    if (this.watchers.has(path) || !existsSync(path)) {
      return;
    }

    const watcher = watch(path, () => {
      this.rearm(path);
      this.scheduleRefresh();
    });
    watcher.on("error", () => {
      if (this.watchers.get(path) === watcher) {
        this.watchers.delete(path);
      }
    });
    watcher.on("close", () => {
      if (this.watchers.get(path) === watcher) {
        this.watchers.delete(path);
      }
    });
    this.watchers.set(path, watcher);
  }

  private rearm(path: string): void {
    const watcher = this.watchers.get(path);
    if (watcher !== undefined) {
      this.watchers.delete(path);
      watcher.close();
    }
    this.watchPath(path);
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onRefresh();
    }, GIT_REFRESH_DEBOUNCE_MS);
  }
}

class SessionsAutoWatcher {
  private watcher: FSWatcher | null = null;
  private watchedPath: string | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly getStateDir: () => string,
    private readonly onRefresh: () => void,
  ) {
    this.ensureWatching();
  }

  ensureWatching(): void {
    const stateDir = this.getStateDir();
    if (this.watchedPath === stateDir && this.watcher !== null) {
      return;
    }

    if (!existsSync(stateDir)) {
      this.closeWatcher();
      this.watchedPath = null;
      return;
    }

    this.closeWatcher();
    this.watchedPath = stateDir;
    const watcher = watch(stateDir, () => {
      this.scheduleRefresh();
    });
    watcher.on("error", () => {
      if (this.watcher === watcher) {
        this.closeWatcher();
      }
    });
    watcher.on("close", () => {
      if (this.watcher === watcher) {
        this.watcher = null;
        this.watchedPath = null;
      }
    });
    this.watcher = watcher;
  }

  close(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.closeWatcher();
  }

  private closeWatcher(): void {
    const watcher = this.watcher;
    this.watcher = null;
    this.watchedPath = null;
    watcher?.close();
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onRefresh();
    }, SESSIONS_REFRESH_DEBOUNCE_MS);
  }
}
