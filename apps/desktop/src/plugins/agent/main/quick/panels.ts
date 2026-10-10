/**
 * The quick panels and their dock (docs/features/quick-agent.md): one small
 * window per quick agent, and one slim window at the right edge of the screen
 * with a dot for each.
 *
 * A panel starts as a prompt, opened at the pointer by the global hotkey.
 * Sent, it goes out of sight and its agent becomes a dot in the dock, oldest
 * at the top, in its light's colour: yellow while it works, orange when it
 * needs you, green when it is done, red when it failed. Nothing comes to the
 * pointer on its own. Pointing at a dot brings that agent's panel out to the
 * left of the dock, level with its dot and without the keyboard; a click on a
 * dot, or the dock's key, brings it out with the keyboard, and ↑ ↓ then step
 * from agent to agent.
 *
 * The windows themselves are a `PanelSurface` each (`surface.ts` makes them
 * from Electron) and a `DockSurface` (`dock.ts`), so everything here runs
 * under plain Node in the tests.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import type { PendingQuestion } from '../../shared/questions'
import {
  ASKING_STATES,
  FINISHED_STATES,
  quickPrompt,
  type DockRequest,
  type DockView,
  type QuickRequest,
  type QuickSelection,
  type QuickState,
  type QuickView,
} from '../../shared/quick'
import type { ClaudeRow } from '../claude/listing'
import type { OpenResult, QuickStartResult } from '../host/sessions'
import type { TerminalSink } from '../host/terminals'
import { quickState, START_GRACE_MS } from '../host/quick-state'
import type { DockSurface } from './dock'
import {
  placeAtCursor,
  placeBesideDock,
  placeDock,
  resizeInPlace,
  type Point,
  type Rect,
} from './placement'

/** One panel window, as this module drives it. */
export interface PanelSurface {
  /** Tell its page what to show. */
  view(view: QuickView): void
  /** Its terminal's bytes and exit, when it shows a session's own prompt. */
  sink: TerminalSink
  /** Hear its page. A second call replaces the first. */
  onRequest(cb: (request: QuickRequest) => void): void
  /** The person took the keyboard from it, into another app or window, as
   *  against Holi moving it. A second call replaces the first. */
  onUserBlur(cb: () => void): void
  onClosed(cb: () => void): void
  bounds(): Rect
  place(bounds: Rect): void
  /** Show it, taking the keyboard or not. */
  show(focus: boolean): void
  /** Out of sight, the keyboard going back to the app the person was in. */
  hide(): void
  isVisible(): boolean
  isFocused(): boolean
  close(): void
}

export interface QuickPanelsDeps {
  openSurface(): PanelSurface
  /** The dock's window, opened once and kept. */
  openDock(): DockSurface
  cursor(): Point
  /** The work area of the display at `point`. */
  workArea(point: Point): Rect
  /** The open vault, or null with none. */
  remote(): string | null
  sessions: {
    startQuick(args: { name?: string; prompt: string }): Promise<QuickStartResult>
    row(id: string): ClaudeRow | undefined
    isLive(row: ClaudeRow): boolean
    stop(id: string): Promise<unknown>
    open(args: {
      attach: string
      sink: TerminalSink
      cols: number
      rows: number
    }): Promise<OpenResult>
  }
  questions: {
    pending(): readonly PendingQuestion[]
    answer(id: string, answers: Record<string, string>): boolean
  }
  terminals: { close(id: string): Promise<void> }
  /** The frontmost app's selection, read before the panel takes the keyboard. */
  readSelection(): Promise<QuickSelection | null>
  accessibility: {
    trusted(): boolean
    /** macOS's own prompt, which offers System Settings. */
    request(): void
    asked(): Promise<boolean>
    markAsked(): Promise<void>
  }
  /** Bring the main window forward on this session's tab. */
  openSession(job: string): Promise<void>
  /** The global hotkey as Holi's glyphs: a panel answers it itself. */
  hotkey(): string
  /** The dock's key, likewise. */
  dockHotkey(): string
  /** Keep one panel and the dock loaded and out of sight, so the hotkey shows
   *  a panel, and a sent prompt its dot, at once rather than after a window
   *  and its page have loaded. */
  spare?: boolean
  now?: () => number
  log?: (msg: string) => void
}

