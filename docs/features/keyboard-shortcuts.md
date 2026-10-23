# Keyboard shortcuts

The fresh shell's keys live in one table, and the Keyboard shortcuts dialog is drawn from that
same table, so the sheet can only show keys that work. The dialog opens from the profile menu's
**Keyboard shortcuts** item, from `?` outside a text field, and from ⌘/ anywhere.

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
- **The dialog** is ReUI's `sheet-3` (searchable, grouped, `Kbd` chords, empty state) set in a
  shadcn `Dialog` in two columns, with a search field focused on open that filters by label,
  group or key name. It has no motion of its own beyond the Dialog's: it opens many times a day.

## Bindings

| Group      | Action                        | Mac          | Windows / Linux           |
| ---------- | ----------------------------- | ------------ | ------------------------- |
| Navigation | Search                        | ⌘K           | Ctrl K                    |
| Navigation | Toggle sidebar                | ⌘B           | Ctrl B                    |
| Navigation | Show documents                | ⇧⌘E          | Ctrl Shift E              |
| Navigation | Show agents                   | ⇧⌘A          | Ctrl Shift A              |
| Navigation | Open board                    | ⇧⌘B          | Ctrl Shift B              |
| Tabs       | Next tab / previous tab       | ⌃Tab / ⌃⇧Tab | Ctrl Tab / Ctrl Shift Tab |
| Tabs       | Go to tab 1 to 8, or the last | ⌘1 to ⌘9     | Ctrl 1 to Ctrl 9          |
| Tabs       | Close tab                     | ⌘W (menu)    | Ctrl W (menu)             |
| Tabs       | Close all tabs                | ⌥⌘W          | Ctrl Alt W                |
| Tabs       | Reopen closed tab             | ⇧⌘T          | Ctrl Shift T              |
| Files      | New document                  | ⌘N           | Ctrl N                    |
| Files      | Rename selected file          | F2           | F2                        |
| Files      | Collapse all folders          | ⌥⌘←          | Ctrl Alt ←                |
| Apps       | Open Mail / Open Calendar     | ⇧⌘M / ⇧⌘C    | Ctrl Shift M / C          |
| Help       | Show keyboard shortcuts       | ? or ⌘/      | ? or Ctrl /               |

## Rules

- **Never while typing, unless the row says so.** In a text field, the editor or the terminal only
  rows marked `whileTyping` fire, which is every modified key except collapse all; `?` and F2 are
  characters or the field's own there. In the terminal no Control key fires at all: those are the
  terminal's (Claude Code's own keys included), and on a Mac ⌘ is free because xterm leaves Command
  alone.
- **The focused widget wins.** A key it handled (`defaultPrevented`) is not a shortcut, which is how
  the editor's ⌘B stays bold. shadcn's sidebar had its own ⌘B listener; it is removed, or the
  sidebar would toggle twice.
- **Behind a dialog** only the dialog toggles fire (⌘K, ⌘/, `?`): ⌘N must not make a document
  behind a modal.
- **⌘W is the menu's.** It is the File menu's accelerator (`main/menu.ts`), which fires before the
  page sees the key, so its row is display only (`boundBy: 'menu'`) and main sends `tab.close`.
  With Mail or Calendar holding the window, ⌘W puts the app away instead of closing a hidden tab.
- **No clashes** with the menu's accelerators (Edit's ⌘Z ⌘X ⌘C ⌘V ⌘A, View's ⌘R ⌘0 ⌘+ ⌘-
  ⌥⌘I ⌃⌘F, Window's ⌘M, ⌘⇧W, ⌘H, ⌘Q) or macOS's own (⌘Tab, ⌘Space, ⌘\`). A test pins ids and
  keys unique.
- The table is separate from `state/commands.ts`, the earlier shell's command table, whose rows run
  pane and workspace atoms the fresh shell does not have. Both match keys with `lib/hotkey.ts`.

## Rejected

- Binding the shortcuts as menu accelerators: one on ⌘K would take the key from CodeMirror's link
  command, and every accelerator fires in the terminal.
- ⌘⇧] / ⌘⇧[ for tab stepping: on a Mac the key with Shift is `}`, so it needs a physical-key match
  for one pair; ⌃Tab is the convention every platform shares.
- Rebindable keys.
