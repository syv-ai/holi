# Transcript fixtures

Scrubbed lines of Claude Code's private transcript format: the **structure** of
every line shape seen in real sessions, none of the content. They are what
`../../transcript-corpus.test.ts` replays through the chat reader
(`main/claude/transcript/`), so a Claude Code update that changes a shape, or a
reader change that changes what the chat draws, shows up as a failing test or a
snapshot diff.

| file                | holds                                                                      |
| ------------------- | -------------------------------------------------------------------------- |
| `messages.jsonl`    | prompts, replies, thinking, meta lines                                     |
| `wrappers.jsonl`    | user text in wrapper tags (`<command-name>`, `<task-notification>`, ...)   |
| `tools.jsonl`       | tool calls and their results, built-in and MCP (a result follows its call) |
| `attachments.jsonl` | every `attachment` type                                                    |
| `system.jsonl`      | `system` subtypes                                                          |
| `metadata.jsonl`    | titles, modes, cost, debug copies, the workflow journal                    |
| `compaction.jsonl`  | the compact boundary and its summary                                       |
| `subagent.jsonl`    | a sub-agent's own lines (read with `sidechain: true`)                      |
| `canary.jsonl`      | **hand-written**: invented shapes the reader must count, never drop        |

All but the canary are generated; do not edit them by hand.

## Refreshing

After a Claude Code update, or when `pnpm chat:drift` finds an unknown shape:

```sh
pnpm --filter @holi/desktop run chat:fixtures      # reads your local transcripts
pnpm --filter @holi/desktop exec vitest run src/plugins/agent/test/transcript-corpus.test.ts
git diff --stat src/plugins/agent/test/fixtures   # skim the files before committing
```

`chat:fixtures` (`scripts/scrub-transcript.ts`) takes the smallest few lines of
each distinct shape (type, subtype, attachment type, block types, tool family,
flags) and rewrites them. With no arguments it reads `~/.claude/projects` and
the Holi agent-config `projects` folders; paths can be given instead.

## What scrubbing keeps and loses

- **Kept:** keys, JSON types, booleans, numbers, array lengths (clipped to 3),
  line and whitespace layout, wrapper tags with their closing tag, enum-like
  values under known keys (`type`, `subtype`, `role`, `stop_reason`, `kind`,
  `media_type`, versions, model ids, built-in tool names), the fixed phrases
  Claude Code writes itself (`[Request interrupted by user]`).
- **Replaced:** every other string by `xxxx` words of the same shape; ids by a
  one-way hash of the same form, so `parentUuid` and `tool_use_id` links stay
  valid; timestamps by a fixed 2030 epoch; paths by `/p1a2b/p3c4d.ts`; URLs by
  `https://example.test/...`; base64 by a tiny valid string; MCP tools by
  `mcp__serverN__toolN` (Claude Code's own servers keep their names).

The test audits every fixture on each run (no address, home path, token,
base64 run, URL, or the author's names), and `transcript-corpus.test.ts` also
checks the scrubber on a synthetic private line. The audit is a net, not a
proof: skim a regenerated fixture before committing it.

## Checking the reader against real sessions

```sh
pnpm --filter @holi/desktop run chat:drift [--max-files 150] [--since-days 1] [--json]
HOLI_CHAT_CORPUS=~/.claude/projects pnpm --filter @holi/desktop exec vitest run \
  src/plugins/agent/test/transcript-corpus.test.ts
```

`chat:drift` prints counts, shape signatures, versions and `file:line` places,
never content, and exits 1 when any line has no rule.
