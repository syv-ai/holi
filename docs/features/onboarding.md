# Onboarding

A signed-in user with no vaults gets a full-screen ritual that ends in a vault: either a new
private GitHub repo under their account or an org, or an existing Holi vault a teammate has given
them push access to. The same ritual, minus the greeting, is how any later vault is added.

## How it works

- **The gate** is in `App.tsx`: no session yet shows nothing, no sign-in shows
  [sign-in](auth.md), then the vault list loads, and an empty list shows the ritual in
  `first-run` mode. Otherwise the shell renders.
- **Add-vault mode** opens from the vault dropdown's "Add vault…". It starts at act 2 and can be
  dismissed. If agent sessions are running, the vault-switch confirm asks first.
- **Five acts**, named in order in the reducer's `ACTS`, which everything that walks them (next,
  back, the floor, the step dots) reads:
  1. Greeting: what a vault is, plainly, with the plugins named as optional. First-run only.
  2. Naming: one name field, slugified live, and an owner picker listing your login and your
     orgs, defaulting to you. A caption shows `github.com/<owner>/<slug>`. Continue creates the
     repo: seeded, committed, pushed and tagged with the `holi-vault` topic before it returns.
  3. Plugins: "What this vault runs", a row per plugin in the build with its description and a
     switch at its own default. Turning one off says what that means in place. Only choosing
     happens here; setting a plugin up (connecting Google) is per machine and happens where it is
     used.
  4. Settings: the vault settings marked as asked at birth, each with its default already chosen,
     with only the commit transforms of core and of the plugins kept on, each plugin's tagged with
     its name. One note at the foot says where to change them later. The plugins answer and these
     are written into the new vault together on continue ([settings](settings.md)).
  5. Threshold: "Welcome to <slug>.", the copyable remote, a few hotkeys, and "Open vault", which
     activates the vault and flips the gate to the shell. The hotkeys are read off core's commands
     and the kept plugins', so a hint never names a key nothing binds.
- **Join** is a quiet link on act 2 that swaps in a searchable repo picker. It lists only repos
  with the `holi-vault` topic that are not already added. Repos you cannot push to are shown
  disabled, with the reason. Picking one clones it and opens it directly: no settings act and no
  threshold. The router also refuses a clone without the `.holi/vault` marker.
- **Keyboard**: space advances from the greeting, Enter runs the current act's primary action (the
  same one its footer button runs), Escape walks back and, in add-vault mode only, dismisses.
- **Errors stay in place.** A failed create or join shows GitHub's message on the form or picker
  it came from. A failed org list still offers your own account; a failed repo list says so
  inline and leaves create working.
- **Developer → Test onboarding**, in dev builds, walks the ritual over the open shell in a dry
  run that creates and writes nothing. A dry run is a second set of the ritual's actions
  (create, join, save, open), not a flag each handler checks.

## Rules

- The vault name is the repo name. The slug is what is submitted and what the app shows
  everywhere; there is no separate display name, which would diverge from the switcher.
- A team vault is an org-owned repo. There is no team concept beyond the owner picker.
- The new vault is activated at the threshold, not at creation, so it opens after its settings
  are written rather than on the seeded defaults.
- A plugin is written to the vault only when turned away from its default, so a vault that keeps
  the default follows it.
- Joining never asks the plugin or settings questions. An adopted vault's committed answers already speak,
  and overwriting a teammate's choice by cloning would be wrong.
- Holi sends no invitations. You join a repo you already have access to on GitHub.
- The ritual paints with Holi's theme tokens, not a palette of its own, so the first screen looks
  like the app it opens into. Its CSS (`onboarding-ritual.css`, `obrit-` prefixed) is global and
  the one place the spring easing is allowed: a one-time ceremony gets one spring, the daily app
  does not.

## Rejected

- A dialog or popover with a name field: the first vault is where the product explains what a
  vault is, and it is the one screen every user sees once.
- A separate add-vault popover beside the ritual: two ways to acquire a vault drift apart.
- A system-dependency check screen: users are developers and git is assumed; a clone failure
  surfaces inline.
- A product tour, checklist, sample content, or a way to replay onboarding.
- Setting plugins up during onboarding: choosing is per vault, setting up is per machine.
- Plugins as one row of the settings act: a plugin's own settings would show after it was turned
  off.
- A greeting that sells. It says what a vault is, plainly.
- An atmosphere of its own (film grain, vignette, a glow): the ritual is drawn on the app's
  surfaces, like the app it opens into.

## Code

- `apps/desktop/src/renderer/src/App.tsx`: the gate and the dry-run hook.
- `apps/desktop/src/renderer/src/features/onboarding/OnboardingRitual.tsx`: the frame and the flow;
  each act is its own component beside it (`GreetingAct`, `NamingAct` and `JoinPicker`,
  `PluginsAct`, `VaultSettingsAct`, `ThresholdAct`).
- `apps/desktop/src/renderer/src/features/onboarding/actions.ts`: what the ritual does to the world,
  real or dry.
- `PluginsAct.tsx`: act 3, from the installed plugins' `PluginInfo`.
- `VaultSettingsAct.tsx`: act 4, the descriptors
  asked at birth with the kept plugins' transforms.
- `apps/desktop/src/renderer/src/state/onboarding-flow.ts`: the reducer, slugify, act gating.
- `apps/desktop/src/renderer/src/state/vaults.ts`: `createVaultAtom`, `addVaultAtom`.
- `apps/desktop/src/main/github/api.ts`: repos, orgs, the `holi-vault` topic.
