/**
 * The app: one window, one signed-in GitHub session, one open vault.
 *
 * Read the order in `whenReady` as a dependency chain: the session before the
 * host (the host hands git a closure over its token), the host before the
 * router, and the window before anything pushes to it.
 *
 * `electron-vite` resolves imports without typechecking, so an unresolvable
 * import anywhere on this path stops the window opening at all.
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  Notification,
  protocol,
  session as electronSession,
  shell,
  type Tray,
} from 'electron'
import { requestFlush, type FlushChannel } from './flush'
import { guardNavigation } from './window-guard'
import { assetAbsPath, mimeFor } from './vault/asset-protocol'
import {
  appHeadHtml,
  appMimeFor,
  injectAppHead,
  parseAppUrl,
  servableAppFile,
} from './apps/app-protocol'
import { createSession } from './github/electron'
import { createMembersCache } from './github/members-cache'
import { createGoogleAccountsManager } from './google/electron'
import { createCalendarPrefs } from './google/calendar-prefs'
import { createImagePrefs } from './google/image-prefs'
import { openGoogleCache } from './google/cache'
import { createGoogleData, type GoogleData } from './google/data'
import { installHoliCli } from './bridge/cli'
import type { MainAppMethod } from '@holi/shared'
import { appCapabilities, APP_NAMESPACES } from './apps/capabilities'
import { agentCapabilities, AGENT_NAMESPACES } from './agent/capabilities'
import { createCapabilityHost } from './capabilities/dispatch'
import { CapabilityError } from './capabilities/error'
import { createCapabilityRegistry } from './capabilities/registry'
import { vaultCapabilities, VAULT_NAMESPACES } from './capabilities/vault-caps'
import { googleCapabilities, GOOGLE_NAMESPACES } from './google/capabilities'
import { taskCapabilities, TASK_NAMESPACES } from './vault/task-capabilities'
import { agentSeed } from './agent/seed/seed'
import { coreSeed } from './vault/seed/core'
import { MAIN_PLUGINS } from '../plugins/main'
import { install } from './plugin-host/installed'
import { createPluginHost } from './plugin-host/host'
import {
  describeUpdate,
  updateConflictPrompt,
  updateShipped,
  type SkillsUpdate,
} from './vault/seed/update'
import { registerGitRoutes } from './vault/git-routes'
import { GoogleApi } from './google/api'
import { registerIpc } from './ipc'
import { createRouter, localToday } from './router'
import { admitApps, createAppGrants } from './apps/app-grants'
import { createCoreServices, createUiReports } from './capabilities/services'
import { createVaultHost } from './vault/active-vault'
import { VaultRegistry, vaultRoot } from './vault/registry'
import { scanVault } from './vault/vault-store'
import { readVaultTheme } from './vault/theme'
import { createDeliveredLog, createReminderRuntime } from './reminders/runtime'
import { createNotifier } from './reminders/notify'
import type { VaultTasks } from './reminders/sweep'
import { createTray } from './tray'
import { installAppMenu } from './menu'
import { resolveVaultAgentConfig, takeFirstSpawn } from './agent/agent-config-dir'
import { createAgentSessions, type AgentSessions } from './agent/agent-sessions'
import { createAgentTerminals } from './agent/agent-terminals'
import { createClaudeCli } from './agent/claude-cli'
import { openTurnLog } from './agent/turn-log'
import { createBridgeEnv } from './bridge/env-file'
import { createBridgeServer } from './bridge/server'
import { registerAgentRoutes } from './agent/bridge-routes'
import { registerAgentIpc } from './agent-ipc'

// The plugins this build has: the one place main imports them.
install(MAIN_PLUGINS)

/** What seeds every vault, core first: its `.gitignore` is written before
 *  any file that could be committed. Enabled plugins' seeds follow. */
const CORE_SEEDS = [coreSeed(MAIN_PLUGINS.map((p) => p.info)), agentSeed]

// Declared before the launch check below, which starts `main()` synchronously:
// a `let` still in its temporal dead zone would throw during startup.
let mainWindow: BrowserWindow | null = null

