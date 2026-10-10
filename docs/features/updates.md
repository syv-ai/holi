# Updates

Holi updates itself. CI builds a signed, notarized macOS app from `main` and publishes it as a GitHub
release of `syv-ai/holi`; the installed app finds it there, downloads it in the background, and
installs it when Holi next quits. There is no update server: the release is the feed. A release's
newer skills and hooks are offered to each vault, never written unasked.

## How it works

**Shipping is bumping the version.** `.github/workflows/release.yml` runs on every push to `main`
and reads `apps/desktop/package.json`'s `version`. When `v<version>` has no tag yet, it builds,
packages with `electron-builder` (`apps/desktop/electron-builder.yml`), and publishes the release
`v<version>` with the dmg, the zip, their blockmaps and `latest-mac.yml`. When the tag exists, it
stops after that check, so an ordinary merge ships nothing. Only arm64 macOS is built.

**Signing and notarizing happen inside `electron-builder`.** It signs with the Developer ID
certificate in `CSC_LINK`/`CSC_KEY_PASSWORD` under the hardened runtime and
`build/entitlements.mac.plist`, then notarizes and staples the `.app` (from `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) before it makes the dmg and zip, so both carry a
stapled app. The workflow then checks `codesign`, `spctl` and `stapler`. The updater installs from
the zip, and macOS refuses an update that is not signed by the same team as the running app.

**The updater** is `electron-updater` in main (`src/main/updates/updater.ts`), on in the packaged
app only. It checks ten seconds after launch, every four hours, when the window gains focus and when
the machine wakes; `shouldCheck` (`src/main/updates/state.ts`) holds those to a five-minute
cooldown and never checks once an update is in hand. A found update downloads at once. The whole
status (version, state, progress, last check, last error) is pushed on `updates:status` on every
change and read through `trpc.updates.*`.

**Installing is a quit.** A downloaded update installs on any quit. **Restart to update** runs the
same path as ⌘Q first: the plugins' quit questions (a busy agent session asks), then the teardown
that flushes, commits and pushes the vault, and only then `quitAndInstall`. Declining the question
keeps Holi open and the update ready.

**Where you meet it.** The nav menu gains an update item only when there is something to do: in the
brand colour when an update is ready, with its panel's **Restart to update**, and in amber when a
download failed, with **Try again**. It stays until acted on; a toast would be missed. Settings →
**Updates** shows the running version, where the updater has got to, **Check now**, and **Update
automatically**, which turns the background checks off (stored in `userData/updates.json`). A
person's own check ignores the cooldown and the preference. Beside them, **Open at login**, this
machine's login item: Holi starts in the menu bar with its window loaded but out of sight, so the
vault opens and the [quick agent](quick-agent.md)'s keys work from the start.

**A release's skills reach a vault by asking.** Skills and hooks are the vault's once written, so an
app update leaves every vault's copies where they were ([agent config](agent-config.md)). Whenever a
vault opens, Holi asks, writing nothing, whether this release would bring it any (`skills.status`).
While it would, the nav's update item offers them, uncoloured, naming the files: **Update skills**
runs the ordinary update, conflicts and all, and **Not now** puts the offer off on this machine
until a later release changes what is pending (`localStorage`, never the vault). An app update
then reaches a vault's skills on the next open, with one click.

**Dev and installed are separate apps.** The packaged app is named Holi through
`extraMetadata.productName`, so its `userData` is `Holi/`, while `pnpm dev` keeps `@holi/desktop/`.
A dev build reports updates as unsupported.

## Rules

- A release is immutable: a new build is a new version. The workflow never replaces a release.
- An update is never installed behind someone's back mid-session; it waits for a quit or the button.
- A vault's files change only when its user asks: the skills offer writes nothing until Update
  skills is chosen, and is not an opt-in to update on open.
- Repository secrets the workflow needs: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. `GITHUB_TOKEN` publishes the release.

## Rejected

- A toast per found update: missed once, the update is missed, and each background check stacked
  another.
- Failing CI on a pull request that does not bump the version: most merges should not ship.
- A separate notarize step on the dmg after packaging: notarizing the app before packaging staples
  the app inside both the dmg and the zip, which the zip alone cannot be.

## Code

- `apps/desktop/src/main/updates/`: the state machine and the `electron-updater` wiring
- `apps/desktop/src/renderer/src/state/updates.ts`: the status mirror and its actions
- `apps/desktop/src/renderer/src/features/nav/UpdateItem.tsx`: the nav item, for the app and the
  vault's skills
- `apps/desktop/src/main/vault/seed/update.ts` (`pendingShipped`), `state/skills.ts`: the skills
  offer
- `apps/desktop/src/renderer/src/features/settings/UpdatesSection.tsx`: Settings → Updates
- `apps/desktop/electron-builder.yml`, `.github/workflows/release.yml`: packaging and release
