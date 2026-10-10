# Settings

A vault's settings are two YAML files it carries itself: `.holi/settings/app.yaml`, committed and shared with everyone who clones the vault, and `.holi/settings/app.local.yaml`, this machine's override. The settings tab edits them, the onboarding ritual asks a subset at a vault's birth, and the files explain themselves to whoever opens them, person or agent.

## How it works

**One declaration.** `VAULT_SETTINGS` in `@holi/shared` declares every setting once: key, label, explanation, type, default, target file, whether the ritual asks it, and which tab section shows it. The defaults, the reader, the write validator, the settings rows and the generated file are all derived from it. A setting's type carries both validation and the control's options, so a control cannot offer a value the validator refuses.

| Key                                   | File      | Asked at birth | Default                      |
| ------------------------------------- | --------- | -------------- | ---------------------------- |
| `dailyNotes`                          | committed | yes            | `true`                       |
| `home`                                | committed | yes            | `recents`                    |
| `hooks` (a flag per commit transform) | committed | yes            | all on except `archive-done` |
| `maxCommittedFileBytes`               | committed | no             | 10 MB                        |
| `colorScheme`                         | local     | yes            | `system`                     |
| `editorFont`                          | committed | no             | `serif`                      |
| `plugins` (id to on or off)           | both      | no             | each plugin's own            |

`home` is Home: what the nav's Home and "Go home" go to, and what the vault opens on. One string: `recents` (what was opened recently, the default), `daily` (today's note, offered while `dailyNotes` is on), a view's name (a bare name with no slash or dot: `board`, `agenda`, `mail`, or any `homeable` surface a plugin adds), or any app or file by its vault path. The recents and a finished folder document (an app) are shown in the Home tab; anything else opens as itself. A target that is not there (a deleted file or app, `daily` with `dailyNotes` off, a view whose plugin is off or that cannot be Home) opens the Home tab saying so. The row offers, in sections, the fixed choices (Built in), the views that can be Home in this vault (Views), and the vault's shared apps under the nav menu's word for them (Apps), plus the current value when it is none of them (File), so an app named Home does not read as Home naming itself; a personal `.local.` app is not offered, since the row writes the committed file. A personal Home is `home:` in `app.local.yaml`.

`plugins` says which plugins the vault runs. The committed file declares them, and the local file can only turn one off on this machine: a local `true` is dropped with a warning. A plugin the vault does not mention runs as its own default says. `enabledPlugins` resolves the set, in main and in the renderer alike. The committed file lists every plugin this build has, an unanswered one commented with its default; the local file shows the block only when it answers one. Unknown ids are kept and ignored. The settings tab shows a switch per installed plugin under General, which writes the committed file, and notes when this machine has a plugin off. Beside each switch: what the plugin is and what turning it off does (`PluginInfo.description` and `whenOff`), and what it adds, read off its renderer contributions (nav items, hotkeys, settings sections) so it cannot drift from what it does. A write that turns one on seeds its files and starts it at once; a hand edit is in force for the plugin's capabilities at once, and seeds and starts it at the vault's next open ([architecture](../architecture.md#plugins)).

**Reading.** `resolveVaultSettings` parses both files, applies the local one per key (the `hooks` block per flag, `plugins` as above), validates every field, and answers the default for anything absent or malformed with a warning. In `hooks` a name no transform in this build has is kept and ignored, so a vault can switch a plugin's transform on a machine without that plugin; a write may switch only the known ones (core's `CORE_TRANSFORMS` and each installed plugin's `PluginInfo.transforms`), which is also the list the Commits row and the onboarding act show. It never throws. It builds a fresh narrow value per key and never returns what it parsed. Unknown top-level keys are ignored without a warning, because the reminder watermark lives in the local file.

**Writing.** `settings.write` takes JSON strings and runs them through `parseSettingsPatch`, the same validator a teammate's committed file meets, so a write cannot add a key Holi does not own. Each file is merged and replaced with one atomic rename. `writeSettingsText` regenerates the whole document every time: a header saying which file this is, then every setting with its explanation and legal values above it. An unanswered setting is a commented-out line showing its default, so the default can still improve later. Unknown keys are kept under a trailing heading.

**The settings tab.** A singleton tab with a rail: General, Editor, Appearance, Icons, Commits, then every enabled plugin's sections (Google's Connections, the agent's Quick agent, which is this machine's: its switch, off until turned on, its two global keys, each recorded by pressing it, its two choices about how a quick agent runs, and the selection permission; see [quick-agent](quick-agent.md)), then Vault, Account and Updates (this machine's app, see [updates](updates.md)). A plugin adds one as `settingsSections`, and its shared vocabulary (`SettingsHeading`, `SettingsRow`, `SettingsNote` and the rest) is in `composites/settings-ui.tsx`. The rail is drawn in the file tree's system (`composites/tree.tsx`): sections are its headings, the open one marked by the tree's bar, and its headings hang beneath as jump links, the way to the last one jumped to lit. Each row names its layer (`vault` or `this machine`) and shows the resolver's warnings for its key. A write, or a change to either file on disk (the agent, a hand edit, a pull), refreshes the cached settings and the app follows: hooks are read on every commit, `colorScheme` and `editorFont` apply live. Each section links the files it is a view of. Appearance edits the theme tokens and Icons lists every icon entry, marking ones whose path is gone (see [file tree](file-tree.md)). Vault ends in Leave or delete for the open vault (see [vaults and sync](vaults-sync.md)).

**The ritual.** Creating a vault asks the four `askedAtBirth` settings in its settings act and the seed writes exactly those. Joining an existing vault asks nothing; its files already speak. See [onboarding](onboarding.md).

## Rules

- Data, never code: settings name which of Holi's behaviours apply and can never carry a script or a path to run.
- The committed file is untrusted input. Every value is validated on read and on write.
- A broken or missing settings file never stops a vault opening or a commit landing.
- Something about you on this machine (`colorScheme`) is written local, so a teammate's choice cannot flip your app.
- Not every setting is a birth question. A preference with a good default stays out of the ritual, and the seed never freezes an unasked value into a new vault.
- Adding a setting is adding one entry to `VAULT_SETTINGS`.

## Rejected

- A settings modal: it blocks the window while you compare a setting with the vault it applies to.
- JSONC or a `$schema` key: YAML is already the vault's idiom for what a person writes and costs no new dependency.
- Merging writes into the existing document: a comment inside a nested block does not survive, and a generated file stays complete as settings are added. The cost is that hand-written comments are not kept.
- Inferring daily notes from the GitHub collaborator count: a guess standing in for a question, paid for with a network call on every start.
- A list of Home targets: the strip's own insertion order would contradict it.
- Home and what a vault opens on as two settings: they answered the same question, and disagreed.

## Code

- `packages/shared/src/vault-settings.ts`: `VAULT_SETTINGS`, resolver, patch validator, ritual subset
- `packages/shared/src/settings-yaml.ts`: parse and generate the self-describing file
- `packages/shared/src/plugins.ts`: `PluginInfo` and `enabledPlugins`
- `apps/desktop/src/main/vault/settings.ts`: read and atomic write on disk
- `apps/desktop/src/main/router.ts` (`settings.read`, `settings.write`)
- `apps/desktop/src/renderer/src/features/settings/`: the tab, its sections and rows
- `apps/desktop/src/renderer/src/lib/home-target.ts`, `state/home.ts`: resolving and opening Home
