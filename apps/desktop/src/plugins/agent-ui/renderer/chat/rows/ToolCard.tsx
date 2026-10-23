/**
 * A tool call as one row that opens in place (docs/features/agent-sessions.md,
 * The chat). The card is the shell: the status glyph, the verb, the one-line
 * summary, the chips and the chevron, and the open and close motion. What the
 * row says and what it holds when open is the tool's renderer
 * (`tool-registry.ts`); when that has none, answers null, throws, or its body
 * throws as it is drawn, the card shows the generic view of the raw call
 * instead, so no call is ever hidden or breaks the chat.
 *
 * State shows by colour and glyph, never by an edge: pending pulses amber,
 * done wears the tool's glyph, an error is a destructive alert, a call the
 * person refused is a muted ban. `data-chat-state` says which, for tests and
 * for anything that styles from outside.
 */
import { Ban, ChevronDown, CircleAlert, Wrench } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Component, useId, useMemo, useState, type ReactNode } from 'react'
import { Button, Icon } from '@/primitives'
import { cn } from '@/plugin-api'
import type { ChatContext, ToolItem } from '../../../../agent/renderer/public'
import { nameOf } from './tools/coerce'
import { GenericBody, genericView } from './tools/generic'
import { Chip } from './tools/parts'
import { rendererFor } from './tool-registry'
import { stateOf, type CardView } from './tools/view'

/** Fisher UI's ease-out, for a row opening. */
const EASE_OUT = [0.16, 1, 0.3, 1] as const
/** Chips shown in the collapsed row; the rest are the first line of the body. */
const ROW_CHIPS = 3

const CHURN = /^\+(\d+) −(\d+)$/
const BAD_CHIP = /^(exit -?\d+|HTTP [45]\d\d|failed)/i

function usable(view: unknown): view is CardView {
  if (typeof view !== 'object' || view === null) return false
  const v = view as Partial<CardView>
  return typeof v.label === 'string' && typeof v.summary === 'string' && v.icon != null
}

/** The renderer's view of the call; the generic one when it has none or fails. */
function viewFor(item: ToolItem, ctx: ChatContext): CardView {
  try {
    const view: unknown = rendererFor(nameOf(item))?.(item, ctx)
    if (usable(view)) return view
  } catch {
    // The generic view below shows the raw call.
  }
  try {
    return genericView(item)
  } catch {
    return { label: 'Tool', icon: Wrench, summary: '', chips: [], body: null }
  }
}

/** A body that throws as it is drawn is replaced by the generic one. */
class BodyBoundary extends Component<{ item: ToolItem; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidUpdate(prev: { item: ToolItem }): void {
    if (prev.item !== this.props.item && this.state.failed) this.setState({ failed: false })
  }
  render(): ReactNode {
    return this.state.failed ? <GenericBody item={this.props.item} /> : this.props.children
  }
}

function Status({
  state,
  view,
}: {
  state: ReturnType<typeof stateOf>
  view: CardView
}): React.JSX.Element {
  const busy = state === 'pending' || (view.busy === true && state === 'done')
  return (
    <span className="grid size-4 shrink-0 place-items-center" data-chat-status={state}>
      {busy ? (
        <span className="size-1.5 motion-pulse rounded-full bg-[var(--fill-warm)]" />
      ) : state === 'error' ? (
        <Icon icon={CircleAlert} size="sm" className="text-destructive" />
      ) : state === 'rejected' ? (
        <Icon icon={Ban} size="sm" tone="muted" />
      ) : (
        <Icon icon={view.icon} size="sm" className={view.iconClass} />
      )}
    </span>
  )
}

function ChipText({ text }: { text: string }): React.JSX.Element {
  const churn = CHURN.exec(text)
  if (churn !== null) {
    return (
      <Chip>
        <span className="text-diff-added-foreground">{`+${churn[1]}`}</span>
        <span className="text-diff-removed-foreground">{`−${churn[2]}`}</span>
      </Chip>
    )
  }
  return <Chip tone={BAD_CHIP.test(text) ? 'bad' : 'default'}>{text}</Chip>
}

const STATE_WORD = {
  pending: 'Running',
  done: '',
  error: 'Failed',
  rejected: 'Declined',
} as const

export function ToolCard({ item, ctx }: { item: ToolItem; ctx: ChatContext }): React.JSX.Element {
  const reduce = useReducedMotion() ?? false
  const view = useMemo(() => viewFor(item, ctx), [item, ctx])
  const state = stateOf(item)
  const name = nameOf(item)
  // null: the card has not been toggled, so the tool's own default holds, and
  // follows the call as it changes (a command that fails opens itself).
  const [toggled, setToggled] = useState<boolean | null>(null)
  const bodyId = useId()

  const expandable = view.body !== null && view.body !== undefined && view.body !== false
  const open = expandable && (toggled ?? view.defaultOpen === true)

  const all = Array.isArray(view.chips) ? view.chips.filter((c) => typeof c === 'string') : []
  if (state === 'rejected' && !all.some((c) => /declin|reject|dismiss/i.test(c))) {
    all.push('declined')
  }
  const shown = all.slice(0, ROW_CHIPS)
  const more = all.slice(ROW_CHIPS)

  const head = (
    <>
      <Status state={state} view={view} />
      {STATE_WORD[state] !== '' && <span className="sr-only">{STATE_WORD[state]}</span>}
      <span
        className={cn(
          'max-w-[45%] shrink-0 truncate',
          state === 'error'
            ? 'text-destructive'
            : state === 'rejected'
              ? 'text-muted-foreground'
              : 'text-foreground/90',
        )}
      >
        {view.label}
      </span>
      {view.summary !== '' && (
        <span className="min-w-0 truncate font-mono text-xs">{view.summary}</span>
      )}
      {shown.map((chip, i) => (
        <ChipText key={i} text={chip} />
      ))}
    </>
  )

  return (
    <div className="text-sm" data-chat-tool={name} data-chat-state={state}>
      {expandable ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          className="h-auto min-h-7 w-full justify-start gap-2.5 rounded-lg px-1.5 py-1 font-normal text-muted-foreground"
          onClick={() => setToggled(!open)}
        >
          {head}
          <Icon
            icon={ChevronDown}
            size="sm"
            className={cn('ml-auto shrink-0 motion-respond', open && 'rotate-180')}
          />
        </Button>
      ) : (
        <div className="flex min-h-7 w-full items-center gap-2.5 px-1.5 py-1 text-muted-foreground">
          {head}
        </div>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={bodyId}
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.22, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <div className="mt-1 mb-1 ml-6 flex min-w-0 flex-col gap-2" data-chat-tool-body="">
              {more.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {more.map((chip, i) => (
                    <ChipText key={i} text={chip} />
                  ))}
                </div>
              )}
              <BodyBoundary item={item}>{view.body}</BodyBoundary>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
