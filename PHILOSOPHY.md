# Philosophy — what sidelight is, and what it will never be

Sidelight is a trust-shaped tool. The panels — files, git, search, sessions — are how you
experience it; the product is the set of guarantees underneath them. Those guarantees are
the point, so they are stated here as commitments, not defaults.

## The guarantees

- **Read-only toward your project.** Sidelight never creates, modifies, or deletes a file
  in your project. Not with a flag, not in a future version.
- **No network. No telemetry.** Sidelight opens no sockets and phones nothing home. There
  is no "anonymous usage data," no update check, no crash reporter. If you want to tell us
  something broke, that's what issues are for.
- **Only `git` is ever spawned** — with argv arrays, never through a shell. No editors, no
  clipboard helpers (copy uses the OSC 52 terminal escape), no package managers, nothing.
- **No daemon, no index, no cache.** One foreground process you can see and kill. Search
  runs `git grep` when you press Enter; nothing scans your disk in the background, and
  nothing copies your code anywhere.
- **Content only on explicit keypress.** Panels show metadata (names, counts, stats) by
  default. File contents and diffs appear only when you deliberately open them.
- **The deny-list is enforced at every choke point** — file tree, search results, git
  status, previews, and yank. Secret-looking files (`.env*`, keys, certs) don't render,
  don't match, don't preview, don't copy.
- **The PI extension records metadata through a fixed allowlist** — session name, model,
  timestamps, counts, token totals, deny-list-filtered file paths. It structurally cannot
  record your prompts, replies, tool outputs, or command strings, because it never reads
  those fields at all. Its snapshots are plain JSON files you can `cat`. It is the only
  component that writes anything, it writes only in its own state directory, and it is
  optional.
- **Small enough to read.** A few thousand lines, three runtime concepts, one small TUI
  dependency plus the Node standard library. Reading the whole thing in an afternoon is a
  supported use case — arguably the most important one.

## What we will never add

These are not "not yet." They are the boundaries that make sidelight worth trusting, and
they are not up for re-litigation in issue threads:

- Write access to your project (staging, committing, editing, file operations)
- Network features of any kind — sync, sharing, remote anything, update checks, telemetry
- A background daemon or persistent watcher beyond in-process `fs.watch`
- A search index or any cache of your code on disk
- Recording of prompt/response content in session metadata
- A plugin system (inspectability dies when arbitrary code loads into the trusted process)
- Config sprawl — if a behavior needs a config file to be defensible, it needs a rethink

Feature requests that fit inside the guarantees are welcome. Requests that require
breaking one will be closed with a link to this document — kindly, and without exception.

## Why so strict

Agentic coding has a specific anxiety: tools are doing things and you can't quite see
what. Most tools answer with more features. Sidelight answers with fewer: a pane of glass
whose entire behavior you can verify. In a landscape where "what is this AI tool actually
doing to my machine?" is the question, being the tool that can be read is the feature.

Boring is durable. Boring survives dependency churn and supply-chain scares. Boring is a
compliment here.
