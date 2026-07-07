import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyAgentStart,
  applyModelSelect,
  applyNameChange,
  applyShutdown,
  applyToolCall,
  applyTurnEnd,
  createSnapshot,
  type SessionSnapshot,
} from "../adapters/core/snapshot.js";
import { SnapshotWriter } from "../adapters/core/state-dir.js";

export default function (pi: ExtensionAPI): void {
  let snapshot: SessionSnapshot | null = null;
  let writer: SnapshotWriter | null = null;

  pi.on("session_start", async (event, ctx) => {
    await guard(async () => {
      const cwd = realpathSync(ctx.sessionManager.getCwd() ?? process.cwd());
      snapshot = createSnapshot(sessionIdFrom(ctx), cwd, event.reason, Date.now(), "pi");
      // name/model events only fire on changes; seed initial values from context.
      const initialName = ctx.sessionManager.getSessionName();
      if (initialName !== undefined) {
        snapshot = applyNameChange(snapshot, initialName);
      }
      if (ctx.model !== undefined) {
        snapshot = applyModelSelect(snapshot, ctx.model.id);
      }
      writer = new SnapshotWriter(cwd);
      await writer.writeNow(snapshot);
    });
  });

  pi.on("session_info_changed", async (event) => {
    await guard(async () => {
      if (snapshot === null || writer === null) return;
      snapshot = applyNameChange(snapshot, event.name);
      writer.update(snapshot);
    });
  });

  pi.on("model_select", async (event) => {
    await guard(async () => {
      if (snapshot === null || writer === null) return;
      snapshot = applyModelSelect(snapshot, event.model.id);
      writer.update(snapshot);
    });
  });

  pi.on("agent_start", async () => {
    await guard(async () => {
      if (snapshot === null || writer === null) return;
      snapshot = applyAgentStart(snapshot, undefined, Date.now());
      writer.update(snapshot);
    });
  });

  pi.on("turn_end", async (event) => {
    await guard(async () => {
      if (snapshot === null || writer === null) return;
      snapshot = applyTurnEnd(snapshot, readUsage(event.message), Date.now());
      writer.update(snapshot);
    });
  });

  pi.on("tool_call", async (event) => {
    await guard(async () => {
      if (snapshot === null || writer === null) return;
      snapshot = applyToolCall(snapshot, event.toolName, event.input, Date.now());
      writer.update(snapshot);
    });
  });

  pi.on("session_shutdown", async () => {
    await guard(async () => {
      if (snapshot === null || writer === null) return;
      snapshot = applyShutdown(snapshot, undefined, Date.now());
      writer.update(snapshot);
      await writer.flush();
    });
  });
}

async function guard(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Extensions must never disturb PI sessions.
  }
}

function sessionIdFrom(ctx: ExtensionContext): string {
  return sanitizeSessionId(ctx.sessionManager.getSessionId());
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function readUsage(message: unknown): unknown {
  if (typeof message !== "object" || message === null) return undefined;
  return (message as { usage?: unknown }).usage;
}
