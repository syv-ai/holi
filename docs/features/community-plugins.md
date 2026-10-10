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
  "opens": ["slides.md"],
  "setup": ["sh", "scripts/holi-setup.sh"],
  "serve": ["node", "bin/holi-serve.mjs", "{file}", "--port", "{port}"],
  "ignore": ["slides-export.pdf", "node_modules/"]
}
```

`opens` names files by exact name or `*.extension`, never a glob, since the file tree asks it of
every row. `setup` and `serve` are argv arrays, never shell strings, filled in with `{file}` (the
file's absolute path), `{vault}` and `{port}`. `serve` must pass `{port}` and listen on the
loopback there. `ignore` lines join the vault's `.gitignore` when the plugin is pinned: what the
server writes beside a file and must not sync. The grammar is `packages/shared/src/community-plugin.ts`.

**A release is a tag `v<version>`** whose manifest says that version. Installing clones it with system
git and the person's GitHub token, as a vault is cloned, so a private plugin repository installs for
whoever can read it. Settings offers a curated list (`plugins.json` in `syv-ai/holi-plugins`), any
`owner/repo`, and a local folder, used in place, for developing a plugin.

**Code lives on the machine, the pin in the vault.** An install is `userData/plugins/<id>/<commit>/`,
one per id, listed in `userData/plugins/installed.json`. A vault that uses a plugin commits its pin,
`.holi/plugins/<id>/manifest.json` (the manifest plus `repo` and `commit`), and turns it on with
`plugins: { community: true, <id>: true }` in `app.yaml`, beside the first-party plugins. A folder
install is never pinned.

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

**The vault notice.** A vault that turns on a plugin this machine cannot run says so under the file
tree, with the one next step (install the pinned version, or allow and set up).

## Rules

- No community plugin code loads into Holi's processes. Main spawns its commands, as it spawns
  `git`, `claude` and `typst`.
- Installing, consenting, setting up and serving open only the UI door: an app or the agent cannot
  ask for code to run.
- A server is stopped by group only while its pid still leads the group Holi started
  (`main/process-group.ts`): a reaped pid may already be someone else's.
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
- **Downloading release assets.** Needs a published artifact per release; a tag cloned with git
  needs nothing but the tag, and works for private repositories with the same token.

## Code

- `packages/shared/src/community-plugin.ts`: the manifest and pin grammar, `opensPath`,
  `pluginServerOrigin`.
- `apps/desktop/src/plugins/community/main/`: the install store, fetch, setup, consent, the
  supervisor and the `community.*` capabilities.
- `apps/desktop/src/plugins/community/renderer/`: the tab (`PluginFrame`), the settings section, the
  consent dialog and the vault notice.
- `apps/desktop/src/main/window-guard.ts`: `originFrameExit`.
