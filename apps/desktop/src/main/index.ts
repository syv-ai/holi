/**
 * The app: one window, one signed-in GitHub session, one open vault.
 *
 * Read the order in `whenReady` as a dependency chain — the session must exist
 * before the host, because the host hands git a closure over its token; the
 * host must exist before the router, because half the router is about the open
 * vault; and the window must exist before anything pushes to it.
 *
 * **Nothing here may import a module that no longer exists.** `electron-vite`
 * resolves imports even though it does not typecheck, so an unresolvable import
 * anywhere on this path is the one thing that stops a window opening at all.
 *
 * The agent is wired here: `createAgentManager` over the vault `host`, its
 * `agent-pty:*`/`agent:*` seam registered alongside the tRPC one. It sits after
 * the router because it shares the host, and before the window because its
 * `getWindow` closure reads `mainWindow` lazily.
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, type Tray } from 'electron'
import { requestFlush, type FlushChannel } from './flush'
import { guardNavigation } from './window-guard'
import { assetAbsPath, mimeFor } from './vault/asset-protocol'
import { appFileAbsPath, appHeadHtml, appMimeFor, injectAppHead, parseAppUrl } from './apps/app-protocol'
import { createSession } from './github/electron'
import { createGoogleAccountsManager } from './google/electron'
import { createCalendarPrefs } from './google/calendar-prefs'
import { createImagePrefs } from './google/image-prefs'
import { createSignatureStore } from './pdf/signatures'
import { pdfCommentsInVault } from './pdf/comments'
import { openGoogleCache } from './google/cache'
import { createGoogleData, type GoogleData } from './google/data'
import { createGoogleOpsServer } from './google/ops-server'
import { installGoogleCli } from './google/cli'
import { installHoliCli } from './agent/cli'
import { createAgentOps } from './agent/ops'
import { initAppOp, openAppOp } from './apps/app-ops'
import { refreshManaged } from './agent/seed-content'
import { runPreCommit } from './vault/hooks/runner'
import { stagedChanges } from './vault/hooks/staged'
import { readHookSettings, VAULT_TRANSFORMS } from './vault/hooks/transforms'
import { GoogleApi } from './google/api'
import { createEvent, deleteEvent, listAgenda, updateEvent } from './google/calendar'
import {
  createDraft,
  listThreads,
  readThread,
  replyToThread,
  sendDraft,
  sendMessage,
  textOnly,
} from './google/gmail'
import { registerIpc } from './ipc'
import { createRouter } from './router'
import { createVaultHost } from './vault/active-vault'
import { VaultRegistry, vaultRoot } from './vault/registry'
import { scanVault } from './vault/vault-store'
import { readVaultTheme } from './vault/theme'
import { createDeliveredLog, createReminderRuntime } from './reminders/runtime'
import { createNotifier } from './reminders/notify'
import type { VaultTasks } from './reminders/sweep'
import { createTray } from './tray'
import { installAppMenu } from './menu'
import {
  migrateSharedAgentConfig,
  resolveVaultAgentConfig,
} from './agent/agent-config-dir'
import { createAgentManager, type AgentManager } from './agent/agent-manager'
import { openTurnLog } from './agent/turn-log'
import { createHookServer } from './agent/hook-server'
import { createSessionRegistry } from './agent/session-registry'
import { ensureTypst, resolveTypstBin } from './pdf/typst-bin'
import { registerAgentIpc } from './agent-ipc'

// Declared before the launch check below, which starts `main()` synchronously:
// a `let` referenced from inside it while still in its temporal dead zone would
// throw during startup, which is the worst possible place for one.
let mainWindow: BrowserWindow | null = null

// Held at module scope, not inside `main()`: a `Tray` that gets garbage-collected
// vanishes from the menu bar, so it must outlive the setup closure.
let tray: Tray | null = null

/**
 * A second launch must not happen at all.
 *
 * `prd/vaults-sync.md` names the hazard as "the app opened twice would race on
 * commits" and asks for a lock on the clone — but one Holi process owns every
 * vault, so excluding a second *app* is exactly excluding a second writer on
 * every clone, and it covers vaults that are not even open, which a per-clone
 * lock could not. A lockfile would also need stale-lock handling, and getting
 * that wrong locks someone out of their own vault after a single crash.
 *
 * Must be claimed BEFORE `whenReady`.
 */
