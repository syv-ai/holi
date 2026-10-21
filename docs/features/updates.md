# Updates

Holi updates itself. CI builds a signed, notarized macOS app from `main` and publishes it as a GitHub
release of `syv-ai/holi`; the installed app finds it there, downloads it in the background, and
installs it when Holi next quits. There is no update server: the release is the feed, and its notes
are the release notes. A release's newer skills and hooks are offered to each vault, or brought in
on open by a vault that asks for that.

## How it works

**Shipping stable is bumping the version.** On each `main` push, `.github/workflows/release.yml`
checks the version in `apps/desktop/package.json`. If `v<version>` has no tag, it builds arm64
macOS with `electron-builder` (`apps/desktop/electron-builder.yml`) and publishes the dmg, zip,
blockmaps and `latest-mac.yml`. Existing tags skip stable publication; concurrent builds cannot
overwrite its assets. Every push keeps its own CI run.

**Signing and notarizing happen inside `electron-builder`.** It signs with the Developer ID
certificate in `CSC_LINK`/`CSC_KEY_PASSWORD` under the hardened runtime and
`build/entitlements.mac.plist`, then notarizes and staples the `.app` (from `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) before it makes the dmg and zip, so both carry a
stapled app. The workflow then checks `codesign`, `spctl` and `stapler`. The updater installs from
the zip, and macOS refuses an update that is not signed by the same team as the running app.

**The updater** is `electron-updater` in main (`src/main/updates/updater.ts`), for packaged apps
only. It checks ten seconds after launch, every four hours, on focus and on wake. `shouldCheck`
(`src/main/updates/state.ts`) enforces a five-minute cooldown and stops checks once an update is
held. electron-updater downloads it automatically; main pushes status through `updates:status` and
`trpc.updates.*`.

**Installing is a quit.** A downloaded update installs on any quit. **Restart to update** runs the
same path as ⌘Q first: the plugins' quit questions (a busy agent session asks), then the teardown
that flushes, commits and pushes the vault, and only then `quitAndInstall`. Declining the question
keeps Holi open and the update ready.

**Where you meet it.** The nav menu gains an update item only when there is something to do: in the
brand colour when an update is ready, with its panel's **Restart to update**, and in amber when a
download failed, with **Try again**. It stays until acted on; a toast would be missed. Settings →
**Updates** shows the running version, where the updater has got to, **Check now**, and **Update
automatically**, which turns the background checks off (stored in `userData/updates.json`). A
person's own check ignores the cooldown and the preference. **Dev prereleases** opts this app into
the development release channel. Switching channels immediately checks and downloads from the
selected feed. Turning dev off selects stable and downloads its latest release, even when that
version is older than the installed one; **Restart to update** installs the downloaded stable
version. **Release notes** are each release's GitHub notes, for the version found and the one
running, fetched from GitHub's releases API by tag (`v<version>`) when first shown
(`src/main/updates/release-notes.ts`, `trpc.updates.notes`). They are Markdown, shown as text with
headings and list items picked out, never as HTML, with a link to the release built from the tag; a
version with no release, such as a local build, has none. GitHub not answering (offline, rate
limited, down) is said as such and asked again on the next showing. Beside them, **Open at login**, this machine's login item: Holi starts in the menu bar
with its window loaded but out of sight, so the vault opens, syncs and fires its reminders from the
start.

**A release's skills reach a vault by asking.** Skills and hooks are the vault's once written, so an
app update leaves every vault's copies where they were ([agent config](agent-config.md)). Whenever a
vault opens, Holi asks, writing nothing, whether this release would bring it any (`skills.status`).
While it would, the nav's update item offers them, uncoloured, naming the files: **Update skills**
runs the ordinary update, conflicts and all, and **Not now** puts the offer off on this machine
until a later release changes what is pending (`localStorage`, never the vault). An app update
then reaches a vault's skills on the next open, with one click.

**A vault can take them on open.** `autoUpdateSkills` in `.holi/settings/app.yaml` (Settings →
Updates, **Update skills automatically**) is committed, so a team answers it once. When it is on,
main runs the update itself, in sequence: after the open is through (seeded, opened, its plugins
started) and after the vault's first pull has caught up with its remote, which the open asks for
then rather than waiting for a focus or the pull timer. A teammate may already have brought the
release in, and an update ahead of the pull would write it twice. It writes only what
`pendingShipped` reports, with the same rules for a file the vault edited; a file that differs
with no base on this machine is left alone rather than staged as a conflict nobody asked about. A
vault left before then is not touched, and one skills update runs at a time, asked for or not.
Main pushes what changed (`vault:skills`), and the nav's update item says it, naming the files,
until **Done** or the vault is left; the vault is not offered the update meanwhile. Unasked, it
starts no session: a conflict stays staged beside its file and the item offers **Merge with the
agent**, which starts the session Update skills would have. A failure is quiet.

**Which release a vault's skills are from.** The seed state (`seed-state.local.json`) records the
Holi version that last wrote shipped files on this machine, at creation, on a plugin's first
enabling, or by an update that brought something in and left no conflict. It is never lowered.
`skills.status` answers it with what is pending; the offer, Settings → Updates and
`holi skills status` say it. It is machine-local like the bases beside it: a
committed version would claim, on a teammate's machine, a write that never happened there.

**Dev and installed are separate apps.** The packaged app is named Holi through
`extraMetadata.productName`, so its `userData` is `Holi/`, while `pnpm dev` keeps `@holi/desktop/`.
A dev build reports updates as unsupported.

## Rules

- A stable release is immutable: a new build is a new version, and stable assets are never
  overwritten. The dev prerelease uses the CI run number in its version and bundle metadata;
  rerunning the same workflow run reuses that prerelease tag and deliberately replaces its assets.
- An update is never installed behind someone's back mid-session; it waits for a quit or the button.
- Stable is the default channel. Dev prereleases are an explicit per-app opt-in, and switching back to
  stable can install an older version on restart.
- A vault's files change only when someone asks: by default the skills offer writes nothing until
  Update skills is chosen. A vault can opt in to updating on open (`autoUpdateSkills`, committed);
  it is off by default, runs exactly the asked-for update, and never starts an agent session.
- Repository secrets the workflow needs: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. `GITHUB_TOKEN` publishes the release.

## Rejected

- A toast per found update: missed once, the update is missed, and each background check stacked
  another.
- Failing CI on a pull request that does not bump the version: most merges should not ship.
- Release notes from `electron-updater`: it has them only for the version it found, as HTML that
  would need sanitizing, and none for the running one.
- Starting the conflicts' agent session on an update run on open: a session nobody asked for, at
  the moment the vault is opening.
- The release a vault's skills came from in a committed file: it would claim, on a teammate's
  machine, a write Holi never made there.
- A separate notarize step on the dmg after packaging: notarizing the app before packaging staples
  the app inside both the dmg and the zip, which the zip alone cannot be.

## Code

- `apps/desktop/src/main/updates/`: the state machine, the `electron-updater` wiring and the
  release notes
- `apps/desktop/src/renderer/src/state/updates.ts`: the status mirror and its actions
- `apps/desktop/src/renderer/src/features/nav/UpdateItem.tsx`: the nav item, for the app and the
  vault's skills
- `apps/desktop/src/main/vault/seed/update.ts` (`pendingShipped`), `seed/state.ts` (`release`),
  `seed/update-on-open.ts`, `state/skills.ts`: the skills offer, the update on open and its notice
- `apps/desktop/src/renderer/src/features/settings/UpdatesSection.tsx`: Settings → Updates
- `apps/desktop/electron-builder.yml`, `.github/workflows/release.yml`: packaging and release
