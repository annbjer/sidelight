import { truncateToWidth } from "@earendil-works/pi-tui";

export const INVERSE_ON = "\x1b[7m";
export const INVERSE_OFF = "\x1b[27m";
export const UNDERLINE_ON = "\x1b[4m";
export const UNDERLINE_OFF = "\x1b[24m";

export interface HighlightStyle {
  on: string;
  off: string;
}

export function highlightRow(text: string, width: number): string {
  const row = truncateToWidth(text, width, undefined, true).replace(/\x1b\[(?:0)?m/g, `$&${INVERSE_ON}`);
  return `${INVERSE_ON}${row}${INVERSE_OFF}`;
}

export function matchHighlightStyle(selected: boolean): HighlightStyle {
  return selected
    ? { on: UNDERLINE_ON, off: UNDERLINE_OFF }
    : { on: INVERSE_ON, off: INVERSE_OFF };
}
