/**
 * The quick panel (docs/features/quick-agent.md): the page of the agent's own
 * window (`RendererPlugin.pages.quick`), which main opens at the pointer when
 * the global hotkey is pressed. Sent, it is that agent's panel, which comes
 * out beside the agent's dot in the dock: without the keyboard while the
 * pointer is on the dot, with it from the dock's key or a click. With the
 * keyboard, ↑ ↓ step to the agent above or below, and esc puts it away, or
 * clears it once it has finished.
 *
 * It shows what main says (`quick-view`), and answers with requests
 * (`quick`). What it shows:
 *
 * - **A prompt**: the task, and the selection from the app the person was in.
 * - **The Accessibility line**, on the first press without the permission.
 * - **A light**: yellow while the agent works, green done, red failed.
 * - **The answer**: the agent's last message once it is done, so it is read
 *   where the task was typed.
 * - **A card** while it asks something, answered with one key.
 * - **The session's own terminal** while Claude Code waits on its own prompt
 *   (a permission), so the prompt is Claude Code's, keys and all, once ⏎ has
 *   stepped into it.
 *
 * The window is macOS's HUD glass; the page paints only what sits on it, and
 * always in the dark scheme, the vault's dark colours included.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AskAnswers } from '../../shared/questions'
import { DEFAULT_DOCK_HOTKEY, hotkeyFromEvent } from '../../shared/hotkey'
import type { QuickRequest, QuickView } from '../../shared/quick'
import { focusSessionTerminal, receivePtyData } from '../lib/session-terminals'
import { SessionTerminal } from '../SessionTerminal'
import { renderAnswer } from './answer'
import { LIGHT, STATE_WORDS, type Light } from './lights'
import { Hint, QuestionCard, WaitingHint } from './QuestionCard'
import './quick.css'
import { activeRemoteAtom, useVaultTheme } from '@/plugin-api'
import { Textarea } from '@/primitives'

const send = (request: QuickRequest): void => window.holi.page.send('quick', request)

/** The widths a panel comes in; its height is whatever its content is. A
 *  light is as wide as a finished one's foot of keys needs. */
const WIDTH = { prompt: 540, light: 400, card: 540, terminal: 760 }

/** Which light a panel is: a prompt has none yet. */
const lightOf = (view: QuickView | null): Light | 'idle' =>
  view === null || view.kind !== 'agent' ? 'idle' : LIGHT[view.state]

/** Keys typed into a field (your own answer) or into Claude Code's terminal
 *  are theirs, not the panel's. */
const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')

