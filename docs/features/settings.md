# Settings

A vault's settings are two YAML files it carries itself: `.holi/settings/app.yaml`, committed and shared with everyone who clones the vault, and `.holi/settings/app.local.yaml`, this machine's override. The settings tab edits them, the onboarding ritual asks a subset at a vault's birth, and the files explain themselves to whoever opens them, person or agent.

## How it works

**One declaration.** `VAULT_SETTINGS` in `@holi/shared` declares every setting once: key, label, explanation, type, default, target file, whether the ritual asks it, and which tab section shows it. The defaults, the reader, the write validator, the settings rows and the generated file are all derived from it. A setting's type carries both validation and the control's options, so a control cannot offer a value the validator refuses.

| Key                            | File      | Asked at birth | Default                      |
| ------------------------------ | --------- | -------------- | ---------------------------- |
| `dailyNotes`                   | committed | yes            | `true`                       |
| `home`                         | committed | yes            | `recents`                    |
| `hooks` (five transform flags) | committed | yes            | all on except `archive-done` |
| `maxCommittedFileBytes`        | committed | no             | 10 MB                        |
| `colorScheme`                  | local     | yes            | `system`                     |
| `editorFont`                   | committed | no             | `serif`                      |
| `plugins` (id to on or off)    | both      | no             | each plugin's own            |

`home` is Home: what the nav's Home and "Go home" go to, and what the vault opens on. One string: `recents` (what was opened recently, the default), `daily` (today's note, offered while `dailyNotes` is on), `board`, `agenda`, `mail`, or any app or file by its vault path. The recents and an app are shown in the Home tab; anything else opens as itself. A target that is not there (a deleted file or app, `daily` with `dailyNotes` off) opens the Home tab saying so, and a missing app can be created there with the default Home app. The row offers the fixed choices and the vault's shared apps, plus the current value when it is none of them; a personal `.local.` app is not offered, since the row writes the committed file. A personal Home is `home:` in `app.local.yaml`.

`plugins` says which plugins the vault runs. The committed file declares them, and the local file can only turn one off on this machine: a local `true` is dropped with a warning. A plugin the vault does not mention runs as its own default says. `enabledPlugins` resolves the set, in main and in the renderer alike. The committed file lists every plugin this build has, an unanswered one commented with its default; the local file shows the block only when it answers one. Unknown ids are kept and ignored. The settings tab shows a switch per installed plugin under General, which writes the committed file, and notes when this machine has a plugin off. A write that turns one on seeds its files and starts it at once; a hand edit is in force for the plugin's capabilities at once, and seeds and starts it at the vault's next open ([architecture](../architecture.md#plugins)).

**Reading.** `resolveVaultSettings` parses both files, applies the local one per key (the `hooks` block per flag, `plugins` as above), validates every field, and answers the default for anything absent or malformed with a warning. It never throws. It builds a fresh narrow value per key and never returns what it parsed. Unknown top-level keys are ignored without a warning, because the reminder watermark lives in the local file.

**Writing.** `settings.write` takes JSON strings and runs them through `parseSettingsPatch`, the same validator a teammate's committed file meets, so a write cannot add a key Holi does not own. Each file is merged and replaced with one atomic rename. `writeSettingsText` regenerates the whole document every time: a header saying which file this is, then every setting with its explanation and legal values above it. An unanswered setting is a commented-out line showing its default, so the default can still improve later. Unknown keys are kept under a trailing heading.

**The settings tab.** A singleton tab with a rail: General, Editor, Appearance, Icons, Commits, Connections, Vault, Account. The rail is drawn in the file tree's system (`composites/tree.tsx`): sections are its headings, the open one marked by the tree's bar, and its headings hang beneath as jump links, the way to the last one jumped to lit. Each row names its layer (`vault` or `this machine`) and shows the resolver's warnings for its key. A write, or a change to either file on disk (the agent, a hand edit, a pull), refreshes the cached settings and the app follows: hooks are read on every commit, `colorScheme` and `editorFont` apply live. Each section links the files it is a view of. Appearance edits the theme tokens and Icons lists every icon entry, marking ones whose path is gone (see [file tree](file-tree.md)). Vault ends in Leave or delete for the open vault (see [vaults and sync](vaults-sync.md)).

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
