# Keyboard shortcuts

The fresh shell's keys live in one table, and the Keyboard shortcuts dialog is drawn from that
same table, so the sheet can only show keys that work. The dialog opens from the profile menu's
**Keyboard shortcuts** item, from `?` outside a text field, and from ⌘/ anywhere. It doubles as a
command list: `?`, ↓ to a row, ↩ runs it, so a person who forgot a key can still use it.

## How it works

- **The table** (`lib/shortcuts.ts`): each row is an id, its keys as glyph strings
  (`lib/hotkey.ts`), the label and group the dialog shows, and when it may fire. It holds no
  handlers: the shell's state is React state in the app shell, so the component that owns a piece
  of state registers a handler for the id while it is mounted (`useShortcutHandlers`,
  `state/shortcuts.ts`). The app shell registers navigation, tabs, apps and help; the file tree
  registers rename and collapse all.
- **Live rows.** The ids with a handler are an atom. A key fires only a live row, and the dialog
  lists only live rows: Mail and Calendar appear once their account is connected, Show agents once
  the agent plugin runs, rename only while the sidebar is open to show the field.
- **One dispatcher.** One `keydown` listener on the window, installed by the app shell, resolves a
  key against the table with a pure function (`resolveShortcut`), so a test says exactly when a key
  does and does not fire. The application menu's `menu:command` channel runs ids the same way.
- **Platform keys.** On a Mac ⌘ is Command and ⌃ is Control, each only itself; elsewhere both are
  Ctrl, and the dialog says `Ctrl`, `Alt`, `Shift`. A Mac never takes Control's text-editing keys
  (⌃B, ⌃K, ⌃N) for a ⌘ shortcut. A symbol key such as `?` ignores the Shift that types it.
