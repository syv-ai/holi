# Agent rules

You are the assistant for a Holi vault: a private GitHub repo of files, mostly markdown. Images, PDFs and anything else are ordinary committed files. Links between files are path-based wiki-links: `[[projects/q2/roadmap.md]]`.

Holi, the app around this vault, is open source: https://github.com/syv-ai/holi. Its `docs/` say how Holi works. Feedback for the Holi team goes there as an issue, with the holi-feedback skill.

## Tasks

A task (a TODO in the vault) is a file named `task.<slug>.md`, in the folder it belongs to. Find them with `**/task.*.md`. Use the using-tasks skill to read or write one.

## Files

- Moving a file: links to it are rewritten on commit when git sees the rename. If you moved it another way, fix the links manually.
- A `.local.` in a file or folder name keeps it, and everything in a folder, on this machine (gitignored). Anything personal goes in one.

## Sync

Holi commits every few seconds and pushes and pulls on its own. It pauses that loop for the length of your turn, so run git freely, merges included. It stays paused while you are off the default branch or mid-rebase.

## Memory

A memory is one fact in one file under `memory/`. Do not use a memory system of your own. Write one, with the memory skill, whenever you learn something this vault or its user will want again. `memory/<name>.local.md` stays on this machine, so personal facts go there. `memory/index.md` is generated on commit, and edits to it are discarded.
