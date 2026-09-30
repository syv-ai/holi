# Settings

A vault's settings are two YAML files it carries itself: `.holi/settings/app.yaml`, committed and shared with everyone who clones the vault, and `.holi/settings/app.local.yaml`, this machine's override. The settings tab edits them, the onboarding ritual asks a subset at a vault's birth, and the files explain themselves to whoever opens them, person or agent.

## How it works

**One declaration.** `VAULT_SETTINGS` in `@holi/shared` declares every setting once: key, label, explanation, type, default, target file, whether the ritual asks it, and which tab section shows it. The defaults, the reader, the write validator, the settings rows and the generated file are all derived from it. A setting's type carries both validation and the control's options, so a control cannot offer a value the validator refuses.

| Key                            | File      | Asked at birth | Default                      |
| ------------------------------ | --------- | -------------- | ---------------------------- |
| `dailyNotes`                   | committed | yes            | `true`                       |
| `landing`                      | committed | yes            | `{ kind: daily }`            |
| `home`                         | committed | no             | `Home.app`                   |
| `hooks` (five transform flags) | committed | yes            | all on except `archive-done` |
| `maxCommittedFileBytes`        | committed | no             | 10 MB                        |
| `colorScheme`                  | local     | yes            | `system`                     |
| `editorFont`                   | committed | no             | `serif`                      |

`landing` is one target: `daily`, `board`, `agenda`, `mail`, `{kind: note, path}` or `{kind: app, path}` (an app's bundle; an older `appId` reads as `<appId>.app`). The daily is named by kind, not by path, so it does not rot overnight. The ritual and the tab offer only the first four; a note or an app is a file edit. A target that no longer exists re-resolves as if `landing` were unset, which in a vault without daily notes is an empty pane.

`home` is the app the Home tab shows: any app bundle path, which may not exist yet ([vault apps](vault-apps.md)). Its row offers the vault's shared apps, plus the current value when it is none of them; a personal `.local.` app is not offered, since the row writes the committed file and teammates would be pointed at nothing. A personal home is `home:` in `app.local.yaml`.

**Reading.** `resolveVaultSettings` parses both files, applies the local one per key (the `hooks` block per flag), validates every field, and answers the default for anything absent or malformed with a warning. It never throws. It builds a fresh narrow value per key and never returns what it parsed. Unknown top-level keys are ignored without a warning, because the reminder watermark lives in the local file.

**Writing.** `settings.write` takes JSON strings and runs them through `parseSettingsPatch`, the same validator a teammate's committed file meets, so a write cannot add a key Holi does not own. Each file is merged and replaced with one atomic rename. `writeSettingsText` regenerates the whole document every time: a header saying which file this is, then every setting with its explanation and legal values above it. An unanswered setting is a commented-out line showing its default, so the default can still improve later. Unknown keys are kept under a trailing heading.

**The settings tab.** A singleton tab with a rail: General, Editor, Appearance, Icons, Commits, Connections, Vault, Account. The rail is drawn in the file tree's system (`composites/tree.tsx`): sections are its headings, the open one marked by the tree's bar, and its headings hang beneath as jump links, the way to the last one jumped to lit. Each row names its layer (`vault` or `this machine`) and shows the resolver's warnings for its key. A write, or a change to either file on disk (the agent, a hand edit, a pull), refreshes the cached settings and the app follows: hooks are read on every commit, `colorScheme` and `editorFont` apply live. `landing` says it takes effect next time the vault opens. Each section links the files it is a view of. Appearance edits the theme tokens and Icons lists every icon entry, marking ones whose path is gone (see [file tree](file-tree.md)). Vault ends in Leave or delete for the open vault (see [vaults and sync](vaults-sync.md)).

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
- A list of landing targets: the strip's own insertion order would contradict it.

## Code

- `packages/shared/src/vault-settings.ts`: `VAULT_SETTINGS`, resolver, patch validator, ritual subset
- `packages/shared/src/settings-yaml.ts`: parse and generate the self-describing file
- `apps/desktop/src/main/vault/settings.ts`: read and atomic write on disk
- `apps/desktop/src/main/vault/migrate-settings-format.ts`: converts older `.json` settings files to YAML on open
- `apps/desktop/src/main/router.ts` (`settings.read`, `settings.write`)
- `apps/desktop/src/renderer/src/features/settings/`: the tab, its sections and rows
- `apps/desktop/src/renderer/src/lib/landing-target.ts`, `state/landing.ts`: resolving and opening the landing target