- **The dialog** is a shadcn `Dialog` holding the installed `Command` (cmdk) list: one column of
  groups under their headings, each row a `listbox` option whose accessible name is its label and
  its keys (`New tab, ⌘ T`), the keys drawn as `Kbd` chords. The search field is focused on open
  and filters by label, group or key name with the dialog's own substring match
  (`shortcutSections`, cmdk's fuzzy filter off); typing selects the first match. It has no motion
  of its own beyond the Dialog's: it opens many times a day.
- **Running a row.** ↑ ↓ move, Home and End jump, ↩ (or a click) runs the selected row, and the
  first row that runs is selected on open. A row runs through `runShortcutAtom`
  (`state/shortcuts.ts`), which calls the same newest registered handler the `keydown` listener
  and the menu's channel call, so a row can only do what its key does. ⌘W's row runs `tab.close` as the menu's
  accelerator does. Choosing a row closes the dialog first; once it has closed, focus goes back to
  where it was when the dialog opened and only then does the action run, so what the action
  focuses (a new tab, the terminal) keeps it. A plain close hands focus back the same way, since
  the dialog has no trigger for Radix to return to.
- **Rows it only shows** are options marked `aria-disabled`, dimmed and skipped by the arrows: a
  gesture (Split view's drags, ⌥-click), Go to tab ⌘1–9 (one line for nine keys cannot say which
  tab), and Show keyboard shortcuts, the dialog itself. Those carry `listOnly` in the table;
  `runsFromList` says which rows run, and a test pins that every one of them has a handler
  registered somewhere in the renderer. Keys that need focus in a particular place (the editor's
  bold, a list's arrows) are not in the table at all.

## Bindings

| Group      | Action                        | Mac          | Windows / Linux           |
| ---------- | ----------------------------- | ------------ | ------------------------- |
| Navigation | Search                        | ⌘K           | Ctrl K                    |
| Navigation | Toggle sidebar                | ⌘B           | Ctrl B                    |
| Navigation | Show vault                    | ⇧⌘E          | Ctrl Shift E              |
| Navigation | Show agents                   | ⇧⌘A          | Ctrl Shift A              |
| Navigation | Agent sessions                | ⌘J           | Ctrl J                    |
| Navigation | Open board                    | ⇧⌘B          | Ctrl Shift B              |
| Tabs       | Next tab / previous tab       | ⌃Tab / ⌃⇧Tab | Ctrl Tab / Ctrl Shift Tab |
| Tabs       | Go to tab 1 to 8, or the last | ⌘1 to ⌘9     | Ctrl 1 to Ctrl 9          |
| Tabs       | Close tab                     | ⌘W (menu)    | Ctrl W (menu)             |
| Tabs       | New tab                       | ⌘T           | Ctrl T                    |
| Tabs       | Close all tabs                | ⌥⌘W          | Ctrl Alt W                |
| Tabs       | Reopen closed tab             | ⇧⌘T          | Ctrl Shift T              |
| Split view | Split view                    | ⌘\           | Ctrl \                    |
| Split view | Separate split view           | ⇧⌘\          | Ctrl Shift \              |
| Split view | Focus next / previous view    | ⌃⌥→ / ⌃⌥←    | Ctrl Alt → / ←            |
| Panel      | Toggle terminal               | ⌃\`          | Ctrl \`                   |
| Panel      | Show output                   | ⇧⌘U          | Ctrl Shift U              |
| Files      | New document                  | ⌘N           | Ctrl N                    |
| Files      | Open today’s note             | ⇧⌘D          | Ctrl Shift D              |
| Files      | New agent session             | ⇧⌘N          | Ctrl Shift N              |
| Files      | Rename selected file          | F2           | F2                        |
| Files      | Collapse all folders          | ⌥⌘←          | Ctrl Alt ←                |
| Apps       | Open Mail / Open Calendar     | ⇧⌘M / ⇧⌘C    | Ctrl Shift M / C          |
| Help       | Show keyboard shortcuts       | ? or ⌘/      | ? or Ctrl /               |

The document editor's own keys are not in the table: they need focus in a document and are the
editor's to handle ([editor](editor.md)). ⌘F (Ctrl F) finds in the focused document, ⌘G / ⇧⌘G
(Ctrl G / Ctrl Shift G) step through its matches while the find bar is open, ⌘D (Ctrl D) selects
the word or adds its next occurrence, and ⇧⌥↓ (Shift Alt ↓) duplicates the block. None of them
clashes with the table or the menu: the menu's Edit role has no Find, and ⌃⌘F is View's full
screen.

## Rules

- **Never while typing, unless the row says so.** In a text field, the editor or the terminal only
  rows marked `whileTyping` fire, which is every modified key except collapse all; `?` and F2 are
  characters or the field's own there. In the terminal no Control key fires, with one exception:
  those are the terminal's (Claude Code's own keys included), and on a Mac ⌘ is free because xterm
  leaves Command alone. The exception is ⌃\`, which toggles the bottom panel
  ([status bar](status-bar.md)) and is marked `inTerminal`, so the panel closes from inside the
  shell it shows; the panel's xterm hands it back rather than typing it. The panel keys are VS
  Code's, registered by the panel itself, and clash with nothing in the menu or the table (⌘\` is
  macOS's window cycling, so the toggle is on Control).
- **The focused widget wins.** A key it handled (`defaultPrevented`) is not a shortcut, which is how
  the editor's ⌘B stays bold. shadcn's sidebar had its own ⌘B listener; it is removed, or the
  sidebar would toggle twice.
- **⌘B in an app only opens the sidebar.** With Mail or Calendar in front, ⌘B shows or hides the
  files sidebar as it does anywhere, and the app stays in front, so there is nothing to confirm.
- **⌘N is the side's own new.** On the Vault side a document; on the Agents side a session in
  the default agent (the mode's `newSession`). One binding, so the two never fire together.
- **Behind a dialog** only the dialog toggles fire (⌘K, ⌘/, `?`): ⌘N must not make a document
  behind a modal.
- **⌘W is the menu's.** It is the File menu's accelerator (`main/menu.ts`), which fires before the
  page sees the key, so its row is display only (`boundBy: 'menu'`) and main sends `tab.close`.
  Mail, Calendar and Settings are tabs, so ⌘W closes them like any other.
- **The tab keys act on the one strip** ([tabs and split view](tabs-panes.md)): next, previous
  and ⌘1–9 go over its entries, a split counting as one; ⌥⌘W closes them all. **⌘W closes the
  view in front:** the focused member inside a split (a 2-split turns back into a tab), the tab
  otherwise. ⌘T opens a New tab at the strip's end, or while the sidebar is on Agents starts a
  session in the default agent, as + does.
- **⌥-click opens beside.** ⌥-click (or ⌥↩) a document, a session, a search result or a link and
  it opens in split view beside what is in front, up to four views; the dialog lists it as a
  gesture under Split view.
- **Split view keys.** ⌘\ makes a split of the active tab and a New tab (or adds a New tab to a
  split with room). ⇧⌘\ separates the active split and ⌃⌥→ / ⌃⌥← step its focused member; the
  three are live, and listed, only while a split is active. Shift turns `\` into `|` on most
  layouts, so the separate row lists both characters, and a key whose spec names the Shift held
  wins over a symbol key that would ignore it (`resolveShortcut`), so ⇧⌘\ never splits. The
  members step on ⌃⌥ because ⌥⌘← is Collapse all folders. The dialog's Split view group also lists
  the drags (to a view's edge, onto a view, a header to the tabs) as gesture rows: a row with no
  keys and a `gesture`, listed while the row it names in `liveWith` is.
- **⌘T is free.** The menu binds only ⌘W and ⌘⇧W, and the earlier shell's ⌘T (quick-add task in
  `state/commands.ts`) is not mounted by the fresh shell; `plugin-api/types.ts` still declares `Command` and `RendererPlugin.commands`, which nothing reads.
- **No clashes** with the menu's accelerators (Edit's ⌘Z ⌘X ⌘C ⌘V ⌘A, View's ⌘R ⌘0 ⌘+ ⌘-
  ⌥⌘I ⌃⌘F, Window's ⌘M, ⌘⇧W, ⌘H, ⌘Q) or macOS's own (⌘Tab, ⌘Space, ⌘\`). A test pins ids and
  keys unique.
- The table is separate from `state/commands.ts`, the earlier shell's command table, whose rows run
  pane and workspace atoms the fresh shell does not have, and which no view mounts. Both match keys with `lib/hotkey.ts`.

## Rejected

- Binding the shortcuts as menu accelerators: one on ⌘K would take the key from CodeMirror's link
  command, and every accelerator fires in the terminal.
- ⌘⇧] / ⌘⇧[ for tab stepping: on a Mac the key with Shift is `}`, so it needs a physical-key match
  for one pair; ⌃Tab is the convention every platform shares.
- Rebindable keys.
