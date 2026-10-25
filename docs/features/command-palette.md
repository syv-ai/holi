# Command menu

One box that goes anywhere and does anything the shell can do right now: ⌘K, or the sidebar's
Search row. It finds the vault's documents, files and apps by name and by what the notes say,
goes to the views, and runs the shell's actions with the same handlers their keys run.

## How it works

- **Untyped**, it shows three groups:
  - **Recent:** the vault's six newest paths by modified time.
  - **Go to:** Board, Apps (while the vault apps plugin runs), Today's note, what plugins add
    (the Inbox, Automations), the Documents and Agents sidebars, Mail and Calendar (while they are
    listed), and Settings.
  - **Actions:** the shell's live actions (Terminal and Output among them), then New task, New
    session, New app, what plugins add (New automation, New Holi, How Holis work), Sync now, Add
    vault, and one "Switch to" row per other vault.
- **Typed**, it ranks with `command-score`:
  - **Documents:** every visible vault path and vault app, scored on its name, then on its path at
    half weight, so a folder name still finds the file inside it. The list is capped at 50 rows.
  - **In text:** from two typed characters, the notes whose text holds the query, with the words
    around the match beside the name. Main reads the bodies (`notes.search`) once typing pauses.
    An answer for a query no longer in the box is dropped. Only a path the menu lists by name can
    appear, and only once. While the search runs the group says so, and a failed search offers
    a Retry row.
  - **Go to** and **Actions** follow, scored on the label, then on a few other words at half weight
    ("preferences" finds Settings).
  - **Groups too long to list untyped** come last, each found by typing: every Settings page,
    the theme (light, dark, system), Help and File an issue, each Holi, each automation, each
    conversation in the session list, and the account (Profile, Sign out).
- **`>`** at the front lists the actions and the places to go only, as VS Code's box does.
- **The actions are the shortcut table** (`lib/shortcuts.ts`). Each row is a table row that has a
  live handler right now (`liveShortcutIdsAtom`). It shows that row's key and runs through
  `runShortcutAtom`, the same handler its key runs. Split view's rows appear only while there is
  a split to act on. A key that does nothing in the current state is not offered.
- **Choosing** closes the menu first, then opens or runs on the next frame. Whatever opens takes
  focus, and a dialog an action opens is not closed along with the menu.
  - ↵ opens a row in the tab in front.
  - ⌘↵ (Ctrl ↵) or ⌥↵ opens it beside, in split view.
  - The menu's foot lists these keys.
- **Ask the agent.** With text typed (outside `>`), the last row sends it to the agent as the
  first turn of a new session, in this machine's default agent. The session opens in its terminal
  in a tab of its own, which comes forward. When nothing else matches, it is the only row and
  already selected, so ↵ sends. It goes through `AgentsSlot.start` (`startConversationAtom`),
  which the agent provides.
  Without a running agent the row is not offered.
- **Nothing matching** (with no agent to ask) says so with the query and offers Clear search.

- **A plugin's rows** come through `RendererPlugin.commandMenu`: an atom of entries (an id, a
  label, an icon, keywords, a muted detail, and a group: `go`, `action`, or a name of its own
  that lists only once something is typed) and a `run` that takes the id. The agent adds the
  Inbox and its conversations, automations their list, New automation and each one, and the
  Holis New Holi, How Holis work and each Holi. Each opens what its sidebar row opens, so it
  becomes a tab the same way.

## Rules

- Ranking is a pure function outside cmdk (`shouldFilter={false}`), so the node test and the
  screen agree.
- Hidden paths (`.claude/`, `.holi/`) are never listed, by name or by text.
- An action is never a second list of shortcuts: one with no key is either a place (Board, Today's
  note) or one of the few creations the table has no key for (New task, New session).
- It is the installed shadcn `CommandDialog`, unstyled.

## Not here yet

- Recents across kinds (what you opened, not what was edited) and the ⌃⇥ tab switcher.

## Code

- `apps/desktop/src/renderer/src/components/blocks/app-shell-21/components/command-menu.tsx`: the
  menu.
- `apps/desktop/src/renderer/src/lib/command-menu-rows.ts`: rows and ranking
  (`apps/desktop/test/command-menu-rows.test.ts`).
- `apps/desktop/src/renderer/src/state/shortcuts.ts`: `runShortcutAtom`.
- `apps/desktop/src/renderer/src/state/agents-slots.ts`: `startConversationAtom`.
- `apps/desktop/src/renderer/src/state/plugins.ts`: `commandMenuEntriesAtom`; each plugin's
  `command-menu.ts` (agent, automations, holis).
- `apps/desktop/src/main/router.ts`: `notes.search`.
