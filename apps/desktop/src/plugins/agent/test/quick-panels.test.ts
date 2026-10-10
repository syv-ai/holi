/**
 * The quick panels and their dock, driven through fake windows: where the
 * keys go, how a prompt becomes a dot in the dock, and how an agent's panel
 * comes out beside it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClaudeRow } from '../main/claude/listing'
import { createQuestionDesk } from '../main/host/questions'
import type { DockSurface } from '../main/quick/dock'
import {
  createQuickPanels,
  HOVER_GRACE_MS,
  type PanelSurface,
  type QuickPanelsDeps,
} from '../main/quick/panels'
import type { Point, Rect } from '../main/quick/placement'
import type { DockRequest, DockView, QuickRequest, QuickView } from '../shared/quick'

const REMOTE = 'syv/vault'

interface FakeSurface extends PanelSurface {
  views: QuickView[]
  visible: boolean
  focused: boolean
  closed: boolean
  at: Rect
  sent: Array<[string, unknown]>
  request(r: QuickRequest): void
  /** The person clicked into another app. */
  userBlur(): void
  last(): QuickView | undefined
}

function fakeSurface(): FakeSurface {
  let onRequest: (r: QuickRequest) => void = () => {}
  let onUserBlur: () => void = () => {}
  const closers: Array<() => void> = []
  const s: FakeSurface = {
    views: [],
    sent: [],
    visible: false,
    focused: false,
    closed: false,
    at: { x: 0, y: 0, width: 0, height: 0 },
    view: (v) => void s.views.push(v),
    sink: (name, payload) => void s.sent.push([name, payload]),
    onRequest: (cb) => void (onRequest = cb),
    onUserBlur: (cb) => void (onUserBlur = cb),
    onClosed: (cb) => void closers.push(cb),
    bounds: () => s.at,
    place: (b) => void (s.at = b),
    show(focus) {
      s.visible = true
      s.focused = focus
    },
    hide() {
      s.visible = false
      s.focused = false
    },
    isVisible: () => s.visible,
    isFocused: () => s.focused,
    close() {
      s.closed = true
      s.visible = false
    },
    request: (r) => onRequest(r),
    userBlur() {
      s.focused = false
      onUserBlur()
    },
    last: () => s.views.at(-1),
  }
  return s
}

interface FakeDock extends DockSurface {
  views: DockView[]
  visible: boolean
  closed: boolean
  at: Rect
  request(r: DockRequest): void
  last(): DockView | undefined
}

function fakeDock(): FakeDock {
  let onRequest: (r: DockRequest) => void = () => {}
  const d: FakeDock = {
    views: [],
    visible: false,
    closed: false,
    at: { x: 0, y: 0, width: 0, height: 0 },
    view: (v) => void d.views.push(v),
    onRequest: (cb) => void (onRequest = cb),
    onClosed: () => {},
    bounds: () => d.at,
    place: (b) => void (d.at = b),
    show: () => void (d.visible = true),
    hide: () => void (d.visible = false),
    isVisible: () => d.visible,
    close() {
      d.closed = true
      d.visible = false
    },
    request: (r) => onRequest(r),
    last: () => d.views.at(-1),
  }
  return d
}