export function QuickPanel(): React.JSX.Element {
  const [view, setView] = useState<QuickView | null>(null)
  const [focused, setFocused] = useState(false)
  const setRemote = useSetAtom(activeRemoteAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  /** The prompt's text, kept here so a blur knows whether there is a draft. */
  const draftRef = useRef('')
  /** The global hotkey, as main holds it: pressed inside a panel, it starts
   *  another agent. */
  const [hotkey, setHotkey] = useState<string | null>(null)
  const hotkeyRef = useRef<string | null>(null)
  hotkeyRef.current = hotkey
  /** The dock's key, as main holds it: pressed in a prompt it opens the dock,
   *  in Claude Code's terminal it steps back out to the agents, and a panel
   *  out without the keyboard names it. */
  const [dockHotkey, setDockHotkey] = useState<string | null>(null)
  const dockHotkeyRef = useRef<string | null>(null)
  dockHotkeyRef.current = dockHotkey
  /** The terminal ⏎ stepped into, whose keys are then Claude Code's. Page
   *  local: main hears only that the panel has the keyboard. */
  const [insideOf, setInsideOf] = useState<string | null>(null)
  const terminalId = view?.kind === 'agent' && view.state === 'prompt' ? view.terminalId : null
  const inside = terminalId !== null && insideOf === terminalId
  const insideRef = useRef(inside)
  insideRef.current = inside

  // The HUD is dark whatever the vault's scheme, wearing the vault's dark
  // colours, and the glass shows through everything the page does not paint.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.dataset.page = 'quick'
  }, [])
  useVaultTheme({ fill: false })

  // What main says, and then that the page is listening.
  useEffect(() => {
    const off = window.holi.page.on(({ name, payload }) => {
      if (name === 'quick-view') setView(payload as QuickView)
      else if (name === 'quick-hotkey' && typeof payload === 'string') setHotkey(payload)
      else if (name === 'quick-dock-hotkey' && typeof payload === 'string') setDockHotkey(payload)
      else if (name === 'pty-data') receivePtyData(payload)
    })
    send({ kind: 'ready' })
    return off
  }, [])

  useEffect(() => {
    const next = view?.remote ?? null
    if (next !== remote) setRemote(next)
  }, [view, remote, setRemote])

  // Its size follows its content: main sizes the window to it, and lines the
  // middle of its header up with its dot. Measured as each view lands too,
  // not only when the observer says: a panel out of sight draws nothing, so
  // the observer waits, but it must come out at its new size.
  const report = useCallback(() => {
    const root = rootRef.current
    if (root === null) return
    const box = root.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return
    const header = root.querySelector('[data-quick-header]')?.getBoundingClientRect()
    send({
      kind: 'size',
      width: box.width,
      height: box.height,
      ...(header === undefined ? {} : { header: header.top + header.height / 2 - box.top }),
    })
  }, [])
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const observer = new ResizeObserver(report)
    observer.observe(root)
    return () => observer.disconnect()
  }, [report])
  useLayoutEffect(() => report(), [report, view, focused, dockHotkey, inside])

  // Whether the panel has the keyboard, as main tells it (`surface.ts`). A
  // person moving the keyboard elsewhere: a prompt nobody wrote in goes, one
  // with a draft waits for the hotkey, and an agent's panel goes back to its
  // dot. Either way a terminal stepped into is stepped out of.
  useEffect(
    () =>
      window.holi.page.on(({ name, payload }) => {
        if (name !== 'quick-focus') return
        const { focused: has, user } = payload as { focused: boolean; user: boolean }
        setFocused(has)
        if (!has) setInsideOf(null)
        const v = viewRef.current
        if (has || !user || v === null) return
        if (v.kind === 'prompt' || v.kind === 'access') {
          send({ kind: draftRef.current.trim() === '' ? 'clear' : 'hide' })
        } else {
          send({ kind: 'hide' })
        }
      }),
    [],
  )

  // The two global keys, which Holi does not hold while one of its windows has
  // the keyboard, so the page answers them. Ahead of everything else on the
  // page, Claude Code's terminal included, which would take them as its own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = viewRef.current
      const pressed = hotkeyFromEvent(e)
      if (pressed === null || v === null) return
      if (pressed === hotkeyRef.current) {
        e.preventDefault()
        e.stopPropagation()
        send({ kind: 'new' })
      } else if (pressed === dockHotkeyRef.current) {
        e.preventDefault()
        e.stopPropagation()
        if (v.kind === 'agent' && insideRef.current) {
          // Out of Claude Code's terminal, back to the agents.
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
          setInsideOf(null)
        } else {
          // From a prompt the dock; from an agent's panel, the agent that
          // most needs you, as the key does from any other app.
          send({ kind: 'dock' })
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The panel's own keys. A prompt: esc drops it. An agent's panel, beside
  // the dock: ↑ ↓ step to the agent above or below, and esc puts it away and
  // gives the keyboard back. A finished one has nothing left to wait for, so
  // esc clears it (⌫ too), and ⏎ opens it in Holi. The card's keys are its
  // own (`QuestionCard`).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const v = viewRef.current
      if (v === null) return
      if (v.kind !== 'agent') {
        if (e.key === 'Escape') {
          e.preventDefault()
          send({ kind: v.kind === 'prompt' ? 'clear' : 'skip-access' })
        } else if (v.kind === 'access' && e.key === 'Enter') {
          e.preventDefault()
          send({ kind: 'grant-access' })
        }
        return
      }
      if (insideRef.current || typing(e.target)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const finished = v.state === 'done' || v.state === 'failed'
      // A start that failed has no session to open in Holi.
      const opens = finished && v.job !== ''
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowDown':
          // ⇧↑ ⇧↓ read through a long answer (`AnswerView`).
          if (e.shiftKey) return
          e.preventDefault()
          send({ kind: 'step', dir: e.key === 'ArrowUp' ? -1 : 1 })
          return
        case 'Escape':
          e.preventDefault()
          send({ kind: finished ? 'clear' : 'close-dock' })
          return
        case 'Enter':
          if (e.shiftKey) return
          if (opens) {
            e.preventDefault()
            send({ kind: 'open-session' })
          } else if (v.state === 'prompt' && v.terminalId !== null) {
            e.preventDefault()
            setInsideOf(v.terminalId)
          }
          return
        case 'Backspace':
          if (!finished) return
          e.preventDefault()
          send({ kind: 'clear' })
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Stepped in: the keyboard goes to the terminal, which is no longer inert.
  useEffect(() => {
    if (inside && terminalId !== null) focusSessionTerminal(terminalId)
  }, [inside, terminalId])

  const light = lightOf(view)
  const width = widthOf(view)

  return (
    <div
      ref={rootRef}
      data-light={light}
      data-focused={focused}
      data-size={width === WIDTH.light ? 'light' : 'full'}
      className="quick-hud inline-flex flex-col"
      style={{ width }}
      // A panel the pointer brought out stays while the pointer is on it.
      onMouseEnter={() => send({ kind: 'pointer', inside: true })}
      onMouseLeave={() => send({ kind: 'pointer', inside: false })}
    >
      <span className="quick-corners" aria-hidden />
      {light === 'working' && <span className="quick-scan" aria-hidden />}
      {view === null ? null : view.kind === 'prompt' ? (
        <PromptView view={view} draftRef={draftRef} focused={focused} />
      ) : view.kind === 'access' ? (
        <AccessView view={view} />
      ) : (
        <AgentView
          view={view}
          focused={focused}
          dockHotkey={dockHotkey}
          inside={inside}
          onStepIn={setInsideOf}
        />
      )}
    </div>
  )
}

function widthOf(view: QuickView | null): number {
  if (view === null || view.kind === 'prompt' || view.kind === 'access') return WIDTH.prompt
  if (view.state === 'question') return WIDTH.card
  if (view.state === 'prompt' && view.terminalId !== null) return WIDTH.terminal
  if (view.state === 'done' && view.result !== undefined) return WIDTH.card
  return view.error === undefined ? WIDTH.light : WIDTH.card
}

/** A vault as the panel names it: the repository, without its owner. */
const vaultName = (remote: string | null): string =>
  remote === null ? 'no vault open' : (remote.split('/').at(-1) ?? remote)

/** Text in the panel's one column: past the icon slot (as wide as a keycap,
 *  which the orb, the caret and every keycap are centred in) and its gap. */
const COLUMN = 'pl-[31px]'

/**
 * The panel's top line: the light's orb, what it is, and on the right either
 * where it runs (`meta`, quiet) or where it has got to (`state`, lit in the
 * light's colour).
 */
function Header({ title, meta, state }: { title: string; meta?: string; state?: string }) {
  return (
    // Measured: its middle is what main lines up with the agent's dot.
    <div data-quick-header className="flex items-center gap-3">
      <span className="flex w-[19px] shrink-0 justify-center" aria-hidden>
        <span className="quick-orb" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium tracking-[0.01em] text-foreground/90">
        {title}
      </span>
      {meta !== undefined && <span className="quick-meta shrink-0">{meta}</span>}
      {state !== undefined && <span className="quick-state shrink-0">{state}</span>}
    </div>
  )
}

/** The keys a panel answers, along its foot. */
function Foot({ children }: { children: React.ReactNode }) {
  return <div className="quick-foot flex flex-wrap items-center gap-x-4 gap-y-1">{children}</div>
}

/** The dock's keys, last along an agent's foot wherever it has the keyboard. */
/** The dock's keys, last in every agent's foot. On a finished agent esc
 *  clears it rather than putting it away. */
function DockKeys({ clears = false }: { clears?: boolean }) {
  return (
    <>
      <Hint keys="↑↓">agents</Hint>
      <Hint keys="esc">{clears ? 'clear' : 'close'}</Hint>
    </>
  )
}

function PromptView({
  view,
  draftRef,
  focused,
}: {
  view: Extract<QuickView, { kind: 'prompt' }>
  draftRef: React.RefObject<string>
  focused: boolean
}) {
  const [text, setText] = useState('')
  const [attach, setAttach] = useState(true)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const selection = view.selection

  useEffect(() => {
    draftRef.current = text
  }, [text, draftRef])

  // The keyboard lands in the field whenever the panel gets it.
  useEffect(() => {
    if (focused) inputRef.current?.focus()
  }, [focused])

  const submit = useCallback(() => {
    if (text.trim() === '') return
    send({ kind: 'submit', prompt: text, selection: attach && selection !== null })
  }, [text, attach, selection])

  return (
    <div className="flex flex-col gap-3.5 p-4 pb-3 motion-in-fade">
      <Header title="New agent" meta={vaultName(view.remote)} />
      <div className="flex items-start gap-3">
        <span className="quick-caret w-[19px] shrink-0 text-center" aria-hidden>
          ›
        </span>
        <Textarea
          ref={inputRef}
          variant="bare"
          rows={1}
          aria-label="What should the agent do?"
          placeholder="What should Holi do?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            } else if (e.key === 'Backspace' && text === '' && attach && selection !== null) {
              e.preventDefault()
              setAttach(false)
            }
          }}
          className="quick-input max-h-52 min-h-[26px] flex-1 overflow-y-auto text-[18px] leading-[26px] placeholder:text-muted-foreground/55"
        />
      </div>
      {selection !== null && attach && (
        <div className={COLUMN}>
          <div className="quick-chip flex min-w-0 items-baseline gap-2.5 motion-in-fade">
            <span className="quick-label shrink-0">{selection.app}</span>
            <span className="line-clamp-2 min-w-0 text-[12px] leading-[17px] text-foreground/75">
              {selection.text.replace(/\s+/g, ' ').slice(0, 280)}
            </span>
          </div>
        </div>
      )}
      {view.error !== undefined && (
        <p className={`${COLUMN} quick-prose text-agent-failed`}>{view.error}</p>
      )}
      <Foot>
        <Hint keys="⏎" primary>
          start
        </Hint>
        <Hint keys="⇧⏎">new line</Hint>
        {selection !== null && attach && <Hint keys="⌫">drop the selection</Hint>}
        <Hint keys="esc">close</Hint>
      </Foot>
    </div>
  )
}

