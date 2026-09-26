# Daily notes

A vault can keep a journal: one note per day, `DD-MM-YYYY.md` at the vault root, made when the
vault opens and filed into `journal/` once the day is over. Whether a vault does is its
`dailyNotes` setting, and what it opens on is its `landing` setting.

## How it works

- **Creating.** `getOrCreateDaily` writes today's file if it is absent and returns its path. The
  seed is `type: daily-note` and `date: YYYY-MM-DD` frontmatter, then a `# DD-MM-YYYY` heading.
  "Today" is the device's local date, computed per call, so after midnight you get tomorrow's note.
- **Opening a vault** runs, in order: open the vault, land, sweep. With `dailyNotes` on, landing
  first makes sure today's note exists, whatever `landing` says. Then it opens the target:
  `daily` (the default), a `note` path, an `app` id, or the `board`, `agenda` or `mail` surface.
  A note or app that no longer exists re-resolves as if `landing` were unset. With `dailyNotes`
  off and no other target, the vault opens on an empty pane.
- **⌘⇧D** creates and opens today's note in any vault, including one with `dailyNotes` off.
- **The sweep** runs on open when `dailyNotes` is on. It looks at root-level files whose
  frontmatter says `type: daily-note`, skipping today's. An untouched stub (body empty or only the
  seeded heading) that nothing links to is deleted. Anything else is moved to `journal/` through
  the standard rename, so links follow it. If anything changed, the sweep ends in one commit.
- **In the tree**, today's row carries a `today` marker, plus the count of open tasks whose body
  wiki-links to today's note. No file, no marker.
- The onboarding ritual asks both settings at vault creation ([settings](settings.md)).

## Rules

- The seed is byte-for-byte deterministic for a date. Two offline devices then write the same blob
  at the same path, and git merges it with no conflict. No timestamps, ids or locale formatting.
- The sweep selects by the `type: daily-note` marker, never by filename shape, so a hand-written
  note named like a date is never swept or deleted. `isDailyNoteFilename` is for display only.
- A note that cannot be positively classified as an untouched stub is never deleted, and a stub
  something links to is archived instead. There is no orphan rescue, so a wrong delete is final.
- Only root-level dailies are swept, which keeps a re-run a no-op.
- Minting is not landing. A vault that lands on its board still keeps its journal.
- `dailyNotes` off stops the automatic work only; it does not remove the feature.
- Use a local-date formatter, never `toISOString()`: UTC gives the wrong day near midnight.
- The task badge counts open tasks linking to the note, not tasks due today; due-today is a board
  question.
- `landing` names the daily by kind, not path: a path would rot overnight.
- `landing` is one target, not a list. The strip inserts surfaces leftmost and apps rightmost, so
  a list's order could not hold.

## Rejected

- Inferring daily notes from the GitHub collaborator count: a guess nobody was asked, a network
  call on every cold start, and decided by a timeout when offline. The setting replaced it.
- Per-person daily paths (`daily/<login>/…`) for shared vaults: deferred. Today everyone in a
  shared vault writes the same file, and the setting's explanation says so.
- A sidebar "Today" chip: it named a file you could not see and did nothing in a shared vault.

## Code

- `packages/shared/src/daily-note.ts`: filename, seed, the untouched-stub test, marker predicates.
- `apps/desktop/src/main/vault/daily.ts`: `getOrCreateDaily`, `sweepDaily`.
- `apps/desktop/src/renderer/src/state/daily.ts`: `ensureTodaysDailyAtom`,
  `openTodaysDailyAtom`, `sweepDailyAtom`, `todayDailyPathAtom`.
- `apps/desktop/src/renderer/src/state/landing.ts` and `lib/landing-target.ts`: the landing
  dispatch and its pure rot rules.
- `apps/desktop/src/renderer/src/components/Shell.tsx`: the open, land, sweep effect.
