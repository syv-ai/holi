/**
 * The quick panel and its dock (docs/features/quick-agent.md): one small
 * window that shows a prompt or one quick agent, and one slim window at the
 * right edge of the screen with a dot for each agent.
 *
 * The panel opens as a prompt at the pointer when the hotkey is pressed. Sent,
 * it goes out of sight and the agent becomes a dot in the dock, oldest at the
 * top, in its light's colour: yellow while it works, orange when it needs you,
 * green when it is done, red when it failed. Nothing comes to the pointer on
 * its own. Pointing at a dot brings the panel out to the left of the dock,
 * level with the dot and showing that agent, without the keyboard; a click on
 * a dot, or the dock's key, brings it out with the keyboard, and ↑ ↓ then step
 * from agent to agent.
 *
 * One window for them all: an agent is a record here, and the panel shows
 * whichever one is picked. A prompt left with a draft keeps it while the
 * panel shows an agent, because its page holds the text.
 *
 * The windows themselves are a `PanelSurface` (`surface.ts` makes it from
 * Electron) and a `DockSurface` (`dock.ts`), so everything here runs under
 * plain Node in the tests.
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
import type { LaunchResult, OpenResult } from '../host/sessions'
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

/** The panel's window, as this module drives it. */
export interface PanelSurface {
  /** Tell its page what to show. */
  view(view: QuickView): void
  /** Tell its page anything else: the keys, the keyboard, a terminal's bytes. */
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
    /** A quick agent's session, with the options the person chose. */
    launch(args: { name: string; prompt: string }): Promise<LaunchResult>
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
  /** The global hotkey as Holi's glyphs: the panel answers it itself. */
  hotkey(): string
  /** The dock's key, likewise. */
  dockHotkey(): string
  now?: () => number
  log?: (msg: string) => void
}

export interface QuickPanels {
  /** The global hotkey was pressed: the prompt being written, or a new one. */
  hotkey(): Promise<void>
  /** The dock's key was pressed: the dock, with the keyboard on the agent
   *  that most needs you. */
  dock(): Promise<void>
  /** The keys changed: the panel's page answers the new ones. */
  keysChanged(): void
  /** Read every quick agent's state again: a listing was read, or a question
   *  came or went. */
  update(): void
  /** A quick agent's turn ended with `message`: its panel shows it once done. */
  result(job: string, message: string): void
  /** Whether `job` is one of the quick agents: only theirs are the panel's. */
  owns(job: string): boolean
  /** Close the panel and the dock, and forget the agents (their sessions run
   *  on in the sidebar): the keys were turned off, or Holi is quitting. */
  closeAll(): void
  /** Load the panel and the dock out of sight, so the hotkey shows a panel,
   *  and a sent task its dot, at once. */
  prewarm(): void
}

/** A prompt's one line: the panel's size until its page measures it. */
export const PROMPT_SIZE = { width: 540, height: 58 }
/** An agent's light, likewise. */
const LIGHT_SIZE = { width: 400, height: 46 }
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
export const DOCK_WIDTH = 28
const DOCK_MAX_WIDTH = 64

type Size = { width: number; height: number }

interface Agent {
  /** Its dot, oldest first: ids only grow. */
  id: number
  remote: string | null
  /** Its session, once started; a start that failed has none. */
  job: string | null
  name: string
  state: QuickState
  /** When it entered its state: the dock's key goes to the oldest asking first. */
  since: number
  startedAt: number
  /** Its session's own terminal, open while Claude Code waits on its prompt. */
  terminalId: string | null
  opening: boolean
  error?: string
  /** The last turn's closing message, the answer, while it is still the last. */
  result?: string
  questionId: string | null
  /** Its view's size, and the middle of its header, as the page measured them. */
  size: Size
  header: number
}