// Privileged custom scheme for vault binary assets (images). `standard` so URLs
// parse with a host + path; `secure`/`supportFetchAPI`/`stream` so <img> and
// fetch treat it like https and can stream large files. Must be declared before
// app-ready, so it lives at module top level, not in main().
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'holi-vault',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  // The vault-app scheme (D74). Same privileges, and `standard` is load-bearing
  // for a second reason here: it is what makes the URL's HOST parse as the app
  // id, which is how one app's frame is confined to one app's directory.
  {
    scheme: 'holi-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  // After the load, so the guard knows what "the app" is. A drop the renderer
  // does not claim is a navigation, and Electron answers a navigation with a
  // window — see window-guard.ts.
  guardNavigation(win, devUrl ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href)
  return win
}

async function main(): Promise<void> {
  app.on('second-instance', () => {
    // Someone tried to launch Holi again — show them the one they have.
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  await app.whenReady()

  // After whenReady: the keychain is not available before it.
  const session = await createSession()
  // The Google connector (D67) — independent of the GitHub session on purpose:
  // it is a data connector, not identity, and neither sign-out affects the other.
  const userDataDir = app.getPath('userData')
  // D87: the shared machine-wide cache belongs to an account no vault is pointed
  // at any more. Deleted rather than renamed: it holds one account's mail, and
  // leaving it on disk is worse than the re-fetch. A no-op on a fresh install.
  await rm(join(userDataDir, 'google-cache.db'), { force: true })
  const googleAccounts = await createGoogleAccountsManager()
  // One file, two readers: the agenda panel (via the router) and the agent (via
  // the ops server below). Plain JSON — it holds calendar ids, not a credential.
  const calendarPrefs = createCalendarPrefs(
    join(app.getPath('userData'), 'google-calendars.json'),
  )
  /**
   * Senders whose remote images always load.
   *
   * In `userData` beside the calendar choices, not in a vault: this is a
   * decision about the connected *account*, and a vault is a shared git repo —
   * pushing "this newsletter may be told the account holder read it" to
   * teammates is not a preference, it is a disclosure.
   */
  const imagePrefs = createImagePrefs(join(app.getPath('userData'), 'google-image-senders.json'))
  /** The PDF viewer's saved signatures: `userData` too, never a vault. */
  const signatures = createSignatureStore(join(app.getPath('userData'), 'pdf-signatures.json'))
  // Bound to the session's token *getter*, never a token: the getter refreshes
  // and single-flights, so every call goes through the one authority.
  /** The active vault's Google client (D87). Resolved inside the getter so the
   *  object cannot outlive a vault switch, and so a vault with no account fails
   *  at the point of use with a message naming the fix. */
  const googleApiFor = () =>
    new GoogleApi({
      accessToken: async () => {
        const remote = host.active()?.remote
        const session = remote === undefined ? null : await googleAccounts.sessionFor(remote)
        if (session === null) throw new Error('this vault has no Google account connected')
        return session.getAccessToken()
      },
    })

  /**
   * The UI's Google cache (D67, amended; D87). In `userData` rather than in a
   * vault: mail is **account** data, and a vault is a shared git repo — caching
   * a client's inbox there would push it to teammates on the next sync.
   *
   * **One file per account**, memoized. Accounts used to be kept apart by a wipe
   * inside `useAccount`, which was right for one connection that never changed;
   * per vault it fired on every switch and charged a full re-fetch of mail and
   * calendar — worst exactly where two vaults are used side by side, which is
   * the case D87 exists for.
   */
  const googleDataBySub = new Map<string, GoogleData>()
  const googleDataForSub = (sub: string): GoogleData => {
    let data = googleDataBySub.get(sub)
    if (data === undefined) {
      // `sub` becomes a filename. It is a numeric string from Google today, but
      // build a path out of it only after saying so.
      if (!/^[A-Za-z0-9_-]+$/.test(sub)) throw new Error(`unusable Google account id: ${sub}`)
      const cache = openGoogleCache(join(userDataDir, `google-cache-${sub}.db`))
      cache.ensureShape()
      data = createGoogleData({
        // Bound to THIS account's session, not to whatever vault is active —
        // the cache and the client it fills from have to be the same account.
        api: () =>
          new GoogleApi({
            accessToken: () => {
              const session = googleAccounts.sessionForSub(sub)
              if (session === null) throw new Error('that Google account is no longer connected')
              return session.getAccessToken()
            },
          }),
        cache,
      })
      googleDataBySub.set(sub, data)
    }
    return data
  }
  /** The active vault's data layer, or null when it has no account (D87). */
  const googleDataFor = async (remote: string): Promise<GoogleData | null> => {
    const sub = (await googleAccounts.sessionFor(remote))?.accountSub ?? null
    return sub === null ? null : googleDataForSub(sub)
  }

  /**
   * Keep the cache scoped to whoever is actually connected.
   *
   * Hung off `onChange` rather than off the disconnect procedure, because
   * `onChange` also fires for a **dead grant** — a revoked or expired
   * connection is just as much "this mail is no longer yours to hold" as a
   * button press, and wiring only the button would leave it behind.
   */
  /**
   * Keep a removed account's cache off the disk.
   *
   * Hung off `onChange` rather than off the disconnect procedure, because
   * `onChange` also fires for a **dead grant** — a revoked or expired connection
   * is just as much "this mail is no longer yours to hold" as a button press,
   * and wiring only the button would leave it behind. It now forgets the cache
   * of the account that changed rather than the only cache there was.
   */
  googleAccounts.onChange((sub) => {
    if (sub === null) return // a vault unlinked; the account and its cache live on
    if (googleAccounts.sessionForSub(sub) !== null) return // still connected
    googleDataBySub.get(sub)?.forget()
    googleDataBySub.delete(sub)
  })
  const registry = new VaultRegistry(join(app.getPath('userData'), 'vaults.json'))

  const send = (channel: string, payload: unknown) =>
    mainWindow?.webContents.send(channel, payload)

  const host = createVaultHost({
    registry,
    // A GETTER, not a string. Read lazily on every git operation, so a sign-out
    // takes effect on the next pull rather than the next restart.
    gitDeps: { token: () => session.token() },
    onSnapshot: (snapshot) => {
      send('vault:snapshot', snapshot)
      // A vault change is where synced agent-config can go stale under a live
      // session (`agent` is assigned below, long before any snapshot fires).
      void agent?.notifyVaultChanged()
    },
    onSyncState: (state) => send('vault:sync', state),
    // How the seeded pre-commit hook reaches us. A getter, read at open, so a
    // vault opened before the server bound still gets the live port.
    hookEndpoint: (remote) => {
      const port = hookServer.port()
      // This vault's standing token: it is written into that clone's
      // `.git/hooks`, so it must outlast any agent session and any switch.
      return port === null ? null : { port, token: hookServer.tokenForVault(remote) }
    },
    // The large-file gate's held-back set (empty clears the callout). Pushed
    // every commit tick and once at open, so a vault switch resets it.
    onHeldBack: (files) => send('vault:heldback', files),
    // A switch ends the vault's agent sessions, and this is the only place that
    // still holds the vault they ran in. The conversations stay reachable
    // through `claude --resume`.
    onLeave: async () => {
      await agent?.dispose().catch((err) => console.error('[vault] agent dispose failed:', err))
    },
  })

  // Serve `holi-vault://vault/<vaultRelPath>` from the active vault, read-only.
  // Resolving against the active vault (not a remote in the URL) is safe: there
  // is exactly one ActiveVault and a vault switch resets the workspace, so the
  // open note is always in the active vault.
  protocol.handle('holi-vault', async (request) => {
    const vault = host.active()
    if (vault === null) return new Response(null, { status: 404 })
    const abs = assetAbsPath(vault.root, request.url)
    if (abs === null) return new Response(null, { status: 403 })
    try {
      const bytes = await readFile(abs)
      return new Response(bytes, { headers: { 'content-type': mimeFor(abs) } })
    } catch {
      return new Response(null, { status: 404 })
    }
  })

  /**
   * A vault app, served from its own directory and its own origin (D74).
   *
   * The frame is `sandbox="allow-scripts"` with no `allow-same-origin`, so this
   * origin is opaque: an app cannot fetch `holi-vault://`, cannot touch the
   * renderer's DOM, and `localStorage` throws. Reaching the vault's content is
   * the bridge's job, and the bridge refuses the agent surface in `apps.*`.
   *
   * **No `Content-Security-Policy` header, deliberately.** Network is allowed
   * (vault-apps.md §Trust & isolation) — an app may `fetch` anywhere, which is
   * Nicolai's explicit choice and its cost is written down rather than hidden.
   * If a policy is ever added it must name `holi-app:` explicitly: `'self'`
   * matches NOTHING in an opaque origin, so `default-src 'self'` would block the
   * app's own `app.js` and read as a path bug rather than as a policy.
   */
  protocol.handle('holi-app', async (request) => {
    const vault = host.active()
    if (vault === null) return new Response(null, { status: 404 })
    const parsed = parseAppUrl(request.url)
    if (parsed === null) return new Response(null, { status: 400 })
    const abs = appFileAbsPath(vault.root, parsed.appId, parsed.rel)
    if (abs === null) return new Response(null, { status: 403 })

    // The entry document is the one file that is rewritten: it carries the
    // theme and the bridge. Everything else is served byte-for-byte.
    if (parsed.rel === 'index.html') {
      const html = await readFile(abs, 'utf8').catch(() => null)
      if (html === null) return new Response(null, { status: 404 })
      const theme = await readVaultTheme(vault.root)
      // Dark unless the document is in light mode — mirrors `state/theme.ts`'s
      // `activeMode`, which is dark-first because `data-theme` is unstamped.
      const block = theme.dark
      return new Response(injectAppHead(html, appHeadHtml(block)), {
        headers: { 'content-type': appMimeFor(abs) },
      })
    }

    try {
      const bytes = await readFile(abs)
      return new Response(bytes, { headers: { 'content-type': appMimeFor(abs) } })
    } catch {
      return new Response(null, { status: 404 })
    }
  })

  // Shared by the UI's Convert-to-PDF router and the agent's $TYPST_BIN.
  const typstCacheDir = join(app.getPath('userData'), 'typst')

  const router = createRouter({
    registry,
    session,
    googleAccounts,
    calendarPrefs,
    googleDataFor,
    imagePrefs,
    signatures,
    host,
    vaultRoot: vaultRoot(),
    openExternal: async (url) => {
      const { shell } = await import('electron')
      await shell.openExternal(url)
    },
    trashItem: async (path) => {
      const { shell } = await import('electron')
      await shell.trashItem(path)
    },
    downloadsDir: app.getPath('downloads'),
    typstCacheDir,
  })

  registerIpc({ router })

  // The vault agent: any number of live `claude` sessions (D100), all in the
  // active vault's clone, all ended when that vault closes.
  // `getWindow` is lazy — the window is created just below and is up long before
  // the agent streams anything, so registering the seam here is safe.
  //
  // Git coexistence: the hook server learns turn start/end from the agent's own
  // Claude Code hooks and drives the manager's pause/resume. The forward ref is
  // safe — its callbacks fire only at runtime, long after `agent` is assigned.
  let agent: AgentManager
  /**
   * The agent's door to Google (D67): a loopback server that serves calendar
   * and mail RESULTS, with main making the API calls using the token only it
   * holds. Plus the generated `holi-google` command the seeded skill invokes.
   *
   * This is why the pillar ships no MCP server — the agent reaches external
   * data with `Bash` and a documented command, like everything else.
   */
  /**
   * The agent's door to Google — **still not `googleData`, only more functions**
   * (D70).
   *
   * The reads are the raw fetchers, which take no cache and therefore cannot
   * read one. The agent asks for current data (D67, "Do not cache"), so that
   * exclusion is structural rather than a rule someone has to remember when
   * editing this file later.
   *
   * The **label writes go through `googleData`'s bound methods** — the same
   * functions the router calls. That is the opposite direction to the reads and
   * it is deliberate: a write the agent makes must land in the cache the UI
   * paints from, or Holi's own list keeps showing a thread the agent archived
   * until the next delta sync. Passing the four methods rather than the object
   * keeps D68 §6's structural exclusion intact — this server still cannot read
   * a cached anything.
   *
   * `send`/`draft`/`reply` and the calendar writes are raw functions, because
   * they have no cache entry to patch: a new message reaches the list through
   * the next `history.list` delta, and the agenda always refetches.
   */
  /**
   * The data layer for the vault whose bearer made the request (D87) — never
   * the active vault. An agent session outlives a vault switch, so resolving by
   * what is on screen would have a backgrounded agent write to another vault's
   * mailbox.
   */
  const agentGoogleData = async (remote: string): Promise<GoogleData> => {
    const data = await googleDataFor(remote)
    if (data === null) throw new Error('this vault has no Google account connected')
    return data
  }

  /** A Google client for one vault's account, for the raw (uncached) ops. */
  const agentGoogleApi = (remote: string): GoogleApi =>
    new GoogleApi({
      accessToken: async () => {
        const session = await googleAccounts.sessionFor(remote)
        if (session === null) throw new Error('this vault has no Google account connected')
        return session.getAccessToken()
      },
    })

  const googleOps = createGoogleOpsServer((remote) => ({
    // Through the SAME overrides file the panel writes. A calendar the user
    // switched off is not fetched for the agent either — otherwise "turn Jane's
    // calendar off" would hide her day from the panel while the agent kept
    // reading it, which is the opposite of what switching it off means.
    agenda: async (window) =>
      listAgenda(agentGoogleApi(remote), window, { overrides: await calendarPrefs.read() }),
    // The agent gets the list itself, not the page envelope: it asks a question
    // once and reads the answer, and `nextPageToken` is a UI affordance with
    // nothing to click on the other side of a shell command.
    threads: async (query) => (await listThreads(agentGoogleApi(remote), { query })).threads,
    // `textOnly` is the asymmetry, and it is deliberate: the UI renders
    // sanitized HTML, the agent gets prose. See `google/gmail.ts`.
    thread: async (id) => textOnly(await readThread(agentGoogleApi(remote), id)),

    // Label writes — through the vault's `GoogleData`, so the UI's cached list
    // learns about them at the same moment Gmail does.
    setRead: async (id, read) => (await agentGoogleData(remote)).setRead(id, read),
    star: async (id, on) => (await agentGoogleData(remote)).setStarred(id, on),
    archive: async (id) => (await agentGoogleData(remote)).archive(id),
    trash: async (id) => (await agentGoogleData(remote)).trash(id),

    // New messages and events — nothing cached to patch.
    draft: ({ threadId, ...mail }) => createDraft(agentGoogleApi(remote), mail, threadId),
    send: (input) =>
      'draftId' in input
        ? sendDraft(agentGoogleApi(remote), input.draftId)
        : sendMessage(agentGoogleApi(remote), input.mail),
    reply: (threadId, body, all) => replyToThread(agentGoogleApi(remote), threadId, body, { all }),
    schedule: (event) => createEvent(agentGoogleApi(remote), event),
    reschedule: (id, patch) => updateEvent(agentGoogleApi(remote), id, patch),
    unschedule: (id) => deleteEvent(agentGoogleApi(remote), id),
  }))
  await googleOps.start()
  const googleCliPath = await installGoogleCli(app.getPath('userData'))
  // Same bin directory, so one PATH prepend covers both. It also writes
  // `holi-statusline`, which is NOT found on PATH: Claude Code runs that command
  // in a shell of its own and the vault's config directory names it absolutely.
  const holiCliPath = await installHoliCli(app.getPath('userData'))

  /** Every ops route acts on the vault that is open right now. There is
   *  exactly one, and the agent's cwd IS its root, so taking a remote as an
   *  argument would only create a way for the two to disagree. */
  /**
   * The clone the caller's vault lives in.
   *
   * Resolved from the **caller's remote**, not from `host.active()`. The old
   * version took no argument and read whatever was on screen, on the reasoning
   * that there is exactly one vault open and the agent's cwd is its root. D87
   * found the premise false: an agent session outlives a vault switch, and a
   * `git commit` in one clone fires that clone's hook whatever Holi is showing.
   * The pre-commit transforms then ran against the wrong repository — a write,
   * not merely a wrong read.
   *
   * The registry is the source, so a vault that is not currently open still
   * resolves: its clone is on disk either way, and its git hook can fire.
   */
  const rootFor = async (remote: string): Promise<string | null> => {
    const active = host.active()
    if (active?.remote === remote) return active.root
    return (await registry.list()).find((e) => e.remote === remote)?.path ?? null
  }

  const hookServer = createHookServer({
    onTurnStart: (sessionId) => agent.setTurnActive(sessionId, true),
    onTurnEnd: (sessionId) => agent.setTurnActive(sessionId, false),
    // What a session's footer prints, and where Holi learns the name Claude
    // Code's own small-model pass wrote for it (D101).
    onStatus: (sessionId, status) => agent.noteStatus(sessionId, status),
    opsFor: (remote) =>
      createAgentOps({
      openApp: async (appId) => {
        const root = await rootFor(remote)
        if (root === null) return { ok: false, error: 'no vault is open' }
        const result = await openAppOp(root, appId)
        // The tab opens only once the app is known to be openable: a refusal
        // that still opened a tab would show the agent a blank frame and tell
        // it the reason at the same time.
        if (result.ok) send('apps:open', appId)
        return result
      },
      initApp: async (appId) => {
        const root = await rootFor(remote)
        if (root === null) return { ok: false, error: 'no vault is open' }
        return initAppOp(root, appId)
      },
      /**
       * Holi's own pre-commit hook, calling back in. The transforms run here
       * rather than in the shell script so they are TypeScript and tested; the
       * script is a curl and an `exit 0`.
       */
      runPreCommitHooks: async () => {
        const root = await rootFor(remote)
        if (root === null) return { changed: [], failed: [] }
        // No `notify` — Holi has no push seam into a live Claude Code session,
        // and typing into the agent's PTY is not one. The run log
        // (`.holi/state/hooks.local.log`) is the agent-readable surface, and it reads
        // it when asked. Tracked in not-built.md.
        const result = await runPreCommit(root, await stagedChanges(root), {
          settings: await readHookSettings(root),
          transforms: VAULT_TRANSFORMS,
        })
        return { changed: result.changed, failed: result.failed }
      },
      refreshSeed: async (input) => {
        const root = await rootFor(remote)
        if (root === null) {
          return { refreshed: [], skipped: [{ path: '', reason: 'no vault is open' }] }
        }
        return refreshManaged(root, input)
      },
      // `holi pdf comments` (D106): read-only, from the saved file.
      pdfComments: async (path) => {
        const root = await rootFor(remote)
        if (root === null) return { ok: false, error: 'no vault is open' }
        return pdfCommentsInVault(root, path)
      },
      }),
  })
  await hookServer.start()
  // D86: the vault agent runs on THIS VAULT's config directory, not the machine's
  // `~/.claude` and no longer one shared across every vault — `plugins/` and
  // user-scope `settings.json` are keyed by nothing, so sharing a directory
  // shared capability.
  //
  // The shared directory D72 left behind goes to the vault that actually ran the
  // agent in it — which the directory itself records, and which is NOT the same
  // as the most recently opened vault. Awaited before the manager exists, or a
  // fast first spawn provisions an empty directory beside the one being moved.
  // A fresh install has neither an old directory nor a registry entry, and both
  // halves no-op.
  const movedTo = await migrateSharedAgentConfig(userDataDir, await registry.list()).catch(
    (err) => {
      console.warn('[agent] config migration skipped:', err)
      return null
    },
  )
  if (movedTo) console.log(`[agent] shared config directory is now ${movedTo}'s`)
  agent = createAgentManager({
    host,
    // Per spawn, not per launch: the active vault moves under the manager, and
    // the theme stamped into that directory tracks a setting the user can flip
    // while the app runs. `nativeTheme` is read at spawn for the same reason.
    resolveConfigDir: ({ remote, root }) =>
      resolveVaultAgentConfig({
        userDataDir,
        remote,
        root,
        systemPrefersDark: nativeTheme.shouldUseDarkColors,
      }),
    getWindow: () => mainWindow,
    // What each turn changed, as a commit range, in the vault it ran in (D88).
    turnLogFor: openTurnLog,
    // Claude Code's own session listing (D100): what each session is doing and
    // what it is called, read from the CLI rather than derived from the PTY.
    sessionRegistry: createSessionRegistry(),
    hookPort: () => hookServer.port(),
    // The id is what a turn signal reports back, so the vault's several sessions
    // stay apart.
    mintHookToken: (remote, sessionId) => hookServer.mintSessionToken(remote, sessionId),
    revokeHookToken: (token) => hookServer.revoke(token),
    // $TYPST_BIN for the md-to-pdf skill: find-only for the env, download-warm
    // fire-and-forget so a machine that never rendered has typst next time.
    resolveTypstBin: () => resolveTypstBin({ cacheDir: typstCacheDir }),
    warmTypst: () => {
      void ensureTypst({ cacheDir: typstCacheDir })
    },
    googlePort: () => googleOps.port(),
    mintGoogleToken: (remote) => googleOps.mintToken(remote),
    revokeGoogleToken: (token) => googleOps.revoke(token),
    googleBin: () => googleCliPath,
    holiBin: () => holiCliPath,
    binDir: () => dirname(googleCliPath),
  })
  registerAgentIpc({ agent })

  /**
   * Reminders: a tray-resident evaluator sweeps every registered vault each
   * minute (and once at launch — the launch run is the catch-up for fires missed
   * while quit) and raises native notifications.
   *
   * `clonePaths` is refreshed at the head of every `corpus.all()`, before `sweep`
   * reads or the runtime marks the watermark, so the sync `DeliveredLog` resolver
   * always sees the same clones the sweep just scanned. A vault whose `scanVault`
   * throws (a stale registry entry, a missing clone) is skipped, never a stall.
   */
  const clonePaths = new Map<string, string>()
  const corpus = {
    async all(): Promise<VaultTasks[]> {
      const entries = await registry.list()
      clonePaths.clear()
      for (const e of entries) clonePaths.set(e.remote, e.path)
      const scans = await Promise.all(
        entries.map(async (e) => {
          const snap = await scanVault(e.path).catch(() => null)
          return snap ? { remote: e.remote, tasks: snap.tasks } : null
        }),
      )
      return scans.filter((v): v is VaultTasks => v !== null)
    },
  }
  const delivered = createDeliveredLog((remote) => clonePaths.get(remote) ?? null)
  /**
   * A clicked reminder brings the window forward and hands the task to the
   * renderer, which owns the vault switch (so `activeRemoteAtom` stays truthful).
   * The window may be gone entirely — closed on macOS, or tray-resident once
   * keep-alive lands — so recreate it and deliver on `did-finish-load`, or the
   * push arrives before any renderer can hear it.
   */
  const focusTask = (remote: string, path: string): void => {
    const payload = { remote, path }
    const win = mainWindow
    if (win === null || win.isDestroyed()) {
      const fresh = createWindow()
      fresh.on('focus', () => host.active()?.onFocus())
      fresh.webContents.once('did-finish-load', () =>
        fresh.webContents.send('reminders:open', payload),
      )
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('reminders:open', payload)
  }
  const notifier = createNotifier((remote, path) => focusTask(remote, path))
  const reminders = createReminderRuntime({ corpus, notifier, delivered })
  reminders.start()

  const win = createWindow()
  // FR-9: pull on focus. The interval exists for the case where the window
  // never loses focus at all.
  win.on('focus', () => host.active()?.onFocus())

  // Create-or-focus the one window — the dock/`activate` path and the tray's
  // Open Holi both funnel through here, so keep-alive has a single way back in.
  const openWindow = (): void => {
    const existing = mainWindow
    if (existing !== null && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }
    const fresh = createWindow()
    fresh.on('focus', () => host.active()?.onFocus())
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })

  // Tray-resident: the sweep keeps running with the window closed, and the tray
  // is the way back in (Open Holi) and the way out (Quit — ⌘W no longer is one).
  tray = createTray({ openWindow })
  // After the first window: the Developer menu sends to whatever window is
  // current, and there has to be one for the send to land.
  installAppMenu(() => mainWindow)

  /**
   * First-run only: ask once whether to launch Holi at login — reminders fire
   * only while it is running. The answer is applied via `setLoginItemSettings`;
   * the "asked" flag lives in userData (never a vault, never committed), so a
   * later launch never re-asks, whatever the answer was. Fire-and-forget so the
   * modal does not hold up the rest of startup. (A settings toggle to change the
   * choice later is out of scope — a follow-up.)
   */
  const appSettingsFile = join(app.getPath('userData'), 'settings.json')
  void (async () => {
    let settings: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(await readFile(appSettingsFile, 'utf8'))
      if (parsed && typeof parsed === 'object') settings = parsed as Record<string, unknown>
    } catch {
      settings = {}
    }
    if (settings['launchPrompted'] === true) return
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Enable', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      message: 'Launch Holi at login?',
      detail: 'Reminders only fire while Holi is running. Launch it automatically when you log in?',
    })
    app.setLoginItemSettings({ openAtLogin: response === 0 })
    try {
      await writeFile(
        appSettingsFile,
        JSON.stringify({ ...settings, launchPrompted: true }, null, 2) + '\n',
        'utf8',
      )
    } catch (err) {
      console.error('[login-prompt] failed to persist the asked flag:', err)
    }
  })()

  /**
   * Quit has to WAIT for the flush.
   *
   * `before-quit` is synchronous: fire the teardown unawaited and the app can
   * exit before it finishes, losing whatever the commit debounce was still
   * holding — which is precisely the edit the user just made. So veto the first
   * quit, flush, then quit for real. `quitting` makes the second pass fall
   * through, or this vetoes forever.
   */
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    reminders.close() // stop the sweep timer at once — no tick into a teardown
    tray?.destroy() // let go of the menu-bar item as we leave
    tray = null
    void (async () => {
      try {
        // Kill the agent's PTY (and its process group) before we flush and
        // commit — nothing the session was mid-writing should race the teardown.
        await agent.dispose().catch((err) => console.error('[quit] agent dispose failed:', err))
        await hookServer.stop().catch((err) => console.error('[quit] hook server stop failed:', err))
        // FR-6's flush points are a flush THEN a commit, and only the renderer
        // can do the first half — `host.close()` commits what is on disk, and
        // the editor's newest words are not there until it writes them. Every
        // other flush point is renderer-initiated; quit is the one main starts,
        // so it is the one that has to ask.
        await requestFlush(flushChannel(mainWindow))
        // Quit is a leave point (D61): commit the flushed buffer, then get it
        // off-machine before the window closes. Best-effort with a 1s budget —
        // `pushNow` never rejects, and an unreachable remote must not hang quit;
        // the work is committed on disk, and the next launch drains what did not
        // make it out. Order is flush -> commit -> push -> close.
        const vault = host.active()
        if (vault !== null) {
          await vault.commitNow().catch((err) => console.error('[quit] commit failed:', err))
          await Promise.race([vault.pushNow(), new Promise((r) => setTimeout(r, 1_000))])
        }
        // `close()` commits the open vault again (a clean no-op) before letting
        // go of it (FR-6).
        await host.close()
      } catch (err) {
        console.error('[quit] teardown failed:', err)
      } finally {
        // Always quit, even if the flush threw — a failed teardown must not
        // trap someone in an app they are trying to leave.
        app.quit()
      }
    })()
  })
}

/**
 * `requestFlush`'s channel, over the one window.
 *
 * A window that is gone or destroyed has no buffer left to lose, so it answers
 * at once rather than making the quit sit out the full timeout for a renderer
 * that cannot possibly reply.
 */
function flushChannel(win: BrowserWindow | null): FlushChannel {
  const target = win !== null && !win.isDestroyed() ? win : null
  return {
    send() {
      target?.webContents.send('vault:flush')
    },
    onDone(cb) {
      if (target === null) {
        queueMicrotask(cb)
        return () => {}
      }
      ipcMain.once('vault:flush-done', cb)
      return () => ipcMain.removeListener('vault:flush-done', cb)
    },
  }
}

// Keep-alive on every platform: closing the last window no longer quits, so the
// reminder sweep keeps running tray-resident (macOS already behaved this way).
// A real quit is the tray's Quit or ⌘Q → `before-quit`. The handler must stay
// registered and empty — with none, Electron's default quits on Windows/Linux.
app.on('window-all-closed', () => {
  // intentionally does not quit
})
