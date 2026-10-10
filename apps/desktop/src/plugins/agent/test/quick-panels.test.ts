/**
 * The quick panel and its dock, driven through fake windows: where the keys
 * go, how a prompt becomes a dot in the dock, and which agent the one panel
 * shows. Where a window lands, in pixels, is left to looking at it.
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
import type { Rect } from '../main/quick/placement'
import type { DockRequest, DockView, QuickRequest, QuickView } from '../shared/quick'

const REMOTE = 'syv/vault'
const AREA: Rect = { x: 0, y: 0, width: 1440, height: 900 }

interface FakeSurface extends PanelSurface {
  views: QuickView[]
  visible: boolean
  focused: boolean
  request(r: QuickRequest): void
  /** The person clicked into another app. */
  userBlur(): void
  last(): QuickView | undefined
}

function fakeSurface(): FakeSurface {
  let onRequest: (r: QuickRequest) => void = () => {}
  let onUserBlur: () => void = () => {}
  let at: Rect = { x: 0, y: 0, width: 0, height: 0 }
  const s: FakeSurface = {
    views: [],
    visible: false,
    focused: false,
    view: (v) => void s.views.push(v),
    sink: () => {},
    onRequest: (cb) => void (onRequest = cb),
    onUserBlur: (cb) => void (onUserBlur = cb),
    onClosed: () => {},
    bounds: () => at,
    place: (b) => void (at = b),
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
    close: () => void (s.visible = false),
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
  request(r: DockRequest): void
  last(): DockView | undefined
}

function fakeDock(): FakeDock {
  let onRequest: (r: DockRequest) => void = () => {}
  let at: Rect = { x: 0, y: 0, width: 0, height: 0 }
  const d: FakeDock = {
    views: [],
    visible: false,
    view: (v) => void d.views.push(v),
    onRequest: (cb) => void (onRequest = cb),
    onClosed: () => {},
    bounds: () => at,
    place: (b) => void (at = b),
    show: () => void (d.visible = true),
    hide: () => void (d.visible = false),
    isVisible: () => d.visible,
    close: () => void (d.visible = false),
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
    workArea: () => AREA,
    remote: () => REMOTE,
    sessions: {
      // Each agent is its own session: quick001, quick002, ...
      launch: vi.fn(async () => {
        started += 1
        const id = `quick00${started}`
        rows.set(id, { id, name: 'Tidy', pid: started, status: 'busy', state: 'working' })
        return { ok: true as const, sessionId: id }
      }),
      row: (id) => rows.get(id),
      inTurn: () => false,
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
    surfaces,
    order,
    tick: (ms: number) => void (now += ms),
    /** The panel's one window. */
    panel: () => surfaces[0]!,
    dock: () => docks[0]!,
    /** The listing moved for `id`. */
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

/** A prompt opened with the hotkey and sent, its session started; the pages
 *  listening. */
async function sent(r: Rig, prompt = 'tidy the inbox') {
  await r.panels.hotkey()
  r.panel().request({ kind: 'ready' })
  r.panel().request({ kind: 'submit', prompt, selection: true })
  const job = `quick00${vi.mocked(r.deps.sessions.launch).mock.calls.length}`
  await vi.waitFor(() => expect(r.panels.owns(job)).toBe(true))
  r.dock().request({ kind: 'ready' })
  return job
}

const dots = (r: Rig) =>
  r
    .dock()
    .last()
    ?.dots.map((d) => [d.id, d.state])

describe('the quick panel', () => {
  it('opens a prompt at the pointer, reading the selection before taking the keyboard', async () => {
    const r = rig()
    const focusedAtRead: boolean[] = []
    vi.mocked(r.deps.readSelection).mockImplementation(async () => {
      focusedAtRead.push(r.panel().focused)
      return { app: 'Notes', text: 'the selected words' }
    })
    await r.panels.hotkey()
    r.panel().request({ kind: 'ready' })
    expect(focusedAtRead).toEqual([false])
    expect(r.panel()).toMatchObject({ visible: true, focused: true })
    expect(r.panel().last()).toMatchObject({
      kind: 'prompt',
      remote: REMOTE,
      selection: { app: 'Notes', text: 'the selected words' },
    })
  })

  it('explains the permission on the first press without it, once', async () => {
    let asked = false
    const r = rig({
      accessibility: {
        trusted: () => false,
        request: vi.fn(),
        asked: async () => asked,
        markAsked: vi.fn(async () => void (asked = true)),
      },
    })
    await r.panels.hotkey()
    r.panel().request({ kind: 'ready' })
    expect(r.panel().last()?.kind).toBe('access')
    r.panel().request({ kind: 'grant-access' })
    await vi.waitFor(() => expect(r.panel().last()?.kind).toBe('prompt'))
    expect(r.deps.accessibility.request).toHaveBeenCalled()
    expect(r.deps.readSelection).not.toHaveBeenCalled()
  })

  it('sends the task with the selection, puts the panel away, and makes the agent a dot', async () => {
    const r = rig()
    const job = await sent(r)
    expect(r.deps.sessions.launch).toHaveBeenCalledWith({
      name: 'tidy the inbox',
      prompt: 'tidy the inbox\n\nSelected in Notes:\n\n```\nthe selected words\n```',
    })
    expect(r.panel().visible).toBe(false)
    expect(r.dock().visible).toBe(true)
    expect(dots(r)).toEqual([['1', 'working']])
    expect(r.panels.owns(job)).toBe(true)
    expect(r.panels.owns('other00')).toBe(false)
  })

  it('leaves the selection out when it was removed', async () => {
    const r = rig()
    await r.panels.hotkey()
    r.panel().request({ kind: 'ready' })
    r.panel().request({ kind: 'submit', prompt: 'go', selection: false })
    await vi.waitFor(() => expect(r.deps.sessions.launch).toHaveBeenCalled())
    expect(vi.mocked(r.deps.sessions.launch).mock.calls[0]![0].prompt).toBe('go')
  })

  it('turns red with the reason when the agent cannot start', async () => {
    const r = rig()
    vi.mocked(r.deps.sessions.launch).mockResolvedValueOnce({ ok: false, message: 'No claude.' })
    await r.panels.hotkey()
    r.panel().request({ kind: 'ready' })
    r.panel().request({ kind: 'submit', prompt: 'go', selection: false })
    await vi.waitFor(() => expect(r.panel().last()).toMatchObject({ state: 'failed' }))
    expect(r.panel().last()).toMatchObject({ kind: 'agent', error: 'No claude.' })
  })

  it('is one window for every prompt and agent', async () => {
    const r = rig()
    await sent(r, 'one')
    await sent(r, 'two')
    await r.panels.hotkey()
    expect(r.surfaces).toHaveLength(1)
    expect(r.panel().last()).toMatchObject({ kind: 'prompt' })
  })

  it('keeps a prompt with a draft, the same prompt, after the panel showed an agent', async () => {
    const r = rig()
    await sent(r)
    await r.panels.hotkey()
    const draft = r.panel().last()
    expect(draft).toMatchObject({ kind: 'prompt' })
    // Written in, then the person clicked away: its page says to keep it.
    r.panel().request({ kind: 'hide' })
    r.dock().request({ kind: 'pick', id: '1' })
    expect(r.panel().last()).toMatchObject({ kind: 'agent', id: '1' })
    await r.panels.hotkey()
    expect(r.panel().last()).toEqual(draft)
    expect(r.panel().focused).toBe(true)
    // Cleared, the next is a new prompt, which its page starts empty.
    r.panel().request({ kind: 'clear' })
    await r.panels.hotkey()
    expect(r.panel().last()).toMatchObject({ kind: 'prompt' })
    expect(r.panel().last()).not.toEqual(draft)
  })

  it('brings nothing to the pointer when the agent asks: its dot says so', async () => {
    const r = rig()
    const job = await sent(r)
    void r.ask(job, 'toolu_1')
    expect(dots(r)).toEqual([['1', 'question']])
    expect(r.panel().visible).toBe(false)
  })

  it("opens the session's own terminal for Claude Code's prompt, and closes it after", async () => {
    const r = rig()
    await sent(r)
    r.setRow({ status: 'waiting', state: 'working' })
    await vi.waitFor(() => expect(r.deps.sessions.open).toHaveBeenCalled())
    r.dock().request({ kind: 'pick', id: '1' })
    await vi.waitFor(() => expect(r.panel().last()).toMatchObject({ terminalId: 'term-1' }))
    r.setRow({ status: 'busy', state: 'working' })
    expect(r.deps.terminals.close).toHaveBeenCalledWith('term-1')
  })

  it('shows the answer once done, and drops it when another turn starts', async () => {
    const r = rig()
    const job = await sent(r)
    r.panels.result(job, 'Done: three filed.')
    r.setRow({ status: 'idle', state: 'done' })
    r.dock().request({ kind: 'pick', id: '1' })
    expect(r.panel().last()).toMatchObject({ state: 'done', result: 'Done: three filed.' })
    r.setRow({ status: 'busy', state: 'working' })
    expect(r.panel().last()).not.toHaveProperty('result')
  })

  it('clears an agent and stops its session; opening it in Holi does not stop it', async () => {
    const r = rig()
    const first = await sent(r, 'one')
    const second = await sent(r, 'two')
    r.panel().request({ kind: 'clear', agent: '1' })
    expect(r.deps.sessions.stop).toHaveBeenCalledWith(first)
    expect(dots(r)).toEqual([['2', 'working']])
    r.panel().request({ kind: 'open-session', agent: '2' })
    await vi.waitFor(() => expect(r.deps.openSession).toHaveBeenCalledWith(second))
    expect(r.deps.sessions.stop).toHaveBeenCalledTimes(1)
    expect(r.dock().visible).toBe(false)
  })

  it('a request about an agent lands on that agent, though the panel moved on', async () => {
    const r = rig()
    await sent(r, 'one')
    const second = await sent(r, 'two')
    r.dock().request({ kind: 'pick', id: '1' })
    // The panel moved to the second as esc on the first was in flight.
    r.dock().request({ kind: 'pick', id: '2' })
    r.panel().request({ kind: 'clear', agent: '1' })
    expect(r.deps.sessions.stop).not.toHaveBeenCalledWith(second)
    expect(r.panel().last()).toMatchObject({ id: '2' })
  })

  it('takes the dot away when the session is gone, or Holi leaves the vault', async () => {
    let remote: string | null = REMOTE
    const r = rig({ remote: () => remote })
    await sent(r, 'one')
    await sent(r, 'two')
    r.setRow({ status: undefined, state: 'stopped', pid: undefined })
    expect(dots(r)).toEqual([['2', 'working']])
    remote = null
    r.panels.update()
    expect(r.dock().visible).toBe(false)
  })
})

describe('the dock', () => {
  it('shows an agent beside it while the pointer is on its dot, without the keyboard', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      await sent(r)
      r.dock().request({ kind: 'hover', id: '1' })
      expect(r.panel()).toMatchObject({ visible: true, focused: false })
      expect(r.dock().last()?.selected).toBe('1')
      r.dock().request({ kind: 'hover', id: null })
      vi.advanceTimersByTime(HOVER_GRACE_MS + 1)
      expect(r.panel().visible).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a prompt that is out alone when the pointer crosses a dot', async () => {
    const r = rig()
    await sent(r)
    await r.panels.hotkey()
    r.dock().request({ kind: 'hover', id: '1' })
    expect(r.panel().last()).toMatchObject({ kind: 'prompt' })
  })

  it('the dock key goes to the oldest asking, then the oldest finished, then the newest working', async () => {
    const r = rig()
    await sent(r, 'one')
    const second = await sent(r, 'two')
    await sent(r, 'three')
    await r.panels.dock()
    expect(r.panel().last()).toMatchObject({ id: '3' })
    r.setRow({ status: 'idle', state: 'done' }, 'quick001')
    await r.panels.dock()
    expect(r.panel().last()).toMatchObject({ id: '1' })
    void r.ask(second, 'toolu_1')
    await r.panels.dock()
    expect(r.panel()).toMatchObject({ focused: true })
    expect(r.panel().last()).toMatchObject({ id: '2', state: 'question' })
  })

  it('↑ ↓ step the keyboard from agent to agent, and stop at the ends', async () => {
    const r = rig()
    await sent(r, 'one')
    await sent(r, 'two')
    r.dock().request({ kind: 'pick', id: '1' })
    r.panel().request({ kind: 'step', dir: -1, agent: '1' })
    expect(r.panel().last()).toMatchObject({ id: '1' })
    r.panel().request({ kind: 'step', dir: 1, agent: '1' })
    expect(r.panel().last()).toMatchObject({ id: '2' })
    expect(r.panel().focused).toBe(true)
  })

  it('esc and a click into another app put the panel away; the dots stay', async () => {
    const r = rig()
    await sent(r)
    r.dock().request({ kind: 'pick', id: '1' })
    r.panel().request({ kind: 'hide' })
    expect(r.panel().visible).toBe(false)
    r.dock().request({ kind: 'pick', id: '1' })
    r.panel().userBlur()
    expect(r.panel().visible).toBe(false)
    expect(dots(r)).toEqual([['1', 'working']])
  })

  it('with no agents, the dock key opens a prompt and no dock', async () => {
    const r = rig()
    await r.panels.dock()
    expect(r.panel()).toMatchObject({ visible: true, focused: true })
    expect(r.panel().views).toEqual([])
    r.panel().request({ kind: 'ready' })
    expect(r.panel().last()?.kind).toBe('prompt')
  })
})