function AccessView({ view }: { view: Extract<QuickView, { kind: 'access' }> }) {
  return (
    <div className="flex flex-col gap-3.5 p-4 pb-3 motion-in-fade">
      <Header title="New agent" meta={vaultName(view.remote)} />
      <p className={`${COLUMN} quick-prose`}>
        Holi can bring along what you have selected in the app you are in. macOS asks you once to
        allow that, under Privacy &amp; Security, Accessibility.
      </p>
      <Foot>
        <Hint keys="⏎" primary>
          allow…
        </Hint>
        <Hint keys="esc">not now</Hint>
      </Foot>
    </div>
  )
}

function AgentView({
  view,
  focused,
  dockHotkey,
  inside,
  onStepIn,
}: {
  view: Extract<QuickView, { kind: 'agent' }>
  focused: boolean
  dockHotkey: string | null
  /** ⏎ has stepped into Claude Code's terminal: its keys are Claude Code's. */
  inside: boolean
  onStepIn(terminalId: string): void
}) {
  const answer = useCallback(
    (answers: AskAnswers) => {
      if (view.question !== null) send({ kind: 'answer', questionId: view.question.id, answers })
    },
    [view.question],
  )

  if (view.state === 'question' && view.question !== null) {
    return (
      <div className="flex flex-col gap-3.5 p-4 pb-3 motion-in-fade">
        <Header title={view.name} state={STATE_WORDS[view.state]} />
        <QuestionCard
          key={view.question.id}
          question={view.question}
          onAnswer={answer}
          keys="window"
          arrows={false}
          {...(focused ? {} : { waiting: dockHotkey })}
        />
      </div>
    )
  }

  if (view.state === 'prompt') {
    const terminal = view.terminalId
    return (
      <div className="flex flex-col gap-3 p-4 pb-3 motion-in-fade">
        <Header title={view.name} state={STATE_WORDS[view.state]} />
        {terminal === null ? (
          <p className={`${COLUMN} text-[12px] text-muted-foreground`}>
            Claude Code is asking something…
          </p>
        ) : (
          // Inert until ⏎ (or a click) steps in, so the dock's keys are not
          // typed into Claude Code; the dock's key steps back out.
          <div
            data-inside={inside}
            className="quick-terminal flex h-72 flex-col overflow-hidden motion-respond"
            onMouseDown={inside ? undefined : () => onStepIn(terminal)}
          >
            <div inert={!inside} className="flex min-h-0 flex-1 flex-col">
              <SessionTerminal terminalId={terminal} visible glass />
            </div>
          </div>
        )}
        <Foot>
          {!focused ? (
            <WaitingHint hotkey={dockHotkey} />
          ) : inside ? (
            <Hint keys={dockHotkey ?? DEFAULT_DOCK_HOTKEY}>back to the agents</Hint>
          ) : (
            <>
              {terminal !== null && (
                <Hint keys="⏎" primary>
                  answer in the terminal
                </Hint>
              )}
              <DockKeys />
            </>
          )}
        </Foot>
      </div>
    )
  }

  if (view.state === 'done' && view.result !== undefined) {
    return <AnswerView name={view.name} result={view.result} focused={focused} />
  }

  const finished = view.state === 'done' || view.state === 'failed'
  // A failure is a full panel, padded like the others. A light keeps its
  // header still as the keyboard arrives, the foot growing in beneath it.
  const spacing = view.error !== undefined ? 'gap-2.5 pb-3 pt-4' : focused ? 'gap-3 py-3' : 'py-3'
  return (
    <div className={`flex flex-col px-4 motion-in-fade ${spacing}`}>
      <Header title={view.name} state={STATE_WORDS[view.state]} />
      {view.error !== undefined && <p className={`${COLUMN} quick-prose`}>{view.error}</p>}
      {focused && (
        <Foot>
          {finished && view.job !== '' && (
            <Hint keys="⏎" primary>
              open in Holi
            </Hint>
          )}
          <DockKeys clears={finished} />
        </Foot>
      )}
    </div>
  )
}

