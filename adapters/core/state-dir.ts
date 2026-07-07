import { createHash } from "node:crypto";
import { mkdirSync, promises as fs, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionSnapshot } from "./snapshot.js";

export interface StateDirEnv {
  XDG_STATE_HOME?: string;
  HOME?: string;
}

export function cwdHash(realCwd: string): string {
  return createHash("sha256").update(realCwd).digest("hex").slice(0, 16);
}

export function stateDirFor(cwd: string, env: StateDirEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME ?? path.join(env.HOME ?? os.homedir(), ".local", "state");
  return path.join(stateHome, "sidelight", "sessions", cwdHash(cwd));
}

export class SnapshotWriter {
  readonly dir: string;
  private pending: SessionSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private wroteDirJson = false;

  constructor(
    private readonly cwd: string,
    env: StateDirEnv = process.env,
  ) {
    this.dir = stateDirFor(cwd, env);
  }

  update(snapshot: SessionSnapshot): void {
    this.pending = snapshot;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = this.pending;
      this.pending = null;
      if (pending !== null) void this.write(pending);
    }, 500);
  }

  async writeNow(snapshot: SessionSnapshot): Promise<void> {
    this.pending = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.write(snapshot);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const pending = this.pending;
    this.pending = null;
    if (pending !== null) await this.write(pending);
  }

  private async write(snapshot: SessionSnapshot): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      if (!this.wroteDirJson) {
        await writeAtomic(path.join(this.dir, "dir.json"), JSON.stringify({ cwd: this.cwd }) + "\n");
        this.wroteDirJson = true;
      }

      const finalPath = path.join(this.dir, `${snapshot.sessionId}.json`);
      await writeAtomic(finalPath, JSON.stringify(snapshot, null, 2) + "\n");
    } catch {
      // Extensions must never disturb PI sessions.
    }
  }
}

async function writeAtomic(finalPath: string, contents: string): Promise<void> {
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, contents, "utf8");
  await fs.rename(tempPath, finalPath);
}

export function writeSnapshotSync(stateDir: string, cwd: string, snapshot: SessionSnapshot): void {
  mkdirSync(stateDir, { recursive: true });
  writeAtomicSync(path.join(stateDir, "dir.json"), JSON.stringify({ cwd }) + "\n");
  writeAtomicSync(path.join(stateDir, `${snapshot.sessionId}.json`), JSON.stringify(snapshot, null, 2) + "\n");
}

function writeAtomicSync(finalPath: string, contents: string): void {
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, contents, "utf8");
  renameSync(tempPath, finalPath);
}