/** The task being written: one at a time, kept until it is sent or cleared. */
interface Prompt {
  /** A new prompt's page starts empty; the same one keeps its draft. */
  id: number
  /** It explains the Accessibility permission first. */
  access: boolean
  remote: string | null
  selection: QuickSelection | null
  size: Size
}

/** The panel's window, and whether its page is listening. */
interface Panel {
  surface: PanelSurface
  ready: boolean
}

/** The dock's window, and what its page has said. */
interface Dock {
  surface: DockSurface
  ready: boolean
  /** What the page asks for, and each dot's centre down from its top; null
   *  until it has said. */
  size: Size | null
  dots: number[]
  /** The view last told, so an unchanged one is not sent again. */
  told: string
}

export function createQuickPanels(deps: QuickPanelsDeps): QuickPanels {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((msg: string) => console.log(`[quick] ${msg}`))
  /** Oldest first, which is the dock's order. */
  let agents: Agent[] = []
  let nextId = 1
  let prompt: Prompt | null = null
  let nextPromptId = 1
  let panel: Panel | null = null
  /** What the panel shows, in sight or not. */
  let shows: 'prompt' | Agent | null = null
  let dock: Dock | null = null
  /** Where the dock is: on the display the pointer was on when it appeared,
   *  or when the dock's key was last pressed. */
  let dockAt: Point | null = null
  /** The pointer is on a dot, or on the panel out beside the dock. */
  const pointer = { dock: false, panel: false }
  let hoverTimer: ReturnType<typeof setTimeout> | null = null

  const visible = (): boolean => panel?.surface.isVisible() === true
  const focused = (): boolean => panel?.surface.isFocused() === true
  /** The agent the panel shows, in sight or not. */
  const shownAgent = (): Agent | null => (shows === null || shows === 'prompt' ? null : shows)
  /** The agent whose panel is out beside the dock. */
  const selected = (): Agent | null => (visible() ? shownAgent() : null)
  const byId = (id: string): Agent | undefined => agents.find((a) => String(a.id) === id)

  function openPanel(): Panel {
    if (panel !== null) return panel
    const p: Panel = { surface: deps.openSurface(), ready: false }
    p.surface.onRequest((request) => void handle(p, request))
    // The person took the keyboard into another app: an agent out goes, and
    // its dot stays. A prompt is its page's to decide, since only the page
    // knows whether there is a draft to keep.
    p.surface.onUserBlur(() => {
      if (panel === p && shownAgent() !== null && visible()) putAway()
    })
    p.surface.onClosed(() => {
      if (panel !== p) return
      panel = null
      shows = null
    })
    panel = p
    return p
  }

  const questionFor = (job: string | null): PendingQuestion | null =>
    job === null ? null : (deps.questions.pending().find((q) => q.job === job) ?? null)

  function viewOf(target: 'prompt' | Agent): QuickView | null {
    if (target === 'prompt') {
      if (prompt === null) return null
      return prompt.access
        ? { kind: 'access', remote: prompt.remote, selection: null }
        : { kind: 'prompt', id: prompt.id, remote: prompt.remote, selection: prompt.selection }
    }
    const a = target
    return {
      kind: 'agent',
      id: String(a.id),
      remote: a.remote ?? '',
      job: a.job ?? '',
      name: a.name,
      state: a.state,
      question: a.state === 'question' ? questionFor(a.job) : null,
      terminalId: a.state === 'prompt' ? a.terminalId : null,
      ...(a.error === undefined ? {} : { error: a.error }),
      ...(a.state === 'done' && a.result !== undefined ? { result: a.result } : {}),
    }
  }

  /** Tell the page what the panel shows. */
  function tell(): void {
    if (panel === null || !panel.ready || shows === null) return
    const view = viewOf(shows)
    if (view !== null) panel.surface.view(view)
  }

  /** Tell the page again, if the panel shows `a`. */
  function retell(a: Agent): void {
    if (shows === a) tell()
  }

  /** The panel showing `target`, told before it comes out. */
  function display(target: 'prompt' | Agent): Panel {
    const p = openPanel()
    if (shows !== target) {
      shows = target
      tell()
    }
    return p
  }

  /** The keys its page answers itself: the hotkey (another agent) and the
   *  dock's key, which a card waiting for the keyboard names. */
  function tellKeys(p: Panel): void {
    p.surface.sink('quick-hotkey', deps.hotkey())
    p.surface.sink('quick-dock-hotkey', deps.dockHotkey())
  }

  /** Its page is listening: the keys it answers itself, and what to show. */
  function greet(p: Panel): void {
    p.ready = true
    tellKeys(p)
    // A window shown before its page listened: say where the keyboard is.
    p.surface.sink('quick-focus', { focused: p.surface.isFocused(), user: false })
    tell()
  }

  /** The prompt in sight with the keyboard or not: at the pointer, or where
   *  it is if it is already out. */
  function revealPrompt(focus: boolean): void {
    if (prompt === null) return
    const out = shows === 'prompt' && visible()
    const p = display('prompt')
    if (!out) {
      const cursor = deps.cursor()
      const taken = dock?.surface.isVisible() === true ? [dock.surface.bounds()] : []
      p.surface.place(placeAtCursor(cursor, prompt.size, deps.workArea(cursor), taken))
    }
    p.surface.show(focus)
    refreshDock()
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
  const dockSize = (d: Dock, n: number): Size =>
    d.size !== null && d.dots.length === n
      ? d.size
      : { width: DOCK_WIDTH, height: 2 * DOT.pad + n * DOT.size + Math.max(0, n - 1) * DOT.gap }

  /** Where the dock goes: against the right edge of the display it is on. */
  function dockRect(d: Dock): Rect {
    const at = dockAt ?? deps.cursor()
    return placeDock(dockSize(d, agents.length), deps.workArea(at))
  }

  /** The dock in its place, and the panel out beside it level with its dot. */
  function placeDockWindow(): void {
    if (dock === null) return
    dock.surface.place(dockRect(dock))
    const out = selected()
    if (out !== null) placeBeside(out)
  }

  /** The panel to the left of the dock, its header level with `a`'s dot. */
  function placeBeside(a: Agent): void {
    const index = agents.indexOf(a)
    if (dock === null || panel === null || index < 0) return
    const at = dockRect(dock)
    const centre = dock.dots[index] ?? DOT.pad + index * (DOT.size + DOT.gap) + DOT.size / 2
    const area = deps.workArea({ x: at.x, y: at.y })
    panel.surface.place(placeBesideDock(a.size, at, at.y + centre, a.header, area))
  }

  /** Tell the dock what it shows, and have it in sight exactly while there is
   *  a quick agent. */
  function refreshDock(): void {
    if (agents.length === 0) {
      cancelHide()
      pointer.dock = false
      pointer.panel = false
      if (dock === null) return
    }
    const d = openDock()
    if (!d.ready) return
    const out = selected()
    const view: DockView = {
      remote: deps.remote(),
      dots: agents.map((a) => ({ id: String(a.id), name: a.name, state: a.state })),
      selected: out === null ? null : String(out.id),
    }
    const told = JSON.stringify(view)
    const changed = told !== d.told
    if (changed) {
      d.told = told
      d.surface.view(view)
    }
    if (agents.length === 0) {
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

  /** The panel out beside the dock showing `a`, with the keyboard or not. */
  function bringOut(a: Agent, focus: boolean): void {
    cancelHide()
    pointer.panel = false
    const p = display(a)
    placeBeside(a)
    p.surface.show(focus)
    refreshDock()
  }

  /** The panel out of sight, the keyboard going back to the app the person
   *  was in. Every dot stays, and so does a prompt's draft. */
  function putAway(): void {
    cancelHide()
    pointer.panel = false
    panel?.surface.hide()
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
      if (pointer.dock || pointer.panel || selected() === null) return
      if (!focused()) putAway()
    }, HOVER_GRACE_MS)
  }

  function handleDock(d: Dock, request: DockRequest): void {
    if (dock !== d) return
    switch (request.kind) {
      case 'ready':
        d.ready = true
        d.told = ''
        refreshDock()
        return
      case 'size':
        d.size = {
          width: Math.min(DOCK_MAX_WIDTH, Math.max(1, Math.round(request.width))),
          height: Math.min(MAX.height, Math.max(1, Math.round(request.height))),
        }
        d.dots = request.dots
        if (d.surface.isVisible()) placeDockWindow()
        return
      case 'hover': {
        pointer.dock = request.id !== null
        if (request.id === null) {
          soonHide()
          return
        }
        cancelHide()
        const a = byId(request.id)
        // A prompt out is the person's to finish: pointing at a dot leaves it.
        if (a === undefined || a === selected() || (shows === 'prompt' && visible())) return
        // With the keyboard in an agent's panel, pointing moves it along.
        bringOut(a, focused())
        return
      }
      case 'pick': {
        const a = byId(request.id)
        if (a !== undefined) bringOut(a, true)
        return
      }
    }
  }

  /** `a` gone from the dock, and from the panel if it shows it. */
  function remove(a: Agent): void {
    if (!agents.includes(a)) return
    agents = agents.filter((other) => other !== a)
    dropTerminal(a)
    if (shows === a) {
      shows = null
      putAway()
      return
    }
    refreshDock()
  }

  async function openTerminal(a: Agent): Promise<void> {
    if (a.job === null || a.terminalId !== null || a.opening) return
    a.opening = true
    // Whichever window is the panel by then: its page attaches when it shows
    // the terminal, and is replayed everything before.
    const res = await deps.sessions.open({
      attach: a.job,
      sink: (name, payload) => panel?.surface.sink(name, payload),
      ...TERMINAL_GEOMETRY,
    })
    a.opening = false
    if (!res.ok) {
      log(`no terminal for ${a.job}: ${res.message}`)
      return
    }
    // It may have moved on, or gone, while the terminal opened.
    if (!agents.includes(a) || a.state !== 'prompt') {
      void deps.terminals.close(res.terminalId)
      return
    }
    a.terminalId = res.terminalId
    retell(a)
  }

  function dropTerminal(a: Agent): void {
    if (a.terminalId === null) return
    void deps.terminals.close(a.terminalId)
    a.terminalId = null
  }

  function settle(a: Agent): void {
    // Leaving a vault stops its sessions: a light for one of them has nothing
    // left to say, and nor has a start there that failed.
    if (a.remote !== deps.remote()) return remove(a)
    if (a.job === null) return
    const row = deps.sessions.row(a.job)
    const question = questionFor(a.job)
    const next = quickState({
      row,
      live: row !== undefined && deps.sessions.isLive(row),
      question: question !== null,
      age: now() - a.startedAt,
    })
    const newQuestion = (question?.id ?? null) !== a.questionId
    a.questionId = question?.id ?? null
    if (next === a.state && !newQuestion) return
    const was = a.state
    if (next !== was) {
      a.state = next
      a.since = now()
      // Another turn (a message from the main window): the answer it had is
      // no longer the last, and the next one comes as that turn ends.
      if (next === 'working' && FINISHED_STATES.includes(was)) delete a.result
    }
    if (next === 'gone') return remove(a)
    if (next === 'prompt') void openTerminal(a)
    else dropTerminal(a)
    retell(a)
    // Answered elsewhere (over its tab): a panel out only to be looked at
    // goes. Answered here, it keeps the keyboard and shows the working light,
    // for ↑ ↓ to step on from. Wanting the person changes its dot, and
    // nothing else: no panel comes to the pointer on its own.
    if (next === 'working' && ASKING_STATES.includes(was) && selected() === a && !focused()) {
      putAway()
      return
    }
    refreshDock()
  }

  async function submit(text: string, withSelection: boolean): Promise<void> {
    const p = prompt
    if (p === null || p.access || shows !== 'prompt' || text.trim() === '') return
    prompt = null
    const a: Agent = {
      id: nextId++,
      // The agent starts in the vault open now, which may not be the one open
      // when the prompt was: leaving this one is what takes its dot away.
      remote: deps.remote(),
      job: null,
      name: text.trim().split('\n')[0] ?? '',
      state: 'working',
      since: now(),
      startedAt: now(),
      terminalId: null,
      opening: false,
      questionId: null,
      size: { ...LIGHT_SIZE },
      header: HEADER_MIDDLE,
    }
    agents = [...agents, a]
    // The task is in: the panel goes out of sight, the keyboard back to where
    // the person was, and the agent into the dock as a dot.
    display(a)
    putAway()
    const res = await deps.sessions.launch({
      name: text,
      prompt: quickPrompt(text, withSelection ? p.selection : null),
    })
    if (!agents.includes(a)) return
    if (!res.ok) {
      a.state = 'failed'
      a.since = now()
      a.error = res.message
      retell(a)
      refreshDock()
      return
    }
    a.job = res.sessionId
    a.startedAt = now()
    // The panel learns its session whether or not its state moved.
    retell(a)
    settle(a)
    // A session the listing never shows is gone once the grace runs out, and
    // nothing else would read it again by then.
    setTimeout(() => {
      if (agents.includes(a)) settle(a)
    }, START_GRACE_MS + 500)
  }

  async function handle(p: Panel, request: QuickRequest): Promise<void> {
    if (panel !== p) return
    switch (request.kind) {
      case 'ready':
        greet(p)
        return
      case 'size': {
        if (shows === null) return
        const size = {
          width: Math.min(MAX.width, Math.max(MIN.width, Math.round(request.width))),
          height: Math.min(MAX.height, Math.max(MIN.height, Math.round(request.height))),
        }
        if (shows === 'prompt') {
          if (prompt === null || sameSize(prompt.size, size)) return
          prompt.size = size
          if (!visible()) return
          const at = p.surface.bounds()
          p.surface.place(resizeInPlace(at, size, deps.workArea({ x: at.x, y: at.y })))
          return
        }
        const a = shows
        const header =
          request.header === undefined
            ? a.header
            : Math.min(size.height, Math.max(0, Math.round(request.header)))
        if (sameSize(a.size, size) && header === a.header) return
        a.size = size
        a.header = header
        if (visible()) placeBeside(a)
        return
      }
      case 'submit':
        return submit(request.prompt, request.selection)
      case 'answer':
        // The desk tells the panel, through `update`.
        deps.questions.answer(request.questionId, request.answers)
        return
      case 'hide':
        // Out of sight: an agent still running and its dot still there, or a
        // prompt with its draft.
        putAway()
        return
      case 'clear': {
        if (request.agent === undefined) {
          // A prompt never sent.
          if (prompt === null) return
          prompt = null
          if (shows === 'prompt') putAway()
          return
        }
        const a = byId(request.agent)
        if (a === undefined) return
        remove(a)
        // Cleared is finished with: its session stops too, and its
        // conversation stays in the agents list.
        if (a.job !== null) {
          void deps.sessions.stop(a.job).catch((err: unknown) => log(`stop failed: ${String(err)}`))
        }
        return
      }
      case 'open-session': {
        const a = byId(request.agent)
        if (a === undefined || a.job === null) return
        remove(a)
        await deps.openSession(a.job)
        return
      }
      case 'step': {
        const a = byId(request.agent)
        if (a === undefined) return
        const next = agents[agents.indexOf(a) + request.dir]
        // No wrap: the top and bottom dots are ends.
        if (next !== undefined) bringOut(next, true)
        return
      }
      case 'pointer':
        if (selected() === null) return
        pointer.panel = request.inside
        if (request.inside) cancelHide()
        else soonHide()
        return
      case 'new':
        // The hotkey inside the panel, as from any other app; there is no
        // other app's selection to read.
        await promptKey(false)
        return
      case 'dock':
        await dockKey()
        return
      case 'grant-access':
      case 'skip-access':
        if (prompt === null || !prompt.access) return
        await deps.accessibility.markAsked()
        if (request.kind === 'grant-access') deps.accessibility.request()
        prompt.access = false
        if (shows === 'prompt') tell()
        return
    }
  }

  /** A new prompt at the pointer, with the frontmost app's selection when
   *  asked. */
  async function newPrompt(withSelection: boolean): Promise<void> {
    const trusted = deps.accessibility.trusted()
    const access = withSelection && !trusted && !(await deps.accessibility.asked())
    const p: Prompt = {
      id: nextPromptId++,
      access,
      remote: deps.remote(),
      selection: null,
      size: { ...PROMPT_SIZE },
    }
    prompt = p
    if (!withSelection || !trusted) {
      revealPrompt(true)
      return
    }
    // In sight at once, but the keyboard stays where it is until the
    // selection is read: the read asks the app in front for its focused
    // element, which must still be the one holding the selection.
    revealPrompt(false)
    p.selection = await deps.readSelection().catch(() => null)
    if (prompt !== p) return
    if (shows !== 'prompt') return
    tell()
    if (visible()) panel?.surface.show(true)
  }

  /** The hotkey: a prompt not sent yet is the one you are writing, and
   *  otherwise a new one, with the frontmost app's selection when asked. */
  async function promptKey(withSelection: boolean): Promise<void> {
    if (prompt !== null) {
      revealPrompt(true)
      return
    }
    await newPrompt(withSelection)
  }

  const hotkey = (): Promise<void> => promptKey(true)

  const oldest = (states: readonly QuickState[]): Agent | undefined =>
    agents.filter((a) => states.includes(a.state)).sort((a, b) => a.since - b.since)[0]

  /** The dock's key: the dock comes to the pointer's display with the
   *  keyboard on the oldest agent asking, else the oldest finished, else the
   *  newest working. An asking agent the pointer brought out is the
   *  exception: its foot says to press this key to answer it, so it is the
   *  one that takes the keyboard. With no agent at all the key opens a
   *  prompt, as the hotkey would, so it is never a dead key. */
  async function dockKey(): Promise<void> {
    if (agents.length === 0) return hotkey()
    dockAt = deps.cursor()
    placeDockWindow()
    const out = selected()
    const looked = out !== null && !focused() && ASKING_STATES.includes(out.state) ? out : undefined
    const target =
      looked ??
      oldest(ASKING_STATES) ??
      oldest(FINISHED_STATES) ??
      agents.filter((a) => a.state === 'working').at(-1) ??
      agents.at(-1)!
    bringOut(target, true)
  }

  return {
    hotkey,

    dock: dockKey,

    keysChanged() {
      if (panel?.ready === true) tellKeys(panel)
    },

    update() {
      // A prompt starts its agent in whichever vault is open when it is sent:
      // it names that one.
      if (prompt !== null && prompt.remote !== deps.remote()) {
        prompt.remote = deps.remote()
        if (shows === 'prompt') tell()
      }
      for (const a of agents) settle(a)
    },

    result(job, message) {
      const a = agents.find((agent) => agent.job === job)
      if (a === undefined || message.trim() === '') return
      a.result = message.trim()
      retell(a)
    },

    owns: (job) => agents.some((a) => a.job === job),

    closeAll() {
      for (const a of agents) dropTerminal(a)
      agents = []
      prompt = null
      shows = null
      cancelHide()
      panel?.surface.close()
      panel = null
      dock?.surface.close()
      dock = null
      dockAt = null
    },

    prewarm() {
      openPanel()
      openDock()
    },
  }
}

const sameSize = (a: Size, b: Size): boolean => a.width === b.width && a.height === b.height
