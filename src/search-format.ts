// Pure formatting/filtering helpers for the search panel.

import { matchHighlightStyle } from "./highlight.js";

const DIM_ON = "\x1b[2m";
const DIM_OFF = "\x1b[22m";

// Mirrors grepArgs() smart-case: all-lowercase query compares case-insensitively.
function isCaseInsensitive(query: string): boolean {
  return query === query.toLowerCase();
}

// Wrap every smart-case occurrence of query in inverse-video ANSI, or underline
// when the containing row is already inverse-highlighted.
// pi-tui's truncateToWidth is ANSI-aware, so highlighted lines trim correctly.
export function highlightMatches(text: string, query: string, selected = false): string {
  if (query.length === 0) {
    return text;
  }

  const style = matchHighlightStyle(selected);
  const insensitive = isCaseInsensitive(query);
  const haystack = insensitive ? text.toLowerCase() : text;
  const needle = insensitive ? query.toLowerCase() : query;

  let out = "";
  let pos = 0;
  for (;;) {
    const index = haystack.indexOf(needle, pos);
    if (index === -1) {
      break;
    }
    out += text.slice(pos, index) + style.on + text.slice(index, index + needle.length) + style.off;
    pos = index + needle.length;
  }
  return out + text.slice(pos);
}

export interface FilenameMatches {
  paths: string[];
  capped: boolean;
}

// Paths whose basename (preferred) or full path contains the query, smart-case.
// Basename matches sort first so "readme" surfaces README.md above paths that
// merely contain the word somewhere in a directory name.
export function filterFilenameMatches(paths: readonly string[], query: string, cap = 50): FilenameMatches {
  if (query.length === 0) {
    return { paths: [], capped: false };
  }

  const insensitive = isCaseInsensitive(query);
  const needle = insensitive ? query.toLowerCase() : query;
  const contains = (text: string): boolean => (insensitive ? text.toLowerCase() : text).includes(needle);

  const basenameHits: string[] = [];
  const pathHits: string[] = [];
  for (const path of paths) {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    if (contains(basename)) {
      basenameHits.push(path);
    } else if (contains(path)) {
      pathHits.push(path);
    }
  }

  basenameHits.sort();
  pathHits.sort();
  const all = [...basenameHits, ...pathHits];
  return { paths: all.slice(0, cap), capped: all.length > cap };
}

export function sectionHeader(label: string, count: number, capped = false): string {
  return `${DIM_ON}${label} (${count}${capped ? "+" : ""})${DIM_OFF}`;
}
