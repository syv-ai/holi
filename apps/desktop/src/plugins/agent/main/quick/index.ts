/**
 * The quick agent (docs/features/quick-agent.md): a global hotkey that opens a
 * small panel at the pointer and starts a background session from it, and a
 * second, the dock's key, that opens the dock of quick agents with the
 * keyboard.
 *
 * **The keys are held only while Holi is not the app in front.** Inside Holi
 * each page answers them itself: in the main window the hotkey keeps its
 * in-app meaning (⌘J opens the agents) and the dock's key opens the dock
 * (`dock()`, through a capability), and in a quick panel the page answers
 * both (another agent, the dock). So they are registered as Holi loses the
 * keyboard and released as Holi takes it, and only while the quick agent is
 * switched on.
 *
 * Electron is loaded here, inside `activateApp`'s call, so the plugin stays
 * importable under plain Node.
 */
import type { AppContext } from '../../../../main/plugin-api'
import { parseGlobalHotkey, toAccelerator } from '../../shared/hotkey'
import type { QuickSettingsState } from '../../shared/quick'
import { isLive } from '../claude/listing'
import type { QuestionDesk } from '../host/questions'
import type { AgentSessions } from '../host/sessions'
import type { AgentTerminals } from '../host/terminals'
import { createQuickPanels } from './panels'
import { readSelection } from './selection'
import { quickSettingsStore, type QuickSettings } from './settings'
import { electronDock } from './dock'
import { electronSurface } from './surface'

export interface QuickAgent {
  /** A listing was read, or a question came or went. */
  update(): void
  /** A quick agent's turn ended with this message, for its panel. */
  result(job: string, message: string): void
  settings(): Promise<QuickSettingsState>
  setSettings(patch: {
    enabled?: boolean
    hotkey?: string
    dockHotkey?: string
  }): Promise<QuickSettingsState>
  /** The dock's key, pressed inside the main window, which answers it itself
   *  since Holi does not hold it there: as from any other app. False, doing
   *  nothing, while the keys are off. */
  dock(): Promise<boolean>
  /** Ask macOS for the Accessibility permission; true once Holi has it. */
  requestAccessibility(): boolean
  dispose(): void
}

