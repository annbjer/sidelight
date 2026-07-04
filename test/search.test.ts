import assert from "node:assert/strict";
import { test } from "node:test";
import { grepArgs, parseGrepOutput } from "../src/git.js";
import { filterFilenameMatches, highlightMatches } from "../src/search-format.js";

test("parses a simple grep match", () => {
  assert.deepEqual(parseGrepOutput("src/app.ts:12:4:const value = query\n"), {
    matches: [{ path: "src/app.ts", line: 12, col: 4, text: "const value = query" }],
    capped: false,
  });
});

test("keeps colons in matched text", () => {
  assert.deepEqual(parseGrepOutput("src/config.ts:8:17:url: http://localhost:3000\n"), {
    matches: [{ path: "src/config.ts", line: 8, col: 17, text: "url: http://localhost:3000" }],
    capped: false,
  });
});

test("preserves multiple file order from grep output", () => {
  assert.deepEqual(
    parseGrepOutput(`src/a.ts:1:1:first
src/b.ts:2:5:second
src/a.ts:3:9:third
`),
    {
      matches: [
        { path: "src/a.ts", line: 1, col: 1, text: "first" },
        { path: "src/b.ts", line: 2, col: 5, text: "second" },
        { path: "src/a.ts", line: 3, col: 9, text: "third" },
      ],
      capped: false,
    },
  );
});

test("parses empty grep output", () => {
  assert.deepEqual(parseGrepOutput(""), { matches: [], capped: false });
});

test("highlightMatches wraps smart-case occurrences in inverse video", () => {
  assert.equal(highlightMatches("see README.md here", "readme"), "see \x1b[7mREADME\x1b[27m.md here");
  assert.equal(highlightMatches("aXbXa", "x"), "a\x1b[7mX\x1b[27mb\x1b[7mX\x1b[27ma");
  assert.equal(highlightMatches("Case stays exact", "case"), "\x1b[7mCase\x1b[27m stays exact");
  assert.equal(highlightMatches("no uppercase match", "Match"), "no uppercase match");
  assert.equal(highlightMatches("untouched", ""), "untouched");
});

test("highlightMatches uses underline for matches inside selected rows", () => {
  assert.equal(highlightMatches("see README.md here", "readme", true), "see \x1b[4mREADME\x1b[24m.md here");
});

test("filterFilenameMatches prefers basename hits and respects smart-case", () => {
  const paths = ["docs/readme-notes.md", "README.md", "src/app.ts", "readme/other.txt"];
  assert.deepEqual(filterFilenameMatches(paths, "readme"), {
    paths: ["README.md", "docs/readme-notes.md", "readme/other.txt"],
    capped: false,
  });
  assert.deepEqual(filterFilenameMatches(paths, "README"), {
    paths: ["README.md"],
    capped: false,
  });
  assert.deepEqual(filterFilenameMatches(paths, "zzz"), { paths: [], capped: false });
});

test("filterFilenameMatches caps results", () => {
  const paths = Array.from({ length: 60 }, (_, index) => `dir/file-${String(index).padStart(2, "0")}.ts`);
  const result = filterFilenameMatches(paths, "file", 50);
  assert.equal(result.paths.length, 50);
  assert.equal(result.capped, true);
});

test("smart-case: lowercase query searches case-insensitively", () => {
  assert.deepEqual(grepArgs("claude"), ["grep", "-n", "-I", "--column", "-F", "-i", "-e", "claude"]);
  assert.deepEqual(grepArgs("3:1 -x"), ["grep", "-n", "-I", "--column", "-F", "-i", "-e", "3:1 -x"]);
});

test("smart-case: uppercase in query keeps search exact", () => {
  assert.deepEqual(grepArgs("Claude"), ["grep", "-n", "-I", "--column", "-F", "-e", "Claude"]);
});

test("caps grep output at 500 matches", () => {
  const text = Array.from({ length: 600 }, (_, index) => `src/file.ts:${index + 1}:1:match ${index + 1}`).join("\n");
  const parsed = parseGrepOutput(text);

  assert.equal(parsed.matches.length, 500);
  assert.equal(parsed.capped, true);
  assert.deepEqual(parsed.matches[499], { path: "src/file.ts", line: 500, col: 1, text: "match 500" });
});