const TOOL_INPUT = {
  questions: [
    { question: 'Which?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
  ],
}

/** The main display, and a second one to its right. */
const MAIN: Rect = { x: 0, y: 0, width: 1440, height: 900 }
const SECOND: Rect = { x: 1440, y: 0, width: 1920, height: 1080 }

function rig(over: Partial<QuickPanelsDeps> = {}) {
  const surfaces: FakeSurface[] = []
  const docks: FakeDock[] = []
  const rows = new Map<string, ClaudeRow>()
  let now = 1_000
  let started = 0
  const order: string[] = []
  let panels: ReturnType<typeof createQuickPanels>
  const desk = createQuestionDesk({ onChange: () => panels.update(), now: () => now })
  const deps: QuickPanelsDeps = {
    openSurface: () => {
      const s = fakeSurface()
      surfaces.push(s)
      return s
    },
    openDock: () => {
      const d = fakeDock()
      docks.push(d)
      return d
    },
    cursor: () => ({ x: 400, y: 300 }),
    workArea: (point: Point) => (point.x >= SECOND.x ? SECOND : MAIN),
    remote: () => REMOTE,
    sessions: {
      // Each agent is its own session: quick001, quick002, ...
      startQuick: vi.fn(async () => {
        started += 1
        const id = `quick00${started}`
        rows.set(id, { id, name: 'Tidy', pid: started, status: 'busy', state: 'working' })
        return { ok: true as const, sessionId: id }
      }),
      row: (id) => rows.get(id),
      isLive: (row) => row.pid !== undefined,
      stop: vi.fn(async () => ({ ok: true as const })),
      open: vi.fn(async () => ({ ok: true as const, terminalId: 'term-1' })),
    },
    questions: desk,
    terminals: { close: vi.fn(async () => {}) },
    readSelection: vi.fn(async () => {
      order.push('read')
      return { app: 'Notes', text: 'the selected words' }
    }),
    accessibility: {
      trusted: () => true,
      request: vi.fn(),
      asked: async () => true,
      markAsked: vi.fn(async () => {}),
    },
    openSession: vi.fn(async () => {}),
    hotkey: () => '⌘J',
    dockHotkey: () => '⌃⌘J',
    now: () => now,
    log: () => {},
    ...over,
  }
  panels = createQuickPanels(deps)
  return {
    panels,
    deps,
    desk,
    surfaces,
    docks,
    rows,
    order,
    tick: (ms: number) => void (now += ms),
    /** The dock's window, once there is one. */
    dock: () => docks[0]!,
    /** The listing moved for `id` (quick001 unless said). */
    setRow: (row: Partial<ClaudeRow>, id = 'quick001') => {
      rows.set(id, { id, name: 'Tidy', pid: 1, ...row })
      panels.update()
    },
    /** The agent `id` asks something. */
    ask: (id: string, toolUseId: string) =>
      desk.ask(
        id,
        { tool_use_id: toolUseId, tool_input: TOOL_INPUT },
        new AbortController().signal,
      ),
  }
}

type Rig = ReturnType<typeof rig>

/** A prompt opened with the hotkey, listening, and sent; the dock's page
 *  listening too. */
async function sent(r: Rig, prompt = 'tidy the inbox') {
  const before = r.surfaces.length
  await r.panels.hotkey()
  const s = r.surfaces[before]!
  s.request({ kind: 'ready' })
  s.request({ kind: 'submit', prompt, selection: true })
  await vi.waitFor(() => expect(s.last()).toMatchObject({ job: expect.stringMatching(/^quick/) }))
  if (r.docks.length === 1 && r.dock().views.length === 0) r.dock().request({ kind: 'ready' })
  return s
}

/** The dock reports `n` dots of the page's own layout: 8 px, 10 px apart,
 *  10 px padding. */
function measure(r: Rig, n: number) {
  const dots = Array.from({ length: n }, (_, i) => 14 + i * 18)
  r.dock().request({ kind: 'size', width: 28, height: 20 + 8 * n + 10 * (n - 1), dots })
}

/** A panel of the default size out beside a 28 px dock on the main display. */
const beside = (dockY: number, centre: number, size = { width: 520, height: 132 }): Rect => ({
  x: 1440 - 6 - 28 - 8 - size.width,
  y: dockY + centre - 22,
  ...size,
})

describe('the quick panels', () => {
  it('opens a prompt at the pointer, reading the selection before taking the keyboard', async () => {
    const r = rig()
    await r.panels.hotkey()
    const s = r.surfaces[0]!
    expect(r.deps.readSelection).toHaveBeenCalledOnce()
    expect(s.visible && s.focused).toBe(true)
    expect(s.at).toMatchObject({ x: 412, y: 312 })
    s.request({ kind: 'ready' })
    expect(s.sent).toContainEqual(['quick-hotkey', '⌘J'])
    expect(s.sent).toContainEqual(['quick-dock-hotkey', '⌃⌘J'])
    expect(s.last()).toEqual({
      kind: 'prompt',
      remote: REMOTE,
      selection: { app: 'Notes', text: 'the selected words' },
    })
  })

  it('tells every panel the keys again when they change', async () => {
    const r = rig()
    const s = await sent(r)
    r.deps.hotkey = () => '⌥Space'
    r.deps.dockHotkey = () => '⌃⌥Space'
    r.panels.keysChanged()
    expect(s.sent).toContainEqual(['quick-hotkey', '⌥Space'])
    expect(s.sent).toContainEqual(['quick-dock-hotkey', '⌃⌥Space'])
  })

  it('explains the permission on the first press without it, once', async () => {
    const r = rig({
      accessibility: {
        trusted: () => false,
        request: vi.fn(),
        asked: async () => false,
        markAsked: vi.fn(async () => {}),
      },
    })
    await r.panels.hotkey()
    const s = r.surfaces[0]!
    s.request({ kind: 'ready' })
    expect(s.last()?.kind).toBe('access')
    expect(r.deps.readSelection).not.toHaveBeenCalled()
    s.request({ kind: 'grant-access' })
    await vi.waitFor(() => expect(s.last()?.kind).toBe('prompt'))
    expect(r.deps.accessibility.markAsked).toHaveBeenCalled()
    expect(r.deps.accessibility.request).toHaveBeenCalled()
  })

  it('starts the agent with the task and the selection, and the prompt goes into the dock', async () => {
    const r = rig()
    const s = await sent(r)
    expect(r.deps.sessions.startQuick).toHaveBeenCalledWith({
      name: 'tidy the inbox',
      prompt: 'tidy the inbox\n\nSelected in Notes:\n\n```\nthe selected words\n```',
    })
    // Out of sight, the keyboard back where the person was.
    expect(s.visible).toBe(false)
    expect(s.focused).toBe(false)
    expect(s.last()).toMatchObject({
      kind: 'agent',
      job: 'quick001',
      state: 'working',
      name: 'tidy the inbox',
    })
    // Its dot, in a dock against the right edge of the pointer's display.
    const dock = r.dock()
    expect(dock.visible).toBe(true)
    expect(dock.last()).toEqual({
      remote: REMOTE,
      dots: [{ id: '1', name: 'tidy the inbox', state: 'working' }],
      selected: null,
    })
    expect(dock.at).toEqual({ x: 1406, y: 436, width: 28, height: 28 })
  })

  it('leaves the selection out when it was removed', async () => {
    const r = rig()
    await r.panels.hotkey()
    const s = r.surfaces[0]!
    s.request({ kind: 'submit', prompt: 'go', selection: false })
    await vi.waitFor(() =>
      expect(r.deps.sessions.startQuick).toHaveBeenCalledWith({ name: 'go', prompt: 'go' }),
    )
  })

  it('turns red with the reason when the agent cannot start', async () => {
    const r = rig()
    vi.mocked(r.deps.sessions.startQuick).mockResolvedValueOnce({
      ok: false,
      message: 'No vault is open.',
    })
    await r.panels.hotkey()
    const s = r.surfaces[0]!
    s.request({ kind: 'ready' })
    s.request({ kind: 'submit', prompt: 'go', selection: false })
    await vi.waitFor(() =>
      expect(s.last()).toMatchObject({ state: 'failed', error: 'No vault is open.' }),
    )
    r.dock().request({ kind: 'ready' })
    expect(r.dock().last()?.dots).toEqual([{ id: '1', name: 'go', state: 'failed' }])
  })

  it('lists the agents oldest first, each in its state, in an order that never moves', async () => {
    const r = rig()
    await sent(r, 'one\nwith more')
    await sent(r, 'two')
    await sent(r, 'three')
    const dock = r.dock()
    expect(dock.last()?.dots.map((d) => d.name)).toEqual(['one', 'two', 'three'])
    r.setRow({ status: 'idle', state: 'done' }, 'quick002')
    void r.ask('quick003', 'q3')
    expect(dock.last()?.dots).toEqual([
      { id: '1', name: 'one', state: 'working' },
      { id: '2', name: 'two', state: 'done' },
      { id: '3', name: 'three', state: 'question' },
    ])
    // Its dock grows with it, still centred against the edge.
    measure(r, 3)
    expect(dock.at).toEqual({ x: 1406, y: 418, width: 28, height: 64 })
  })

  it('brings nothing to the pointer when the agent asks: its dot says so', async () => {
    const r = rig()
    const s = await sent(r)
    const held = r.ask('quick001', 'q1')
    expect(s.visible).toBe(false)
    expect(r.dock().last()?.dots[0]?.state).toBe('question')
    expect(s.last()).toMatchObject({ state: 'question', question: { id: 'q1' } })

    // The hotkey is a new prompt, not the question.
    await r.panels.hotkey()
    expect(r.surfaces).toHaveLength(2)
    expect(s.visible).toBe(false)
    r.surfaces[1]!.request({ kind: 'clear' })

    // The dock's key goes to it, with the keyboard.
    await r.panels.dock()
    expect(s.visible && s.focused).toBe(true)
    s.request({ kind: 'answer', questionId: 'q1', answers: { 'Which?': 'B' } })
    expect(await held).not.toBeNull()
    // Answered here: back to work, still out and still with the keyboard.
    expect(s.last()).toMatchObject({ state: 'working', question: null })
    expect(s.visible && s.focused).toBe(true)
    expect(r.dock().last()).toMatchObject({ dots: [{ state: 'working' }], selected: '1' })
  })

  it('a panel only being looked at goes when its question is answered somewhere else', async () => {
    const r = rig()
    const s = await sent(r)
    void r.ask('quick001', 'q1')
    r.dock().request({ kind: 'hover', id: '1' })
    expect(s.visible).toBe(true)
    expect(s.focused).toBe(false)
    r.desk.answer('q1', { 'Which?': 'A' })
    expect(s.visible).toBe(false)
    expect(r.dock().last()?.selected).toBeNull()
  })

  it("opens the session's own terminal for Claude Code's prompt, and closes it after", async () => {
    const r = rig()
    const s = await sent(r)
    r.setRow({ status: 'waiting', waitingFor: 'permission prompt', state: 'blocked' })
    await vi.waitFor(() =>
      expect(s.last()).toMatchObject({ state: 'prompt', terminalId: 'term-1' }),
    )
    expect(s.visible).toBe(false)
    expect(r.dock().last()?.dots[0]?.state).toBe('prompt')
    expect(r.deps.sessions.open).toHaveBeenCalledWith(
      expect.objectContaining({ attach: 'quick001', sink: s.sink }),
    )
    r.setRow({ status: 'busy', state: 'working' })
    expect(r.deps.terminals.close).toHaveBeenCalledWith('term-1')
    expect(s.last()).toMatchObject({ state: 'working', terminalId: null })
  })

  it('stays green in the dock, and opens the session in Holi', async () => {
    const r = rig()
    const s = await sent(r)
    r.setRow({ status: 'idle', state: 'done' })
    expect(s.visible).toBe(false)
    expect(s.last()).toMatchObject({ state: 'done' })
    expect(r.dock().last()?.dots[0]?.state).toBe('done')
    await r.panels.dock()
    expect(s.visible && s.focused).toBe(true)
    s.request({ kind: 'open-session' })
    await vi.waitFor(() => expect(r.deps.openSession).toHaveBeenCalledWith('quick001'))
    expect(s.closed).toBe(true)
    expect(r.dock().visible).toBe(false)
  })

  it('shows the answer once done, and drops it when another turn starts', async () => {
    const r = rig()
    const s = await sent(r)
    // The hook can post before the listing says the turn ended.
    r.panels.result('quick001', '  The **answer** is 42.\n')
    expect(s.last()).not.toHaveProperty('result')
    r.setRow({ status: 'idle', state: 'done' })
    expect(s.last()).toMatchObject({ state: 'done', result: 'The **answer** is 42.' })
    // A message sent from the main window: that answer is no longer the last.
    r.setRow({ status: 'busy', state: 'working' })
    r.setRow({ status: 'idle', state: 'done' })
    expect(s.last()).toMatchObject({ state: 'done' })
    expect(s.last()).not.toHaveProperty('result')
    r.panels.result('quick001', 'Now 43.')
    expect(s.last()).toMatchObject({ result: 'Now 43.' })
    // Another job's answer is not this panel's.
    r.panels.result('other001', 'Not mine.')
    expect(s.last()).toMatchObject({ result: 'Now 43.' })
  })

  it('clearing a panel removes its dot and stops its session; opening it in Holi does not stop it', async () => {
    const r = rig()
    await sent(r, 'one')
    const s = await sent(r, 'two')
    r.setRow({ status: 'idle', state: 'done' }, 'quick002')
    await r.panels.dock()
    s.request({ kind: 'clear' })
    expect(s.closed).toBe(true)
    expect(r.deps.sessions.stop).toHaveBeenCalledWith('quick002')
    expect(r.dock().last()).toEqual({
      remote: REMOTE,
      dots: [{ id: '1', name: 'one', state: 'working' }],
      selected: null,
    })

    const r2 = rig()
    const s2 = await sent(r2)
    r2.setRow({ status: 'idle', state: 'done' })
    s2.request({ kind: 'open-session' })
    await vi.waitFor(() => expect(r2.deps.openSession).toHaveBeenCalledWith('quick001'))
    expect(r2.deps.sessions.stop).not.toHaveBeenCalled()
  })

  it('a prompt cleared before it was sent stops nothing', async () => {
    const r = rig()
    await r.panels.hotkey()
    const s = r.surfaces[0]!
    s.request({ kind: 'ready' })
    s.request({ kind: 'clear' })
    expect(s.closed).toBe(true)
    expect(r.deps.sessions.stop).not.toHaveBeenCalled()
  })

  it('a prompt being written is where the hotkey goes, draft and all', async () => {
    const r = rig()
    await r.panels.hotkey()
    const s = r.surfaces[0]!
    s.request({ kind: 'hide' })
    await r.panels.hotkey()
    expect(r.surfaces).toHaveLength(1)
    expect(s.visible && s.focused).toBe(true)
  })

  it("the hotkey inside an agent's panel is the draft out of sight too, and otherwise a new prompt", async () => {
    const r = rig()
    const agent = await sent(r)
    await r.panels.hotkey()
    const draft = r.surfaces[1]!
    draft.request({ kind: 'ready' })
    draft.request({ kind: 'hide' })
    await r.panels.dock()
    expect(agent.focused).toBe(true)
    agent.request({ kind: 'new' })
    await vi.waitFor(() => expect(draft.visible && draft.focused).toBe(true))
    expect(r.surfaces).toHaveLength(2)

    // No draft: a new prompt, with no other app's selection to read.
    draft.request({ kind: 'clear' })
    const reads = vi.mocked(r.deps.readSelection).mock.calls.length
    agent.request({ kind: 'new' })
    await vi.waitFor(() => expect(r.surfaces).toHaveLength(3))
    expect(r.surfaces[2]!.visible && r.surfaces[2]!.focused).toBe(true)
    expect(r.deps.readSelection).toHaveBeenCalledTimes(reads)
  })

  it('a prompt starts its agent in the vault open when it is sent, whose dot it keeps', async () => {
    const r = rig()
    let remote: string | null = null
    r.deps.remote = () => remote
    await r.panels.hotkey()
    const s = r.surfaces[0]!
    s.request({ kind: 'ready' })
    expect(s.last()).toMatchObject({ kind: 'prompt', remote: null })
    // The vault finishes opening while the task is written: the header says so.
    remote = REMOTE
    r.panels.update()
    expect(s.last()).toMatchObject({ kind: 'prompt', remote: REMOTE })
    // Switched to another before the next listing is read: that is where it runs.
    remote = 'syv/other'
    s.request({ kind: 'submit', prompt: 'go', selection: false })
    await vi.waitFor(() => expect(s.last()).toMatchObject({ job: 'quick001', remote: 'syv/other' }))
    r.panels.update()
    expect(s.closed).toBe(false)
    r.dock().request({ kind: 'ready' })
    expect(r.dock().last()?.dots).toEqual([{ id: '1', name: 'go', state: 'working' }])
  })

  it('closes when the session is gone, and when Holi leaves the vault; the dock goes with the last', async () => {
    const r = rig()
    const s = await sent(r)
    r.setRow({ pid: undefined, state: 'stopped' })
    expect(s.closed).toBe(true)
    expect(r.dock().visible).toBe(false)

    const r2 = rig()
    const s2 = await sent(r2)
    r2.deps.remote = () => null
    r2.panels.update()
    expect(s2.closed).toBe(true)
    expect(r2.dock().visible).toBe(false)
  })

  it('a start that failed leaves with its vault too', async () => {
    const r = rig()
    vi.mocked(r.deps.sessions.startQuick).mockResolvedValueOnce({
      ok: false,
      message: 'The vault closed as the agent started.',
    })
    await r.panels.hotkey()
    const s = r.surfaces[0]!
    s.request({ kind: 'ready' })
    s.request({ kind: 'submit', prompt: 'go', selection: false })
    await vi.waitFor(() => expect(s.last()).toMatchObject({ state: 'failed' }))
    r.dock().request({ kind: 'ready' })
    expect(r.dock().visible).toBe(true)
    r.deps.remote = () => 'syv/other'
    r.panels.update()
    expect(s.closed).toBe(true)
    expect(r.dock().visible).toBe(false)
  })

  it('sizes a prompt to its page, inside the work area', async () => {
    const r = rig()
    await r.panels.hotkey()
    const s = r.surfaces[0]!
    s.request({ kind: 'size', width: 340, height: 5_000 })
    expect(s.at.width).toBe(340)
    expect(s.at.height).toBeLessThanOrEqual(900)
  })

  it('shows the spare at once, already listening, and readies the next and the dock', async () => {
    vi.useFakeTimers()
    try {
      const r = rig({ spare: true })
      r.panels.prewarm()
      expect(r.surfaces).toHaveLength(1)
      expect(r.docks).toHaveLength(1)
      expect(r.dock().visible).toBe(false)
      const spare = r.surfaces[0]!
      spare.request({ kind: 'ready' })
      expect(spare.visible).toBe(false)

      await r.panels.hotkey()
      // The spare is the panel: no second window, and no wait for its page.
      expect(r.surfaces).toHaveLength(1)
      expect(spare.visible && spare.focused).toBe(true)
      expect(spare.sent).toContainEqual(['quick-hotkey', '⌘J'])
      expect(spare.last()?.kind).toBe('prompt')

      await vi.advanceTimersByTimeAsync(2_000)
      expect(r.surfaces).toHaveLength(2)
      r.panels.prewarm()
      expect(r.docks).toHaveLength(1)
      r.panels.closeAll()
      expect(r.surfaces.every((s) => s.closed)).toBe(true)
      expect(r.dock().closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the dock', () => {
  it('shows a panel beside it, level with its dot and without the keyboard, while the pointer is on it', async () => {
    const r = rig()
    await sent(r, 'one')
    const two = await sent(r, 'two')
    const dock = r.dock()
    measure(r, 2)
    expect(dock.at).toEqual({ x: 1406, y: 427, width: 28, height: 46 })
    vi.useFakeTimers()
    try {
      dock.request({ kind: 'hover', id: '2' })
      expect(two.visible).toBe(true)
      expect(two.focused).toBe(false)
      expect(two.at).toEqual(beside(427, 32))
      expect(dock.last()?.selected).toBe('2')
      // Its page asks for another size: it stays level with its dot.
      two.request({ kind: 'size', width: 360, height: 60 })
      expect(two.at).toEqual(beside(427, 32, { width: 360, height: 60 }))

      dock.request({ kind: 'hover', id: null })
      vi.advanceTimersByTime(HOVER_GRACE_MS - 50)
      expect(two.visible).toBe(true)
      vi.advanceTimersByTime(100)
      expect(two.visible).toBe(false)
      expect(dock.last()?.selected).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a hovered panel while the pointer is on the panel itself', async () => {
    const r = rig()
    const s = await sent(r)
    vi.useFakeTimers()
    try {
      r.dock().request({ kind: 'hover', id: '1' })
      r.dock().request({ kind: 'hover', id: null })
      s.request({ kind: 'pointer', inside: true })
      vi.advanceTimersByTime(HOVER_GRACE_MS * 4)
      expect(s.visible).toBe(true)
      s.request({ kind: 'pointer', inside: false })
      vi.advanceTimersByTime(HOVER_GRACE_MS + 10)
      expect(s.visible).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("lines the middle of a panel's header up with its dot, as its page measured it", async () => {
    const r = rig()
    await sent(r, 'one')
    const two = await sent(r, 'two')
    measure(r, 2)
    r.dock().request({ kind: 'hover', id: '2' })
    expect(two.at).toEqual(beside(427, 32))
    // A card's header sits lower in its panel than a light's does.
    two.request({ kind: 'size', width: 540, height: 300, header: 25.5 })
    expect(two.at).toEqual({
      x: 1440 - 6 - 28 - 8 - 540,
      y: 427 + 32 - 26,
      width: 540,
      height: 300,
    })
    // Only the header moved: it follows all the same.
    two.request({ kind: 'size', width: 540, height: 300, header: 21.5 })
    expect(two.at.y).toBe(427 + 32 - 22)
  })

  it('keeps the panel near the bottom of the screen whole', async () => {
    const r = rig()
    const s = await sent(r)
    measure(r, 1)
    s.request({ kind: 'size', width: 520, height: 640 })
    r.dock().request({ kind: 'hover', id: '1' })
    expect(s.at).toEqual({ x: 878, y: 900 - 12 - 640, width: 520, height: 640 })
  })

  it('a click on a dot brings its panel out with the keyboard, which pointing away does not take', async () => {
    const r = rig()
    const s = await sent(r)
    vi.useFakeTimers()
    try {
      r.dock().request({ kind: 'pick', id: '1' })
      expect(s.visible && s.focused).toBe(true)
      expect(r.dock().last()?.selected).toBe('1')
      r.dock().request({ kind: 'hover', id: null })
      vi.advanceTimersByTime(HOVER_GRACE_MS * 4)
      expect(s.visible && s.focused).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the dock key goes to the oldest asking, then the oldest finished, then the newest working', async () => {
    const r = rig()
    const one = await sent(r, 'one')
    const two = await sent(r, 'two')
    const three = await sent(r, 'three')
    const four = await sent(r, 'four')

    await r.panels.dock()
    expect(four.focused).toBe(true)

    r.setRow({ status: 'idle', state: 'done' }, 'quick003')
    r.tick(10)
    r.setRow({ status: 'idle', state: 'done' }, 'quick001')
    await r.panels.dock()
    expect(three.visible && three.focused).toBe(true)
    expect(four.visible).toBe(false)

    void r.ask('quick002', 'q2')
    await r.panels.dock()
    expect(two.visible && two.focused).toBe(true)
    expect(three.visible).toBe(false)
    expect(one.visible).toBe(false)
  })

  it('the dock key gives the keyboard to an asking panel the pointer brought out, whose foot names it', async () => {
    const r = rig()
    const one = await sent(r, 'one')
    const two = await sent(r, 'two')
    void r.ask('quick001', 'q1')
    r.tick(10)
    void r.ask('quick002', 'q2')
    r.dock().request({ kind: 'hover', id: '2' })
    expect(two.visible && !two.focused).toBe(true)
    await r.panels.dock()
    // Not the oldest asking: the one whose card said to press the key.
    expect(two.visible && two.focused).toBe(true)
    expect(one.visible).toBe(false)
  })

  it('the dock key passes over any other panel the pointer brought out, which names no key', async () => {
    const r = rig()
    const one = await sent(r, 'one')
    const two = await sent(r, 'two')
    void r.ask('quick001', 'q1')
    // Agent two's working light, out without the keyboard and with no foot.
    r.dock().request({ kind: 'hover', id: '2' })
    expect(two.visible && !two.focused).toBe(true)
    await r.panels.dock()
    expect(one.visible && one.focused).toBe(true)
    expect(two.visible).toBe(false)
  })

  it("the dock key inside an agent's panel goes to the agent that most needs you", async () => {
    const r = rig()
    const one = await sent(r, 'one')
    const two = await sent(r, 'two')
    await r.panels.dock()
    expect(two.focused).toBe(true)
    void r.ask('quick001', 'q1')
    expect(two.focused).toBe(true)
    two.request({ kind: 'dock' })
    await vi.waitFor(() => expect(one.visible && one.focused).toBe(true))
    expect(two.visible).toBe(false)
  })

  it('the dock key brings the dock to the display the pointer is on', async () => {
    const r = rig()
    const s = await sent(r)
    expect(r.dock().at.x).toBe(1406)
    r.deps.cursor = () => ({ x: 2000, y: 300 })
    await r.panels.dock()
    expect(r.dock().at).toEqual({ x: 3326, y: 526, width: 28, height: 28 })
    expect(s.at.x).toBe(3326 - 8 - 520)
  })

  it('↑ ↓ step the keyboard from agent to agent, and stop at the ends', async () => {
    const r = rig()
    const one = await sent(r, 'one')
    const two = await sent(r, 'two')
    const three = await sent(r, 'three')
    await r.panels.dock()
    expect(three.focused).toBe(true)

    three.request({ kind: 'step', dir: 1 })
    expect(three.visible && three.focused).toBe(true)

    three.request({ kind: 'step', dir: -1 })
    expect(two.visible && two.focused).toBe(true)
    expect(three.visible).toBe(false)
    expect(r.dock().last()?.selected).toBe('2')

    two.request({ kind: 'step', dir: -1 })
    one.request({ kind: 'step', dir: -1 })
    expect(one.visible && one.focused).toBe(true)
    expect(two.visible).toBe(false)
  })

  it('pointing at another dot moves the keyboard along when a panel has it', async () => {
    const r = rig()
    const one = await sent(r, 'one')
    const two = await sent(r, 'two')
    await r.panels.dock()
    expect(two.focused).toBe(true)
    r.dock().request({ kind: 'hover', id: '1' })
    expect(one.visible && one.focused).toBe(true)
    expect(two.visible).toBe(false)
  })

  it('esc puts the panel away and gives the keyboard back; the dot stays', async () => {
    const r = rig()
    const s = await sent(r)
    await r.panels.dock()
    s.request({ kind: 'close-dock' })
    expect(s.visible).toBe(false)
    expect(s.focused).toBe(false)
    expect(r.dock().visible).toBe(true)
    expect(r.dock().last()).toMatchObject({ dots: [{ id: '1' }], selected: null })
  })

  it('a panel the person clicks away from goes; a prompt is left to its page', async () => {
    const r = rig()
    const s = await sent(r)
    await r.panels.dock()
    s.userBlur()
    expect(s.visible).toBe(false)
    expect(r.dock().visible).toBe(true)
    expect(r.dock().last()?.selected).toBeNull()

    await r.panels.hotkey()
    const prompt = r.surfaces[1]!
    prompt.userBlur()
    expect(prompt.visible).toBe(true)
  })

  it('the dock key inside a prompt opens the dock', async () => {
    const r = rig()
    const s = await sent(r)
    await r.panels.hotkey()
    r.surfaces[1]!.request({ kind: 'dock' })
    await vi.waitFor(() => expect(s.visible && s.focused).toBe(true))
  })

  it('with no agents, the dock key opens a prompt and no dock', async () => {
    const r = rig()
    await r.panels.dock()
    expect(r.surfaces).toHaveLength(1)
    const s = r.surfaces[0]!
    expect(s.visible && s.focused).toBe(true)
    s.request({ kind: 'ready' })
    expect(s.last()?.kind).toBe('prompt')
    expect(r.docks).toHaveLength(0)
  })

  it('hides with the last agent, and comes back with the next', async () => {
    const r = rig()
    const s = await sent(r, 'one')
    s.request({ kind: 'clear' })
    expect(r.dock().visible).toBe(false)
    expect(r.dock().last()).toEqual({ remote: REMOTE, dots: [], selected: null })
    await sent(r, 'two')
    expect(r.dock().visible).toBe(true)
    expect(r.dock().last()?.dots).toEqual([{ id: '2', name: 'two', state: 'working' }])
  })
})
