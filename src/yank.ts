import type { Terminal } from "@mariozechner/pi-tui";
import { isDenied } from "./denylist.js";

// Defense in depth (same discipline as loadPreview): no panel can place the
// cursor on a deny-listed path, but path-based yank payloads refuse them
// anyway rather than trusting callers. `line` appends ":<line>".
export function pathYankPayload(relPath: string, line?: number): string | null {
  if (isDenied(relPath)) {
    return null;
  }
  return line === undefined ? relPath : `${relPath}:${line}`;
}

export function osc52(payload: string): string {
  return `\x1b]52;c;${Buffer.from(payload, "utf8").toString("base64")}\x07`;
}

export function yankToClipboard(payload: string, terminal: Terminal): void {
  terminal.write(osc52(payload));
}