// Held at module scope, not inside `main()`: a `Tray` that gets garbage-collected
// vanishes from the menu bar, so it must outlive the setup closure.
let tray: Tray | null = null

// Privileged custom scheme for vault binary assets (images). `standard` so URLs
// parse with a host + path; `secure`/`supportFetchAPI`/`stream` so <img> and
// fetch treat it like https and can stream large files. Must be declared before
// app-ready, so it lives at module top level, not in main().
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'holi-vault',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  // The vault-app scheme. Same privileges, and `standard` is load-bearing
  // for a second reason here: it is what makes the URL's HOST parse as the app
  // id, which is how one app's frame is confined to one app's directory.
  {
    scheme: 'holi-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

// A second launch must not happen at all: one Holi process owns every vault,
// so excluding a second app excludes a second writer on every clone, without a
// per-clone lockfile's stale-lock handling. Must be claimed BEFORE `whenReady`.
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
  guardNavigation(
    win,
    devUrl ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href,
    (url) => {
      void shell.openExternal(url)
    },
  )
  return win
}

async function main(): Promise<void> {
  app.on('second-instance', () => {
    // Someone tried to launch Holi again: show them the one they have.
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  await app.whenReady()

  // After whenReady: the keychain is not available before it.
  const session = await createSession()
  // The Google connector is independent of the GitHub session on purpose:
  // it is a data connector, not identity, and neither sign-out affects the other.
  const userDataDir = app.getPath('userData')
  // A machine-wide cache left from before per-account caches. Deleted
  // rather than renamed: it holds one account's mail.
  await rm(join(userDataDir, 'google-cache.db'), { force: true })
  const googleAccounts = await createGoogleAccountsManager()
  // One file, every reader: the agenda view, an app and the agent all read
  // their agenda through it. Plain JSON: it holds calendar ids, not a credential.
  const calendarPrefs = createCalendarPrefs(join(app.getPath('userData'), 'google-calendars.json'))
  /**
   * Senders whose remote images always load.
   *
   * In `userData`, not in a vault: this is a decision about the connected
   * *account*, and a vault is a shared git repo. Pushing it to teammates would
   * be a disclosure, not a preference.
   */
  const imagePrefs = createImagePrefs(join(app.getPath('userData'), 'google-image-senders.json'))
  /**
   * The UI's Google cache. In `userData` rather than in a vault: mail
   * is **account** data, and a vault is a shared git repo.
   *
   * **One file per account**, memoized, so switching between two vaults does
   * not re-fetch mail and calendar.
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
        // Bound to THIS account's session, not to whatever vault is active:
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
  /** The active vault's data layer, or null when it has no account. */
  const googleDataFor = async (remote: string): Promise<GoogleData | null> => {
    const sub = (await googleAccounts.sessionFor(remote))?.accountSub ?? null
    return sub === null ? null : googleDataForSub(sub)
  }

  /**
   * Keep a removed account's cache off the disk.
   *
   * Hung off `onChange` rather than off the disconnect procedure, because
   * `onChange` also fires for a **dead grant**: a revoked or expired connection
   * is just as much "this mail is no longer yours to hold" as a button press.
   */
  googleAccounts.onChange((sub) => {
    if (sub === null) return // a vault unlinked; the account and its cache live on
    if (googleAccounts.sessionForSub(sub) !== null) return // still connected
    googleDataBySub.get(sub)?.forget()
    googleDataBySub.delete(sub)
  })
  const registry = new VaultRegistry(join(app.getPath('userData'), 'vaults.json'))

  const send = (channel: string, payload: unknown) => mainWindow?.webContents.send(channel, payload)

  const bridgeEnv = createBridgeEnv()
  /** remote → the undo of what the open vault's env file carries. */
  const vaultEnv = new Map<string, () => void>()
  /**
   * What an open vault's `bridge.local.env` carries: the bridge's port and
   * the vault's standing token (the same one git's hooks in the clone use).
   * Called at open; `bridge` exists long before any vault can open.
   */
  const contributeVaultEnv = (remote: string): (() => void) => {
    const undo: Array<() => void> = []
    const bridgePort = bridge.port()
    if (bridgePort !== null) {
      undo.push(
        bridgeEnv.contribute(remote, {
          HOLI_BRIDGE_PORT: String(bridgePort),
          HOLI_BRIDGE_TOKEN: bridge.tokenForVault(remote),
        }),
      )
    }
    return () => undo.forEach((u) => u())
  }

  // Every capability, from every door. Created ahead of the vault host so
  // the plugin host can register into it; `host` is read lazily.
  const capabilities = createCapabilityRegistry()
  const plugins = createPluginHost({
    plugins: MAIN_PLUGINS,
    registry: capabilities,
    userData: userDataDir,
    coreSeeds: CORE_SEEDS,
    liveRoot: () => host.active()?.root ?? null,
  })

  const host = createVaultHost({
    registry,
    // A GETTER, not a string. Read lazily on every git operation, so a sign-out
    // takes effect on the next pull rather than the next restart.
    gitDeps: { token: () => session.token() },
    onSnapshot: (snapshot) => {
      send('vault:snapshot', snapshot)
      // A hand edit to the settings files arrives this way too.
      plugins.invalidate()
      // A snapshot is also how main learns a vault opened: attach the assistant
      // to it (a no-op for the vault it is already on). `agent` is assigned
      // below, long before any snapshot fires.
      void agent?.ensure()
    },
    onSyncState: (state) => send('vault:sync', state),
    // How everything inside the vault reaches us: its `bridge.local.env`,
    // with what each part of Holi contributes while the vault is open. Made
    // at open, so the file names this run's ports, which move on restart.
    bridgeEnv: {
      attach: async (remote, root) => {
        vaultEnv.get(remote)?.()
        vaultEnv.set(remote, contributeVaultEnv(remote))
        await bridgeEnv.attach(remote, root)
      },
      detach: async (remote) => {
        vaultEnv.get(remote)?.()
        vaultEnv.delete(remote)
        await bridgeEnv.detach(remote)
      },
    },
    // The large-file gate's held-back set (empty clears the callout). Pushed
    // every commit tick and once at open, so a vault switch resets it.
    onHeldBack: (files) => send('vault:heldback', files),
    onCommitted: (paths) => send('vault:committed', paths),
    // A switch stops the vault's sessions (the renderer asked first if
    // one was busy), and this is the only place that still holds the vault
    // they ran in. They stay in Claude Code's agent list and resume when opened.
    onLeave: async () => {
      await agent?.leave().catch((err) => console.error('[vault] agent leave failed:', err))
      plugins.leave()
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
   * A vault app, served from its own directory and its own origin.
   *
   * The frame is `sandbox="allow-scripts"` with no `allow-same-origin`, so this
   * origin is opaque: an app cannot fetch `holi-vault://`, cannot touch the
   * renderer's DOM, and `localStorage` throws. Reaching the vault's content is
   * the bridge's job, and the bridge refuses the agent surface in `apps.*`.
   *
   * **No `Content-Security-Policy` header, deliberately.** Network is allowed
   * (`docs/features/vault-apps.md`): an app may `fetch` anywhere. If a policy is
   * ever added it must name `holi-app:` explicitly: `'self'` matches NOTHING in
   * an opaque origin, so `default-src 'self'` would block the app's own `app.js`
   * and read as a path bug rather than as a policy.
   */
  protocol.handle('holi-app', async (request) => {
    const vault = host.active()
    if (vault === null) return new Response(null, { status: 404 })
    const parsed = parseAppUrl(request.url)
    if (parsed === null) return new Response(null, { status: 400 })
    const abs = await servableAppFile(vault.root, parsed.bundle, parsed.rel)
    if (abs === null) return new Response(null, { status: 403 })

    // The entry document is the one file that is rewritten: it carries the
    // theme and the bridge. Everything else is served byte-for-byte.
    if (parsed.rel === 'index.html') {
      const html = await readFile(abs, 'utf8').catch(() => null)
      if (html === null) return new Response(null, { status: 404 })
      const theme = await readVaultTheme(vault.root)
      // The renderer's mode rides in on the URL (`?mode=`).
      const block = theme[parsed.mode]
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

  // What the renderer reports the person is looking at, and their approvals
  // of apps' Google reads: capabilities and the router both read these.
  const uiReports = createUiReports()
  const appGrants = createAppGrants(join(app.getPath('userData'), 'app-grants.json'))

  /**
   * Geolocation is refused outright. Electron answers it through Google's
   * network location service, which needs an API key and does not answer on
   * macOS, so a request would hang until the page's timeout. Refused, it fails
   * at once and an app can offer a place search instead. Every other
   * permission keeps Electron's answer.
   */
  electronSession.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission !== 'geolocation')
  })
  // Settings' member list reads the same cache as an app and the agent.
  const members = createMembersCache((remote) => session.api.collaborators(remote))
  /**
   * The clone the caller's vault lives in.
   *
   * Resolved from the **caller's remote**, not from `host.active()`: an
   * agent session outlives a vault switch, and a `git commit` in one clone fires
   * that clone's hook whatever Holi is showing. Resolving by what is on screen
   * would run the pre-commit transforms against the wrong repository.
   *
   * The registry is the source, so a vault that is not currently open still
   * resolves: its clone is on disk either way, and its git hook can fire.
   */
  const rootFor = async (remote: string): Promise<string | null> => {
    const active = host.active()
    if (active?.remote === remote) return active.root
    return (await registry.list()).find((e) => e.remote === remote)?.path ?? null
  }

  // What a vault app and the agent can ask for: core's capabilities, then
  // each feature's, under the namespaces each owns. A feature's table closes
  // over what it needs from the running app.
  const vaultCaps = vaultCapabilities({
    updateSkills: async (remote) => {
      const result = await updateSkills(remote)
      if (!result.ok) throw new CapabilityError('UNAVAILABLE', result.message)
      return result.summary
    },
  })
  // The agent's `holi apps open`: the renderer opens the tab.
  const appCaps = appCapabilities({ showApp: (bundle) => send('apps:open', bundle) })
  const taskCaps = taskCapabilities({ today: localToday })
  const agentCaps = agentCapabilities({
    // `agent` is assigned below, before any vault can be open.
    sessionsFor: (remote) => (host.active()?.remote === remote ? (agent?.sessions() ?? []) : []),
  })
  const googleCaps = googleCapabilities({
    accounts: googleAccounts,
    dataFor: googleDataFor,
    calendarPrefs,
    imagePrefs,
  })
  capabilities.register(VAULT_NAMESPACES, vaultCaps)
  capabilities.register(APP_NAMESPACES, appCaps)
  capabilities.register(TASK_NAMESPACES, taskCaps)
  capabilities.register(AGENT_NAMESPACES, agentCaps)
  capabilities.register(GOOGLE_NAMESPACES, googleCaps)
  // Every method the frame's bridge may call and main answers is registered
  // above: leaving one out is a type error here rather than a hung promise in
  // an app.
  void ({} as Record<
    keyof (typeof vaultCaps &
      typeof appCaps &
      typeof taskCaps &
      typeof agentCaps &
      typeof googleCaps),
    true
  > satisfies Record<MainAppMethod, true>)
  // The one way every door runs a capability: the renderer's UI door (the
  // router) and the agent's `holi` CLI (the bridge server, below).
  const capabilityHost = createCapabilityHost({
    registry: capabilities,
    rootFor,
    active: () => host.active(),
    core: createCoreServices({ active: () => host.active(), members, reports: uiReports }),
    pluginEnabled: async (plugin, root) => (await plugins.enabled(root)).has(plugin),
  })
  const dispatch = capabilityHost.dispatch
  // The app door's one opener is the vault apps code, which keeps the
  // approvals an entry's `appGrant` asks for.
  const appDoor = capabilityHost.openAppDoor({ admit: admitApps(appGrants) })

  const router = createRouter({
    capabilities: capabilityHost,
    appDoor,
    seed: (root) => plugins.seed(root),
    plugins,
    grants: appGrants,
    members,
    reportUi: (remote, report) => {
      uiReports.set(remote, report)
      // The agent's per-turn hook reads the focused note from a file in the
      // open vault's clone; a report about another vault has no file to feed.
      if (host.active()?.remote === remote) {
        agent?.setFocus({ focusedPath: report.focusedPath, openPaths: report.openPaths })
      }
    },
    registry,
    session,
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
  })

  registerIpc({ router, rootFor: (remote) => rootFor(remote) })

  // The vault agent: any number of live `claude` sessions, all in the
  // active vault's clone, all ended when that vault closes. `getWindow` is lazy,
  // so registering the seam before the window exists is safe.
  //
  // The hook server learns turn start/end from the agent's own Claude Code hooks
  // and drives the manager's pause/resume. The forward ref is safe: its
  // callbacks fire only at runtime, long after `agent` is assigned.
  let agent: AgentSessions
  const holiCliPath = await installHoliCli(app.getPath('userData'))

  /**
   * `holi skills update` and the palette's Update skills: bring this
   * release's skills and hooks to a vault. Conflicts get a session of their
   * own, but only in the vault Holi is showing, the one sessions start in.
   */
  const updateSkills = async (remote: string): Promise<SkillsUpdate> => {
    const root = await rootFor(remote)
    if (root === null) return { ok: false, message: 'No vault is open.' }
    const report = await updateShipped(root, await plugins.contributions(root))
    let terminalId: string | undefined
    if (report.conflicts.length > 0 && host.active()?.remote === remote) {
      const started = await agent.start({
        name: 'Update skills',
        prompt: await updateConflictPrompt(root, report.conflicts),
      })
      if (started.ok) terminalId = started.terminalId
      else console.warn('[skills] no session for the conflicts:', started.message)
    }
    return {
      ok: true,
      report,
      summary: describeUpdate(report, terminalId !== undefined),
      ...(terminalId === undefined ? {} : { terminalId }),
    }
  }

  // The bridge: what runs inside a vault (the `holi` command, the agent's
  // hooks, git's hook and merge driver) reaching this Holi on loopback.
  const bridge = createBridgeServer({
    cli: { dispatch, commands: () => capabilities.commands() },
  })
  registerAgentRoutes(bridge, {
    // A turn edge in one of a vault's background sessions, by job id.
    onJobTurn: (remote, jobId, active) => agent.noteTurn(remote, jobId, active),
    // A session's status line: how much of its context is used.
    onStatus: (remote, jobId, status) => agent.noteStatus(remote, jobId, status),
  })
  registerGitRoutes(bridge, { rootFor })
  await bridge.start()
  const binDir = dirname(holiCliPath)
  const terminals = createAgentTerminals({ getWindow: () => mainWindow })
  agent = createAgentSessions({
    host,
    getWindow: () => mainWindow,
    cli: createClaudeCli(),
    terminals,
    // Per vault open, not per launch: the active vault moves, and the theme
    // stamped into its directory tracks a setting the user can flip while the
    // app runs. Static paths every session needs ride in the settings `env`
    // block, the one channel that reaches a background session.
    resolveConfig: async ({ remote, root }) =>
      resolveVaultAgentConfig({
        userDataDir,
        remote,
        root,
        systemPrefersDark: nativeTheme.shouldUseDarkColors,
        env: { HOLI_BIN: holiCliPath },
      }),
    takeFirstSpawn,
    binDir: () => binDir,
    // What each turn changed, as a commit range, in the vault it ran in.
    turnLogFor: openTurnLog,
  })
  registerAgentIpc({
    agent,
    terminals,
    // The palette's Update skills: the report as a native notification, since
    // Holi has no notice surface of its own; a conflict's session opens too.
    updateSkills: async () => {
      const remote = host.active()?.remote
      if (remote === undefined) return { ok: false, message: 'No vault is open.' }
      const result = await updateSkills(remote)
      const body = result.ok ? result.summary : result.message
      new Notification({ title: 'Update skills', body }).show()
      return result
    },
  })

  /**
   * Reminders: a tray-resident evaluator sweeps every registered vault each
   * minute (and once at launch, the catch-up for fires missed while quit) and
   * raises native notifications.
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
   * The window may be gone entirely (tray-resident), so recreate it and
   * deliver on `did-finish-load`, or the push arrives before any renderer can
   * hear it.
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
  // Pull on focus. The interval exists for the case where the window never
  // loses focus at all.
  win.on('focus', () => host.active()?.onFocus())

  // Create-or-focus the one window: the dock/`activate` path and the tray's
  // Open Holi both funnel through here.
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
  // is the way back in (Open Holi) and the way out (Quit, since ⌘W is not).
  tray = createTray({ openWindow })
  // After the first window: the Developer menu sends to whatever window is
  // current, and there has to be one for the send to land.
  installAppMenu(() => mainWindow)

  /**
   * First-run only: ask once whether to launch Holi at login, since reminders
   * fire only while it is running. The "asked" flag lives in userData (never a
   * vault), so a later launch never re-asks. Fire-and-forget so the modal does
   * not hold up startup.
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
   * exit before it finishes, losing the edit the commit debounce was holding.
   * So veto the first quit, flush, then quit for real. `quitting` makes the
   * second pass fall through, or this vetoes forever.
   */
  let quitting = false
  /** A quit confirm is on screen: a second ⌘Q must not stack another. */
  let confirmingQuit = false
  /**
   * Quitting stops the vault's sessions, so ask first when one of them
   * is working or waiting on you: that turn is cut short. Asked at the start,
   * before anything is torn down. Idle sessions stop without a question; their
   * conversations stay in Claude Code's agent list.
   */
  async function confirmQuit(): Promise<boolean> {
    const busy = agent.sessions().filter((s) => s.state !== 'idle')
    if (busy.length === 0) return true
    const one = busy.length === 1
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: one ? `Quit and stop ${busy[0]!.name}?` : `Quit and stop ${busy.length} sessions?`,
      detail: `${one ? 'Its' : 'Their'} current turn is cut short. The conversation${one ? '' : 's'} stay in the agents list.`,
    }
    const { response } =
      mainWindow === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(mainWindow, options)
    return response === 0
  }
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    if (confirmingQuit) return
    confirmingQuit = true
    void confirmQuit()
      .catch(() => true)
      .then((go) => {
        confirmingQuit = false
        if (!go) return
        quitting = true
        void teardownAndQuit()
      })
  })

  async function teardownAndQuit(): Promise<void> {
    reminders.close() // stop the sweep timer at once: no tick into a teardown
    tray?.destroy() // let go of the menu-bar item as we leave
    tray = null
    await (async () => {
      try {
        // Stop the vault's sessions and close every terminal before we flush
        // and commit: nothing a session was mid-writing should race the
        // teardown.
        await agent.leave().catch((err) => console.error('[quit] agent leave failed:', err))
        await bridge.stop().catch((err) => console.error('[quit] bridge stop failed:', err))
        await plugins.disposeAll().catch((err) => console.error('[quit] plugins stop failed:', err))
        // A flush point is a flush THEN a commit, and only the renderer can do
        // the first half: the editor's newest words are not on disk until it
        // writes them. Quit is the one flush point main starts, so it asks.
        await requestFlush(flushChannel(mainWindow))
        // Quit is a leave point: commit the flushed buffer, then get it
        // off-machine before the window closes. Best-effort with a 1s budget:
        // an unreachable remote must not hang quit, and the next launch drains
        // what did not make it out. Order is flush -> commit -> push -> close.
        const vault = host.active()
        if (vault !== null) {
          await vault.commitNow().catch((err) => console.error('[quit] commit failed:', err))
          await Promise.race([vault.pushNow(), new Promise((r) => setTimeout(r, 1_000))])
        }
        // `close()` commits the open vault again (a clean no-op) before letting
        // go of it.
        await host.close()
      } catch (err) {
        console.error('[quit] teardown failed:', err)
      } finally {
        // Always quit, even if the flush threw: a failed teardown must not
        // trap someone in an app they are trying to leave.
        app.quit()
      }
    })()
  }
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

// Keep-alive on every platform: closing the last window does not quit, so the
// reminder sweep keeps running tray-resident. A real quit is the tray's Quit or
// ⌘Q → `before-quit`. The handler must stay registered and empty: with none,
// Electron's default quits on Windows/Linux.
app.on('window-all-closed', () => {
  // intentionally does not quit
})
