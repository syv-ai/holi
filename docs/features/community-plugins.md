# Community plugins

A community plugin is a plugin from another repository: a program Holi installs on this machine and
runs as its own process, which opens one kind of file in a tab by serving it from a local server.
Prezzi, Syv.ai's slide decks, is the first: a `slides.md` in a vault opens as the live deck, with
its visual editor saving back to the file. The `community` plugin hosts them, and is off by default;
with it off, no community plugin runs, as Obsidian's restricted mode.

## How it works

**A plugin is a repository with a `holi-plugin.json`** at its root:

```json
{
  "id": "prezzi",
  "name": "Prezzi",
  "version": "0.1.0",
  "folder": { "suffix": ".deck", "entry": "slides.md" },
  "setup": ["sh", "scripts/holi-setup.sh"],
  "serve": ["node", "bin/holi-serve.mjs", "{file}", "--port", "{port}"],
  "ignore": ["slides-export.pdf", "node_modules/"]
}
```

`opens` names files by exact name or `*.extension`, never a glob, since the file tree asks it of
every row. `folder` (`{ "suffix": ".deck", "entry": "slides.md" }`) opens folders instead, as a vault
app's `.app` is opened: a folder whose name ends in the suffix and holds the entry is one document
in the tree, named without its suffix, and opens in a tab, with its entry given to the server as
`{file}`. Its row menu opens the entry as text, and Show Files shows what is inside, where the entry
opens in the editor. A manifest gives `opens`, `folder` or both. `setup` and `serve` are argv arrays, never shell strings, filled in with `{file}` (the
file's absolute path), `{vault}` and `{port}`. `serve` must pass `{port}` and listen on the
loopback there. `ignore` lines join the vault's `.gitignore` when the plugin is pinned: what the
server writes beside a file and must not sync. The grammar is `packages/shared/src/community-plugin.ts`.

**A release is a tag `v<version>`** whose manifest says that version. Installing clones it with system
git and the person's GitHub token, as a vault is cloned, so a private plugin repository installs for
whoever can read it.

**Finding one.** A plugin's repository carries the GitHub topic `holi-plugin`, which is what makes it
findable. The settings field searches GitHub's repositories with that topic as you type (by name, or
within `owner/`), anyone's and the private ones the person can read, and reads each hit's manifest
and newest release: an installable plugin shows its name and version, anything else why it cannot
be installed (no release yet, an invalid manifest). An exact `owner/repo` is read even when search
does not find it, so a plugin without the topic still installs by name. A local folder, used in
place, is for developing a plugin.

**Code lives on the machine, the pin in the vault.** An install is `userData/plugins/<id>/<commit>/`,
one per id, listed in `userData/plugins/installed.json`. A vault that uses a plugin commits its pin,
`.holi/plugins/<id>/manifest.json` (the manifest plus `repo` and `commit`), and turns it on with
`plugins: { community: true, <id>: true }` in `app.yaml`, beside the first-party plugins. A folder
install is never pinned.

**Skills for the vault's agent.** A manifest's `skills` names folders in the plugin, each a Claude
Code skill (`SKILL.md` and what it references). Turning the plugin on in a vault copies each to
`.claude/skills/<folder name>/` (with the pin for a release, as it is for a folder install), and a
newer pin writes them again. Links inside a skill folder are followed when they stay inside the
plugin, so it can share references with its own repository's skills, and refused when they leave
it. `holi community path <id>` prints a running plugin's folder on this machine, so a skill can
run the plugin's own tools; it only reads, so it is allowed without asking.

**Nothing runs before consent.** A fetched release waits until the person allows that commit, in a
dialog naming the repository, version, commit and both commands. Consent is per `(id, commit)` in
`userData/plugin-consent.json`, with no expiry; a different commit asks again. Then setup runs once,
its output streamed into the dialog and kept in `setup.log`. A folder install asks nothing: it is
the person's own checkout.

**A row's status**, as settings and the vault notice show it: `not-installed` (pinned, absent here),
`pin-differs` (this machine has another release), `needs-consent`, `needs-setup`, `setup-failed`,
`ready`. A plugin is running where the vault turns it on and it is `ready`; only then does its claim
open its files.

