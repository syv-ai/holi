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
  back, the floor, the stepper) reads. The stepper above the act counts only the acts that ask
  something (naming, plugins, settings: "Step 1 of 3"); on the greeting and the threshold it
  fades out but keeps its height. Every act stays mounted for the crossfade, and all but the
  current one are `inert`, so Tab and a stray press cannot reach another act's buttons:
  1. Greeting: what a vault is, plainly, with the plugins named as optional. First-run only.
  2. Naming: one name field, slugified live, and under it the repo's path,
     `github.com / <owner> / <slug>`, whose owner is a switcher listing your login and your orgs,
     defaulting to you: the owner is chosen where it shows, not in a second field restating the
     path. Left empty, the name is `holi-vault` (the field's placeholder, and the path says so),
     so the act never opens on a blank; a typed name that slugifies to nothing blocks instead.
     While a control or its menu has focus, Enter and Escape are that control's, never the
     act's. Under them, an optional "What is this vault for?" field: its answer becomes the
     README's paragraph and the repo's description on GitHub, on one line and cut at 300
     characters. Continue goes on to the questions; nothing exists on GitHub yet.
  3. Plugins: "What this vault runs", a card per plugin in the build, two to a row (`OptionCard`,
     after ReUI's `settings-1`): its mark (Claude, Google, a PDF page, Holi's own glyph for vault
     apps and community plugins), its description, an "Optional" badge on one that is off by
     default, and a checkbox at its own default. Turning one off says what that means in place; a plugin whose
     `requires` are off shows off, cannot be switched, and says what it needs. Only choosing
     happens here; setting a plugin up (connecting Google) is per machine and happens where it is
     used.
  4. Settings: the vault settings marked as asked at birth, a card each with its mark
     (`SettingCard`) and its default already chosen, with only the commit transforms of core and
     of the plugins kept on, each plugin's tagged with its name. One note at the foot says where
     to change them later. Its button is **Create vault**.
  5. Threshold. First the build: the repo is created (seeded, committed, pushed and tagged with
     the `holi-vault` topic), then the plugins and settings answers are written into it together
     ([settings](settings.md)), each step listed as it lands and held for a short beat so it reads
     as made rather than flashed. Then "Welcome to <slug>.", the copyable remote, a few hotkeys,
     and "Open vault", which
     activates the vault and flips the gate to the shell. The hotkeys are read off core's commands
     and the kept plugins', so a hint never names a key nothing binds; a command marks itself as one
     of these few (`Command.firstKey`, its place in the order).
- **Join** ("Join vaults in your accounts") is a quiet link on act 2 that swaps in a picker of
  every vault your accounts reach: your own, your organisations' and ones shared with you, from
  one GitHub listing, grouped by account. The search field carries an account selector (all
  accounts, or one) rather than a second control. It lists only repos with the `holi-vault` topic
  that are not already added; repos you cannot push to are shown disabled, as read-only. An empty
  list says which of three things is true: nothing matches the search, every vault is already
  added, or there are none, which names the topic and links GitHub's app approvals, since an
  organisation that has not approved Holi has its repos left out of the listing silently. The
  stepper steps aside while the picker is up. Picking one clones it and opens it directly: no
  settings act and no threshold. The router also refuses a clone without the `.holi/vault`
  marker.
- **Keyboard**: space advances from the greeting, Enter runs the current act's primary action (the
  same one its footer button runs), Escape walks back and, in add-vault mode only, dismisses.
- **Errors stay in place.** A failed join shows GitHub's message on the picker. A failed create
  goes back to naming with it, since the cause is nearly always the name (taken, or not allowed
  under that owner), keeping every other answer. Answers that could not be written are not fatal:
  the seed already holds every default. A failed org list still offers your own account; a failed repo list says so
  inline and leaves create working.
- **Developer → Test onboarding**, in dev builds, walks the ritual over the open shell in a dry
  run that creates and writes nothing. A dry run is a second set of the ritual's actions
  (create, join, save, open), not a flag each handler checks.

## Rules

- The vault name is the repo name. The slug is what is submitted and what the app shows
  everywhere; there is no separate display name, which would diverge from the switcher.
- A new vault gets a `README.md` in its first commit, from a plain template with no AI: the vault
  name as its heading, the answer to "What is this vault for?" as a paragraph (left out when
  blank), and a `## Folders` section to fill in. It is written beside the seed rather than in the
  once folder, because the seed takes no per-vault input, and never over a README already there.
  After that it is the vault's. The agent reads its top at every session start
  ([agent-memory](agent-memory.md)) and Home shows it ([home](home.md)). Joining a vault
  writes no README.
- A team vault is an org-owned repo. There is no team concept beyond the owner picker.
- Nothing is created until the last question is answered. Backing out of any act before
  "Create vault" leaves nothing on GitHub, and the answers land straight after the seed rather
  than over a repo someone could already have cloned.
- The new vault is activated at the threshold, not at creation, so it opens after its settings
  are written rather than on the seeded defaults.
- Opening the new vault also owes Claude Code its first run there (`state/claude-first-run.ts`).
  Each vault has its own Claude Code config directory, so a background session in a new one is
  refused as an untrusted workspace. Once the vault is open and its agent is running, the shell
  opens a terminal on `claude /login` in it as a tab: Claude Code shows its own trust prompt, then
  its login. Holi answers neither for the person. A colleague who cloned the vault, or anyone
  whose run was refused, starts the same thing from Settings → General → Claude Code, "Trust and
  sign in", or from a refused document run's "Trust in Claude Code".
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
- Creating the repo at the naming act: the later answers then had to be written over a vault that
  already existed, and dismissing halfway left a repo behind.
- A palette of its own: the ritual is drawn with the app's tokens and parts, and is the reference
  for new screens ([UI system](../ui-system.md), Page baseline). Its one atmosphere, the light
  from the top-left and the grain, is the app's ambient, shared with sign-in.

## Code

- `apps/desktop/src/renderer/src/App.tsx`: the gate and the dry-run hook.
- `apps/desktop/src/renderer/src/features/onboarding/onboarding-ritual.tsx`: the frame and the flow;
  each act is its own component beside it (`greeting-act.tsx`, `naming-act.tsx` and `join-picker.tsx`,
  `plugins-act.tsx`, `vault-settings-act.tsx`, `threshold-act.tsx`).
- `apps/desktop/src/renderer/src/features/onboarding/actions.ts`: what the ritual does to the world,
  real or dry.
- `plugins-act.tsx`: act 3, from the installed plugins' `PluginInfo`, each with its mark from
  `composites/marks.tsx`.
- `vault-settings-act.tsx`: act 4, the descriptors
  asked at birth with the kept plugins' transforms.
- `apps/desktop/src/renderer/src/state/onboarding-flow.ts`: the reducer, slugify, act gating.
- `apps/desktop/src/renderer/src/state/vaults.ts`: `createVaultAtom`, `addVaultAtom`.
- `apps/desktop/src/main/github/api.ts`: repos, orgs, the `holi-vault` topic.
- `apps/desktop/src/main/vault/readme.ts`: the new vault's README template, written by
  `vaults.create` in `router.ts`.