export async function startQuickAgent(deps: {
  ctx: AppContext
  sessions: AgentSessions
  terminals: Pick<AgentTerminals, 'close'>
  desk: QuestionDesk
}): Promise<QuickAgent> {
  const { ctx, sessions, desk } = deps
  const { app, BrowserWindow, globalShortcut, screen, systemPreferences } = await import('electron')
  const store = quickSettingsStore(ctx.userData)
  /** The keys as last read, for a panel's page. */
  const first = await store.read()
  let hotkey = first.hotkey
  let dockHotkey = first.dockHotkey

  const panels = createQuickPanels({
    openSurface: () => electronSurface(ctx),
    openDock: () => electronDock(ctx),
    cursor: () => screen.getCursorScreenPoint(),
    workArea: (point) => screen.getDisplayNearestPoint(point).workArea,
    remote: () => ctx.active()?.remote ?? null,
    sessions: {
      startQuick: (args) => sessions.startQuick(args),
      row: (id) => sessions.row(id),
      stop: (id) => sessions.stop(id),
      isLive,
      open: (args) => sessions.open(args),
    },
    questions: desk,
    terminals: deps.terminals,
    readSelection: () => readSelection({ selfPid: process.pid }),
    accessibility: {
      trusted: () => systemPreferences.isTrustedAccessibilityClient(false),
      request: () => void systemPreferences.isTrustedAccessibilityClient(true),
      asked: async () => (await store.read()).accessibilityAsked,
      markAsked: async () => {
        await store.update((s) => ({ ...s, accessibilityAsked: true }))
      },
    },
    hotkey: () => hotkey,
    dockHotkey: () => dockHotkey,
    spare: true,
    openSession: async (job) => {
      const remote = ctx.active()?.remote
      if (remote === undefined) return
      await ctx.showMainWindow()
      ctx.emit(remote, 'open-session', { id: job })
    },
  })

  /** Each key: the accelerator Holi holds for it now, if any, whether another
   *  app held it the last time Holi asked, and what pressing it does. */
  const keys = {
    prompt: { held: null as string | null, conflict: false, press: () => void panels.hotkey() },
    dock: { held: null as string | null, conflict: false, press: () => void panels.dock() },
  }

  type Wanted = Record<keyof typeof keys, string | null>

  /** Hold each key as `want` says, or not at all. Every key that changes is
   *  let go before any is taken, so two keys trading places never collide. */
  const hold = (want: Wanted): void => {
    const changed = (['prompt', 'dock'] as const).filter((name) => want[name] !== keys[name].held)
    for (const name of changed) {
      const held = keys[name].held
      if (held !== null) globalShortcut.unregister(held)
      keys[name].held = null
    }
    for (const name of changed) {
      const key = keys[name]
      const accelerator = want[name]
      if (accelerator === null) continue
      key.conflict = !globalShortcut.register(accelerator, key.press)
      if (!key.conflict) key.held = accelerator
    }
  }

  /** The accelerators the settings ask for, while the quick agent is on.
   *  They are two keys, never one (`parseQuickSettings`). */
  const wanted = (settings: QuickSettings): Wanted => ({
    prompt: settings.enabled ? toAccelerator(settings.hotkey) : null,
    dock: settings.enabled ? toAccelerator(settings.dockHotkey) : null,
  })

  /** Hold the keys exactly while they are on and no window of Holi's has the
   *  keyboard. Serialised: focus moves faster than the settings file reads. */
  let syncing: Promise<void> = Promise.resolve()
  const sync = (): Promise<void> =>
    (syncing = syncing.then(async () => {
      const settings = await store.read()
      if (settings.hotkey !== hotkey || settings.dockHotkey !== dockHotkey) {
        hotkey = settings.hotkey
        dockHotkey = settings.dockHotkey
        panels.keysChanged()
      }
      if (settings.enabled) panels.prewarm()
      // Outside Holi only: inside, each page answers both keys itself.
      hold(
        BrowserWindow.getFocusedWindow() === null ? wanted(settings) : { prompt: null, dock: null },
      )
    }))

  const onFocus = (): void => void sync()
  // After the blur, a moment for the next window of Holi's to take focus, so
  // moving from a panel to the main window does not register in between.
  const onBlur = (): void => void setTimeout(() => void sync(), 50)
  // A window closed while it had the keyboard (a panel put away with esc)
  // says nothing on its way out: no blur follows it.
  const onCreated = (_event: unknown, win: Electron.BrowserWindow): void =>
    void win.once('closed', onBlur)
  app.on('browser-window-focus', onFocus)
  app.on('browser-window-blur', onBlur)
  app.on('browser-window-created', onCreated)
  app.on('did-become-active', onBlur)
  app.on('did-resign-active', onBlur)
  // The backstop: focus is told through several events, and a missed one must
  // never leave the key held inside Holi, or let go of it outside.
  const recheck = setInterval(() => void sync(), 5_000)
  await sync()

  const state = async (): Promise<QuickSettingsState> => {
    const s = await store.read()
    return {
      enabled: s.enabled,
      hotkey: s.hotkey,
      conflict: s.enabled && keys.prompt.conflict,
      dockHotkey: s.dockHotkey,
      dockConflict: s.enabled && keys.dock.conflict,
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    }
  }

  return {
    update: () => panels.update(),
    result: (job, message) => panels.result(job, message),
    settings: state,
    async setSettings(patch) {
      for (const key of [patch.hotkey, patch.dockHotkey]) {
        if (key !== undefined && parseGlobalHotkey(key) === null) {
          throw new Error(`${key} cannot be a global hotkey`)
        }
      }
      const current = await store.read()
      const next = {
        ...current,
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.hotkey === undefined ? {} : { hotkey: patch.hotkey }),
        ...(patch.dockHotkey === undefined ? {} : { dockHotkey: patch.dockHotkey }),
      }
      if (next.hotkey === next.dockHotkey) {
        throw new Error(
          patch.dockHotkey !== undefined
            ? `${next.dockHotkey} is already the key for a new agent`
            : `${next.hotkey} is already the dock's key`,
        )
      }
      await store.update((s) => ({
        ...s,
        enabled: next.enabled,
        hotkey: next.hotkey,
        dockHotkey: next.dockHotkey,
      }))
      // Settings is a Holi window with the keyboard, so nothing is held now;
      // try the new keys at once, so a key another app holds is reported here.
      const settings = await store.read()
      const want = wanted(settings)
      for (const name of ['prompt', 'dock'] as const) {
        const key = keys[name]
        const accelerator = want[name]
        key.conflict = false
        if (accelerator === null || key.held !== null) continue
        const free = globalShortcut.register(accelerator, () => {})
        if (free) globalShortcut.unregister(accelerator)
        key.conflict = !free
      }
      if (!settings.enabled) panels.closeAll()
      await sync()
      return state()
    },
    async dock() {
      if (!(await store.read()).enabled) return false
      await panels.dock()
      return true
    },
    requestAccessibility: () => systemPreferences.isTrustedAccessibilityClient(true),
    dispose() {
      clearInterval(recheck)
      app.removeListener('browser-window-focus', onFocus)
      app.removeListener('browser-window-blur', onBlur)
      app.removeListener('browser-window-created', onCreated)
      app.removeListener('did-become-active', onBlur)
      app.removeListener('did-resign-active', onBlur)
      hold({ prompt: null, dock: null })
      panels.closeAll()
    },
  }
}