**Opening a file starts its server.** The tab acquires the file's server and releases it when it
closes; tabs on one file share one server, and the last release stops it. Main picks a free port
from 3040 up, spawns `serve` in the plugin's folder as its own process group, on `toolPath()`, with
`HOLI_VAULT_ROOT`, `HOLI_FILE` and `HOLI_PORT`, and waits up to 60 seconds for the port to take a
connection on 127.0.0.1 or ::1. The tab shows the server's output while it starts, and the output
and Start again if it fails or stops. Leaving the vault and quitting stop every server.

**The frame** is `http://localhost:<port>/`, whichever loopback the server took (Vite takes ::1 on
macOS). While a server is up its origin is registered with the window guard: the frame may move
within it, and a link out of it opens in the browser.

**Updates.** Holi asks GitHub for each release-installed plugin's newest `v<semver>` tag when a
vault opens, hourly while it stays open, and freshly when the settings section opens (main caches
an answer for an hour per repository). A newer one is offered as **Update to <version>…** on the
plugin's settings row and as a line in the vault notice, and stays offered until it is done, as
Holi's own update offer does, rather than a toast that could be missed. Updating fetches the
release, asks in the consent dialog, sets it up and, where the vault pins the plugin, pins the new
release, so its members are offered it in turn.

**The vault notice.** A vault that turns on a plugin this machine cannot run says so under the file
tree, with the one next step (install the pinned version, or allow and set up).

## Rules

- No community plugin code loads into Holi's processes. Main spawns its commands, as it spawns
  `git`, `claude` and `typst`.
- Installing, consenting, setting up and serving open only the UI door: an app or the agent cannot
  ask for code to run.
- A server is stopped by group only while its pid still leads the group Holi started
  (`main/process-group.ts`): a reaped pid may already be someone else's.
- `serve` must be the server itself, not a launcher that exits and leaves it running. Holi signals
  the group only while the process it started still leads it, so a server whose leader has gone is
  not stopped.
- A tab releases its server by the lease its acquire returned, once that acquire has answered, so a
  release cannot overtake the acquire it undoes.
- The frame has `allow-same-origin`, unlike a vault app's. The loopback origin is never the
  renderer's, so it cannot reach Holi's document; a dev server's module scripts fail CORS from an
  opaque origin without it.
- A community plugin may not take a first-party plugin's id, or the vault's `plugins:` switch would
  turn both.
- Code never goes in the vault. A plugin's `node_modules` would be scanned by the watcher, and only
  the `.local.` marker keeps a file off the history.

## Rejected

- **Loading plugin JavaScript into main or the renderer.** A deck needs a Node server anyway, and a
  process boundary keeps plugin code out of the processes that hold the token and the vault.
- **Renderer-only third-party plugins in a vault-app sandbox.** Cannot run Slidev, or anything else
  that needs a build tool at runtime.
- **Committing plugin code into the vault, as Obsidian does.** Its `node_modules` and build output
  are far too large to sync.
- **A curated list, as Obsidian's `community-plugins.json`.** Someone has to accept each plugin
  before it can be found; the topic lets anyone publish one, and consent is the gate.
- **Code search for `holi-plugin.json`.** GitHub does not index a private repository promptly, so a
  team's own plugin would not be found.
- **Downloading release assets.** Needs a published artifact per release; a tag cloned with git
  needs nothing but the tag, and works for private repositories with the same token.

## Code

- `packages/shared/src/community-plugin.ts`: the manifest and pin grammar, `opensPath`,
  `pluginServerOrigin`.
- `apps/desktop/src/plugins/community/main/`: the install store, fetch, the topic search, setup,
  consent, the supervisor and the `community.*` capabilities.
- `apps/desktop/src/plugins/community/renderer/`: the tab (`PluginFrame`), the settings section, the
  consent dialog and the vault notice.
- `apps/desktop/src/main/window-guard.ts`: `originFrameExit`.