export interface QuickPanels {
  /** The global hotkey was pressed: the prompt being written, or a new one. */
  hotkey(): Promise<void>
  /** The dock's key was pressed: the dock, with the keyboard on the agent
   *  that most needs you. */
  dock(): Promise<void>
  /** The keys changed: every panel's page answers the new ones. */
  keysChanged(): void
  /** Read every quick agent's state again: a listing was read, or a question
   *  came or went. */
  update(): void
  /** A quick agent's turn ended with `message`: its panel shows it once done. */
  result(job: string, message: string): void
  /** Close every panel, the spare and the dock: the hotkey was turned off,
   *  or Holi is quitting. */
  closeAll(): void
  /** Have the spare and the dock ready (`QuickPanelsDeps.spare`). */
  prewarm(): void
}

/** A prompt's width, and a light's. The page asks for its height. */
const PROMPT_SIZE = { width: 520, height: 132 }
/** The terminal a session's own prompt is shown in, in cells. */
const TERMINAL_GEOMETRY = { cols: 96, rows: 18 }
const MIN = { width: 160, height: 36 }
const MAX = { width: 900, height: 640 }
/** How long a panel shown by pointing at its dot stays once the pointer has
 *  left the dock and the panel, so crossing the gap between them keeps it. */
export const HOVER_GRACE_MS = 250
/** How far down a panel the middle of its header is, until its page says:
 *  that is what lines up with its dot. */
const HEADER_MIDDLE = 22
/** The dock until its page says otherwise: dots 8 px, 10 px apart, with 10 px
 *  above and below them, in a pill 28 px wide. */
const DOT = { size: 8, gap: 10, pad: 10 }
const DOCK_WIDTH = 28
const DOCK_MAX_WIDTH = 64

interface Panel {
  id: number
  surface: PanelSurface
  /** The page has said it is listening. */
  ready: boolean
  mode: 'prompt' | 'access' | 'agent'
  /** Its place in the dock, from the moment it was sent: oldest first. */
  seq: number
  remote: string | null
  selection: QuickSelection | null
  job: string | null
  name: string
  state: QuickState
  /** When it entered its state: the dock's key goes to the oldest asking first. */
  since: number
  startedAt: number
  terminalId: string | null
  /** A terminal is being opened for it. */
  opening: boolean
  error?: string
  /** The last turn's closing message, the answer, while it is still the last. */
  result?: string
  questionId: string | null
  size: { width: number; height: number }
  /** The middle of its header, down from its top, as its page measured it. */
  header: number
}

/** The dock's window, and what its page has said. */
interface Dock {
  surface: DockSurface
  ready: boolean
  /** What the page asks for, and each dot's centre down from its top; null
   *  until it has said. */
  size: { width: number; height: number } | null
  dots: number[]
  /** The view last told, so an unchanged one is not sent again. */
  told: string
}