/**
 * A finished agent's answer, its last message, in the panel's column. A long
 * one scrolls, its bottom edge fading while there is more. With the keyboard:
 * c copies it as Claude wrote it, ⇧↑ ⇧↓ read through it (↑ ↓ are the dock's),
 * and a link opens in the browser.
 */
function AnswerView({ name, result, focused }: { name: string; result: string; focused: boolean }) {
  const html = useMemo(() => renderAnswer(result), [result])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [overflow, setOverflow] = useState({ scrolls: false, more: false })
  const [copied, setCopied] = useState(false)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const read = () => {
      const scrolls = el.scrollHeight > el.clientHeight + 1
      const more = scrolls && el.scrollTop + el.clientHeight < el.scrollHeight - 1
      setOverflow((was) => (was.scrolls === scrolls && was.more === more ? was : { scrolls, more }))
    }
    read()
    el.addEventListener('scroll', read, { passive: true })
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', read)
      observer.disconnect()
    }
  }, [html])

  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'c') {
        e.preventDefault()
        void navigator.clipboard.writeText(result).then(() => setCopied(true))
      } else if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault()
        scrollRef.current?.scrollBy({ top: e.key === 'ArrowDown' ? 64 : -64 })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused, result])

  // "copied" for a moment, then the key's word again.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1_500)
    return () => clearTimeout(timer)
  }, [copied])

  /** A link goes to the browser, never into the panel. */
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const link = (e.target as HTMLElement).closest('a')
    if (link === null) return
    e.preventDefault()
    if (link.href !== '') void window.holi.openExternal(link.href)
  }

  return (
    <div className={`flex flex-col gap-3 px-4 pt-4 motion-in-fade ${focused ? 'pb-3' : 'pb-4'}`}>
      <Header title={name} state={STATE_WORDS.done} />
      <div
        ref={scrollRef}
        data-more={overflow.more}
        onClick={onClick}
        className={`${COLUMN} quick-answer max-h-80 overflow-y-auto`}
        // Built inert by `renderAnswer`: escaped HTML, no images, sanitised.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {focused && (
        <Foot>
          <Hint keys="⏎" primary>
            open in Holi
          </Hint>
          <Hint keys="c">{copied ? 'copied' : 'copy'}</Hint>
          {overflow.scrolls && <Hint keys="⇧↑↓">scroll</Hint>}
          <DockKeys clears />
        </Foot>
      )}
    </div>
  )
}