export function createQuickPanels(deps: QuickPanelsDeps): QuickPanels {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((msg: string) => console.log(`[quick] ${msg}`))
  const panels = new Map<number, Panel>()
  let nextId = 1
  let nextSeq = 1
  let dock: Dock | null = null
  /** Where the dock is: on the display the pointer was on when it appeared,
   *  or when the dock's key was last pressed. */
  let dockAt: Point | null = null
  /** The agent whose panel is out beside the dock. */
  let selected: Panel | null = null
  /** The pointer is on a dot, or on the panel out beside the dock. */
  const pointer = { dock: false, panel: false }
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  /** The panel loaded ahead, and whether its page is listening yet. */
  let spare: { surface: PanelSurface; ready: boolean } | null = null
  let spareTimer: ReturnType<typeof setTimeout> | null = null

  function prewarm(): void {
    if (deps.spare !== true) return
    openDock()
    if (spare !== null) return
    const entry = { surface: deps.openSurface(), ready: false }
    entry.surface.onRequest((request) => {
      if (request.kind === 'ready') entry.ready = true
    })
    entry.surface.onClosed(() => {
      if (spare === entry) spare = null
    })
    spare = entry
  }

  /** A window for a new panel: the spare, and another readied after it. */
  function takeSurface(): { surface: PanelSurface; ready: boolean } {
    const taken = spare ?? { surface: deps.openSurface(), ready: false }
    spare = null
    if (deps.spare === true && spareTimer === null) {
      // After the panel has shown, not alongside it.
      spareTimer = setTimeout(() => {
        spareTimer = null
        prewarm()
      }, 1_500)
    }
    return taken
  }

  const questionFor = (job: string | null): PendingQuestion | null =>
    job === null ? null : (deps.questions.pending().find((q) => q.job === job) ?? null)

  function viewOf(p: Panel): QuickView {
    if (p.mode === 'prompt') {
      return {
        kind: 'prompt',
        remote: p.remote,
        selection: p.selection,
        ...(p.error === undefined ? {} : { error: p.error }),
      }
    }
    if (p.mode === 'access') return { kind: 'access', remote: p.remote, selection: null }
    return {
      kind: 'agent',
      remote: p.remote ?? '',
      job: p.job ?? '',
      name: p.name,
      state: p.state,
      question: p.state === 'question' ? questionFor(p.job) : null,
      terminalId: p.state === 'prompt' ? p.terminalId : null,
      ...(p.error === undefined ? {} : { error: p.error }),
      ...(p.state === 'done' && p.result !== undefined ? { result: p.result } : {}),
    }
  }

  const tell = (p: Panel): void => {
    if (p.ready) p.surface.view(viewOf(p))
  }

  /** The keys its page answers itself: the hotkey (another agent) and the
   *  dock's key, which a card waiting for the keyboard names. */
  const tellKeys = (p: Panel): void => {
    p.surface.sink('quick-hotkey', deps.hotkey())
    p.surface.sink('quick-dock-hotkey', deps.dockHotkey())
  }

  /** Its page is listening: the keys it answers itself, and what to show. */
  const greet = (p: Panel): void => {
    p.ready = true
    tellKeys(p)
    // A window shown before its page listened: say where the keyboard is.
    p.surface.sink('quick-focus', { focused: p.surface.isFocused(), user: false })
    tell(p)
  }

  /** The quick agents, in the dock's order: oldest first. */
  const agents = (): Panel[] =>
    [...panels.values()].filter((p) => p.mode === 'agent').sort((a, b) => a.seq - b.seq)

  /** The windows showing: a new prompt does not land on them. */
  const taken = (except: Panel): Rect[] => [
    ...[...panels.values()]
      .filter((p) => p !== except && p.surface.isVisible())
      .map((p) => p.surface.bounds()),
    ...(dock?.surface.isVisible() === true ? [dock.surface.bounds()] : []),
  ]

  /** Show a prompt at the pointer, or where it is if it is already showing. */
  function reveal(p: Panel, focus: boolean): void {
    if (!p.surface.isVisible()) {
      const cursor = deps.cursor()
      p.surface.place(placeAtCursor(cursor, p.size, deps.workArea(cursor), taken(p)))
    }
    p.surface.show(focus)
  }

  function openDock(): Dock {
    if (dock !== null) return dock
    const d: Dock = { surface: deps.openDock(), ready: false, size: null, dots: [], told: '' }
    d.surface.onRequest((request) => handleDock(d, request))
    d.surface.onClosed(() => {
      if (dock === d) dock = null
    })
    dock = d
    return d
  }

  /** The dock's size for `n` dots: what its page asked for when it last
   *  showed that many, or what they need until it says. */
  const dockSize = (d: Dock, n: number): { width: number; height: number } =>
    d.size !== null && d.dots.length === n
      ? d.size
      : { width: DOCK_WIDTH, height: 2 * DOT.pad + n * DOT.size + Math.max(0, n - 1) * DOT.gap }

  /** Where the dock goes: against the right edge of the display it is on. */
  function dockRect(d: Dock): Rect {
    const at = dockAt ?? deps.cursor()
    return placeDock(dockSize(d, agents().length), deps.workArea(at))
  }

  /** The dock in its place, and the panel out beside it level with its dot. */
  function placeDockWindow(): void {
    if (dock === null) return
    dock.surface.place(dockRect(dock))
    if (selected !== null) placeBeside(selected)
  }

  /** `p` to the left of the dock, its header level with its dot. */
  function placeBeside(p: Panel): void {
    const index = agents().indexOf(p)
    if (dock === null || index < 0) return
    const at = dockRect(dock)
    const centre = dock.dots[index] ?? DOT.pad + index * (DOT.size + DOT.gap) + DOT.size / 2
    const area = deps.workArea({ x: at.x, y: at.y })
    p.surface.place(placeBesideDock(p.size, at, at.y + centre, p.header, area))
  }

  /** Tell the dock what it shows, and have it in sight exactly while there is
   *  a quick agent. */
  function refreshDock(): void {
    if (selected !== null && !panels.has(selected.id)) selected = null
    const list = agents()
    if (list.length === 0) {
      cancelHide()
      pointer.dock = false
      pointer.panel = false
    }
    if (list.length === 0 && dock === null) return
    const d = openDock()
    if (!d.ready) return
    const view: DockView = {
      remote: deps.remote(),
      dots: list.map((p) => ({ id: String(p.id), name: p.name, state: p.state })),
      selected: selected === null ? null : String(selected.id),
    }
    const told = JSON.stringify(view)
    const changed = told !== d.told
    if (changed) {
      d.told = told
      d.surface.view(view)
    }
    if (list.length === 0) {
      if (d.surface.isVisible()) d.surface.hide()
      return
    }
    // A dot more or fewer: the dock grows or shrinks about its middle, and
    // the panel out beside it follows its dot.
    if (changed && d.surface.isVisible()) placeDockWindow()
    if (!d.surface.isVisible()) {
      // It appears on the display the pointer is on.
      dockAt = deps.cursor()
      placeDockWindow()
      d.surface.show()
    }
  }

  /** `p`'s panel out beside the dock, with the keyboard or not. The one out
   *  before it goes after, so the keyboard moves from panel to panel rather
   *  than through the app the person was in. */
  function bringOut(p: Panel, focus: boolean): void {
    const before = selected
    selected = p
    pointer.panel = false
    placeBeside(p)
    p.surface.show(focus)
    if (before !== null && before !== p) before.surface.hide()
    refreshDock()
  }

  /** `p` out of sight, the keyboard going back to the app the person was in;
   *  an agent's dot stays. */
  function putAway(p: Panel): void {
    if (selected === p) {
      selected = null
      pointer.panel = false
    }
    p.surface.hide()
    refreshDock()
  }

  function cancelHide(): void {
    if (hoverTimer !== null) clearTimeout(hoverTimer)
    hoverTimer = null
  }

  /** The pointer left the dock or the panel: a panel shown by pointing goes
   *  after a moment, unless the pointer comes back or the panel has the
   *  keyboard. */
  function soonHide(): void {
    cancelHide()
    hoverTimer = setTimeout(() => {
      hoverTimer = null
      if (pointer.dock || pointer.panel || selected === null) return
      if (!selected.surface.isFocused()) putAway(selected)
    }, HOVER_GRACE_MS)
  }

  /** A dot's panel, by the id the dock knows it by. */
  const byDot = (id: string): Panel | undefined => agents().find((p) => String(p.id) === id)

  function handleDock(d: Dock, request: DockRequest): void {
    if (dock !== d) return
    switch (request.kind) {
      case 'ready':
        d.ready = true
        d.told = ''
        refreshDock()
        return
      case 'size': {
        d.size = {
          width: Math.min(DOCK_MAX_WIDTH, Math.max(1, Math.round(request.width))),
          height: Math.min(MAX.height, Math.max(1, Math.round(request.height))),
        }
        d.dots = request.dots
        if (d.surface.isVisible()) placeDockWindow()
        return
      }
      case 'hover': {
        pointer.dock = request.id !== null
        if (request.id === null) {
          soonHide()
          return
        }
        cancelHide()
        const p = byDot(request.id)
        if (p === undefined || p === selected) return
        // With the keyboard in an agent's panel, pointing moves it along.
        bringOut(p, selected?.surface.isFocused() === true)
        return
      }
      case 'pick': {
        const p = byDot(request.id)
        if (p !== undefined) bringOut(p, true)
        return
      }
    }
  }

  function close(p: Panel): void {
    if (!panels.delete(p.id)) return
    if (selected === p) {
      selected = null
      pointer.panel = false
    }
    if (p.terminalId !== null) void deps.terminals.close(p.terminalId)
    p.surface.close()
    refreshDock()
  }

  async function openTerminal(p: Panel): Promise<void> {
    if (p.job === null || p.terminalId !== null || p.opening) return
    p.opening = true
    const res = await deps.sessions.open({
      attach: p.job,
      sink: p.surface.sink,
      ...TERMINAL_GEOMETRY,
    })
    p.opening = false
    if (!res.ok) {
      log(`no terminal for ${p.job}: ${res.message}`)
      return
    }
    // It may have moved on, or closed, while the terminal opened.
    if (!panels.has(p.id) || p.state !== 'prompt') {
      void deps.terminals.close(res.terminalId)
      return
    }
    p.terminalId = res.terminalId
    tell(p)
  }

  function dropTerminal(p: Panel): void {
    if (p.terminalId === null) return
    void deps.terminals.close(p.terminalId)
    p.terminalId = null
  }

  function settle(p: Panel): void {
    if (p.mode !== 'agent') {
      // A prompt starts its agent in whichever vault is open when it is sent:
      // its header says which that is now.
      if (p.remote !== deps.remote()) {
        p.remote = deps.remote()
        tell(p)
      }
      return
    }
    // Leaving a vault stops its sessions: a light for one of them has nothing
    // left to say, and nor has a start there that failed.
    if (p.remote !== deps.remote()) return close(p)
    if (p.job === null) return
    const row = deps.sessions.row(p.job)
    const question = questionFor(p.job)
    const next = quickState({
      row,
      live: row !== undefined && deps.sessions.isLive(row),
      question: question !== null,
      age: now() - p.startedAt,
    })
    const newQuestion = (question?.id ?? null) !== p.questionId
    p.questionId = question?.id ?? null
    if (next === p.state && !newQuestion) return
    const was = p.state
    if (next !== was) {
      p.state = next
      p.since = now()
      // Another turn (a message from the main window): the answer it had is
      // no longer the last, and the next one comes as that turn ends.
      if (next === 'working' && FINISHED_STATES.includes(was)) delete p.result
    }
    if (next === 'gone') return close(p)
    if (next === 'prompt') void openTerminal(p)
    else dropTerminal(p)
    tell(p)
    // Wanting the person changes its dot, and nothing else: no panel comes to
    // the pointer on its own.
    if (
      next === 'working' &&
      ASKING_STATES.includes(was) &&
      p.surface.isVisible() &&
      !p.surface.isFocused()
    ) {
      // Answered elsewhere (over its tab): a panel out only to be looked at
      // goes. Answered here, it keeps the keyboard and shows the working
      // light, for ↑ ↓ to step on from.
      putAway(p)
      return
    }
    refreshDock()
  }

  function create(mode: Panel['mode'], selection: QuickSelection | null): Panel {
    const { surface, ready } = takeSurface()
    const p: Panel = {
      id: nextId++,
      surface,
      ready,
      mode,
      seq: 0,
      remote: deps.remote(),
      selection,
      job: null,
      name: '',
      state: 'working',
      since: now(),
      startedAt: now(),
      terminalId: null,
      opening: false,
      questionId: null,
      size: { ...PROMPT_SIZE },
      header: HEADER_MIDDLE,
    }
    panels.set(p.id, p)
    surface.onClosed(() => {
      if (panels.get(p.id) === p) close(p)
    })
    surface.onRequest((request) => void handle(p, request))
    // The person took the keyboard into another app: the agent's panel that
    // was out goes, and its dot stays. A prompt is its page's to decide, since
    // only the page knows whether there is a draft to keep.
    surface.onUserBlur(() => {
      if (panels.get(p.id) === p && p.mode === 'agent' && p.surface.isVisible()) putAway(p)
    })
    if (ready) greet(p)
    return p
  }

  async function submit(p: Panel, prompt: string, withSelection: boolean): Promise<void> {
    if (p.mode !== 'prompt' || prompt.trim() === '') return
    p.mode = 'agent'
    p.seq = nextSeq++
    // The agent starts in the vault open now, which may not be the one open
    // when the prompt was: leaving this one is what takes its dot away.
    p.remote = deps.remote()
    p.state = 'working'
    p.since = now()
    p.startedAt = now()
    p.name = prompt.trim().split('\n')[0] ?? ''
    delete p.error
    tell(p)
    // The task is in: the panel goes out of sight, the keyboard back to where
    // the person was, and the agent into the dock as a dot.
    p.surface.hide()
    refreshDock()
    const res = await deps.sessions.startQuick({
      name: prompt,
      prompt: quickPrompt(prompt, withSelection ? p.selection : null),
    })
    if (!panels.has(p.id)) return
    if (!res.ok) {
      p.state = 'failed'
      p.since = now()
      p.error = res.message
      tell(p)
      refreshDock()
      return
    }
    p.job = res.sessionId
    p.startedAt = now()
    // The panel learns its session whether or not its state moved.
    tell(p)
    settle(p)
    // A session the listing never shows is gone once the grace runs out, and
    // nothing else would read it again by then.
    setTimeout(() => {
      if (panels.has(p.id)) settle(p)
    }, START_GRACE_MS + 500)
  }

  async function handle(p: Panel, request: QuickRequest): Promise<void> {
    if (!panels.has(p.id)) return
    switch (request.kind) {
      case 'ready':
        greet(p)
        return
      case 'size': {
        const size = {
          width: Math.min(MAX.width, Math.max(MIN.width, Math.round(request.width))),
          height: Math.min(MAX.height, Math.max(MIN.height, Math.round(request.height))),
        }
        const header =
          request.header === undefined
            ? p.header
            : Math.min(size.height, Math.max(0, Math.round(request.header)))
        if (size.width === p.size.width && size.height === p.size.height && header === p.header) {
          return
        }
        p.size = size
        p.header = header
        if (selected === p) {
          placeBeside(p)
          return
        }
        // An agent out of sight is placed beside the dock when it comes out.
        if (p.mode === 'agent') return
        const at = p.surface.bounds()
        p.surface.place(resizeInPlace(at, size, deps.workArea({ x: at.x, y: at.y })))
        return
      }
      case 'submit':
        return submit(p, request.prompt, request.selection)
      case 'answer':
        // The desk tells every panel, this one included (`settle`).
        deps.questions.answer(request.questionId, request.answers)
        return
      case 'hide':
      case 'close-dock':
        // Out of sight, the agent still running and its dot still there.
        putAway(p)
        return
      case 'step': {
        if (p.mode !== 'agent') return
        const list = agents()
        const next = list[list.indexOf(p) + request.dir]
        // No wrap: the top and bottom dots are ends.
        if (next !== undefined) bringOut(next, true)
        return
      }
      case 'pointer':
        if (p !== selected) return
        pointer.panel = request.inside
        if (request.inside) cancelHide()
        else soonHide()
        return
      case 'clear':
        close(p)
        // Cleared is finished with: its session stops too, and its
        // conversation stays in the agents list.
        if (p.job !== null) {
          void deps.sessions.stop(p.job).catch((err: unknown) => log(`stop failed: ${String(err)}`))
        }
        return
      case 'open-session':
        if (p.job === null) return
        close(p)
        await deps.openSession(p.job)
        return
      case 'new':
        // The hotkey inside a panel, as from any other app; there is no other
        // app's selection to read.
        await promptKey(false)
        return
      case 'dock':
        await dockKey()
        return
      case 'grant-access':
      case 'skip-access':
        if (p.mode !== 'access') return
        await deps.accessibility.markAsked()
        if (request.kind === 'grant-access') deps.accessibility.request()
        p.mode = 'prompt'
        tell(p)
        return
    }
  }

  /** A prompt at the pointer, with the frontmost app's selection when asked. */
  async function newPrompt(withSelection: boolean): Promise<void> {
    if (!withSelection) {
      reveal(create('prompt', null), true)
      return
    }
    if (!deps.accessibility.trusted()) {
      const first = !(await deps.accessibility.asked())
      reveal(create(first ? 'access' : 'prompt', null), true)
      return
    }
    // In sight at once, but the keyboard stays where it is until the
    // selection is read: a ⌘C posted after the panel had it would go to the
    // panel.
    const p = create('prompt', null)
    reveal(p, false)
    p.selection = await deps.readSelection().catch(() => null)
    if (!panels.has(p.id)) return
    tell(p)
    p.surface.show(true)
  }

  /** The hotkey: a prompt not sent yet is the one you are writing, and
   *  otherwise a new one, with the frontmost app's selection when asked. */
  async function promptKey(withSelection: boolean): Promise<void> {
    const draft = [...panels.values()].find((p) => p.mode !== 'agent')
    if (draft !== undefined) {
      reveal(draft, true)
      return
    }
    await newPrompt(withSelection)
  }

  const hotkey = (): Promise<void> => promptKey(true)

  const oldest = (states: readonly QuickState[]): Panel | undefined =>
    agents()
      .filter((p) => states.includes(p.state))
      .sort((a, b) => a.since - b.since)[0]

  /** The dock's key: the dock comes to the pointer's display with the
   *  keyboard on the oldest agent asking, else the oldest finished, else the
   *  newest working. An asking agent whose panel the pointer brought out is
   *  the exception: its foot says to press this key to answer it, so it is
   *  the one that takes the keyboard. Any other panel out like that has no
   *  foot, and the key goes where it always does. With no agent at all the
   *  key opens a prompt, as the hotkey would, so it is never a dead key. */
  async function dockKey(): Promise<void> {
    const list = agents()
    if (list.length === 0) return hotkey()
    dockAt = deps.cursor()
    placeDockWindow()
    const looked =
      selected !== null &&
      selected.surface.isVisible() &&
      !selected.surface.isFocused() &&
      ASKING_STATES.includes(selected.state)
        ? selected
        : undefined
    const target =
      looked ??
      oldest(ASKING_STATES) ??
      oldest(FINISHED_STATES) ??
      list.filter((p) => p.state === 'working').at(-1) ??
      list.at(-1)!
    bringOut(target, true)
  }

  return {
    hotkey,

    dock: dockKey,

    keysChanged() {
      for (const p of panels.values()) if (p.ready) tellKeys(p)
    },

    update() {
      for (const p of [...panels.values()]) settle(p)
    },

    result(job, message) {
      const p = [...panels.values()].find((panel) => panel.job === job)
      if (p === undefined || message.trim() === '') return
      p.result = message.trim()
      tell(p)
    },

    closeAll() {
      for (const p of [...panels.values()]) close(p)
      cancelHide()
      if (spareTimer !== null) clearTimeout(spareTimer)
      spareTimer = null
      spare?.surface.close()
      spare = null
      dock?.surface.close()
      dock = null
      dockAt = null
    },

    prewarm,
  }
}
