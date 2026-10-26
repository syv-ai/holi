/**
 * The wizard's steps (docs/features/holis.md, The wizard): two that explain
 * what a Holi is and how it gets work, then who it is, what it does, what it
 * may do without asking, an optional habit, and a review. Each is a body for
 * the block's step panel; the wizard owns the draft and the footer.
 */
import {
  ArrowRight,
  Clock,
  FileText,
  IdCard,
  MessageSquareReply,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  StickyNote,
  Terminal,
  X,
} from 'lucide-react'
import { cloneElement, isValidElement, useId, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/reui/alert'
import {
  HOLI_COLOURS,
  HOLI_MASCOTS,
  HOLI_MASCOT_LABELS,
  holiRuleError,
  holiSlug,
  type HoliMascot,
} from '@holi/shared'
import { DAYS, habitCron, nextHabitRun, TIMES, type WizardDraft } from './draft'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import { Badge } from '@/components/reui/badge'
import { Frame, FramePanel } from '@/components/reui/frame'
import { IconButton } from '@/composites/icon-button'
import { IconTile } from '@/components/reui/icon-tile'
import { Input } from '@/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'

/** A captioned control. The caption names the control: `Input`, `Textarea` and
 *  `Switch` are linked to it by id, the rest carry their own `aria-label`. */
function FormField({
  label,
  required,
  error,
  orientation = 'vertical',
  children,
}: {
  label: string
  required?: boolean
  error?: string
  orientation?: 'vertical' | 'horizontal'
  children: React.ReactElement<{ id?: string }>
}): React.JSX.Element {
  const id = useId()
  const linkable =
    isValidElement(children) && [Input, Textarea, Switch].includes(children.type as never)
  const control = linkable ? cloneElement(children, { id }) : children
  const caption = (
    <>
      {label}
      {required === true && <span className="text-destructive"> *</span>}
    </>
  )
  return (
    <Field orientation={orientation}>
      <FieldLabel
        htmlFor={linkable ? id : undefined}
        className="text-xs font-normal text-muted-foreground"
      >
        {caption}
      </FieldLabel>
      {orientation === 'horizontal' ? (
        <div className="flex flex-1 justify-end">{control}</div>
      ) : (
        control
      )}
      {error !== undefined && <FieldError>{error}</FieldError>}
    </Field>
  )
}

/** The heading every step opens with, as the block's `StepHeading`. */
export function StepHeading({
  title,
  description,
}: {
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <h2 className="text-xl font-semibold tracking-tight text-balance text-foreground">{title}</h2>
      <p className="text-sm text-pretty text-muted-foreground">{description}</p>
    </div>
  )
}

/** One row of an explaining list: its mark, a title, a line, and maybe the
 *  file it lives in. */
function Fact({
  icon: Glyph,
  title,
  file,
  children,
}: {
  icon: typeof Clock
  title: string
  file?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <FramePanel className="flex items-start gap-3">
      <IconTile size="sm">
        <Glyph className="size-3.5" />
      </IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {file !== undefined && <Badge variant="outline">{file}</Badge>}
        </div>
        <p className="text-xs text-pretty text-muted-foreground">{children}</p>
      </div>
    </FramePanel>
  )
}

// ── 1. What a Holi is ─────────────────────────────────────────────────────

export function WhatStep(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <div aria-hidden="true" className="flex items-end justify-center gap-3">
        {HOLI_MASCOTS.slice(0, 5).map((m, i) => (
          <PixelPersona
            key={m}
            name={m}
            color={HOLI_COLOURS[i % HOLI_COLOURS.length]!}
            crop="full"
            scale={i === 2 ? 2 : 1}
            still={i !== 2}
          />
        ))}
      </div>
      <Frame stacked spacing="sm">
        <Fact icon={IdCard} title="A name and a face" file="holi.yaml">
          What it is called and how it looks, which documents it takes, and what it may do without
          asking you.
        </Fact>
        <Fact icon={Sparkles} title="A soul" file="SOUL.md">
          Its standing instructions: who it is and what it always keeps in mind. Every run reads it
          first.
        </Fact>
        <Fact icon={StickyNote} title="A memory" file="MEMORY.md">
          What it learns, one dated fact a line. Its runs keep it; it reaches them as notes, never
          as instructions.
        </Fact>
      </Frame>
      <p className="text-xs text-muted-foreground">
        All three live in <code className="font-mono">.holi/holis/&lt;its name&gt;/</code> and sync
        with the vault, so everyone who shares the vault shares its Holis.
      </p>
    </div>
  )
}

// ── 2. How it gets work ───────────────────────────────────────────────────

function Way({
  icon: Glyph,
  title,
  example,
  children,
}: {
  icon: typeof Clock
  title: string
  example: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <FramePanel className="flex flex-col gap-3">
      <IconTile size="sm">
        <Glyph className="size-3.5" />
      </IconTile>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{title}</span>
        <p className="text-xs text-pretty text-muted-foreground">{children}</p>
      </div>
      <Badge variant="outline" className="mt-auto">
        {example}
      </Badge>
    </FramePanel>
  )
}

/** One stop on a run's path, for the small diagram under the two ways. */
function Stop({ icon: Glyph, label }: { icon: typeof Clock; label: string }): React.JSX.Element {
  return (
    <li className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
      <IconTile size="xs" variant="elevated">
        <Glyph className="size-3.5" />
      </IconTile>
      <span className="text-xs text-muted-foreground">{label}</span>
    </li>
  )
}

export function WorkStep(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <Frame spacing="sm" className="grid grid-cols-2">
        <Way icon={Send} title="Sent" example="Agent ▾ → Send to Holi">
          You send it a document from the menu beside a document's Agent button. It is offered the
          documents it takes, like <code className="font-mono">kunder/**/*.md</code>.
        </Way>
        <Way icon={Clock} title="On a schedule" example="Every weekday at 08:00">
          Habits: automations on a clock that it carries out, like a morning digest. Each machine
          turns a habit on for itself.
        </Way>
      </Frame>
      <div className="flex flex-col gap-3">
        <span className="text-xs font-medium text-muted-foreground">Every run</span>
        <ol aria-label="Every run" className="flex items-start gap-1">
          <Stop icon={Sparkles} label="Its soul, memory and rules" />
          <ArrowRight className="size-3.5 text-muted-foreground mt-1.5 shrink-0" />
          <Stop icon={Terminal} label="Claude Code in the vault" />
          <ArrowRight className="size-3.5 text-muted-foreground mt-1.5 shrink-0" />
          <Stop icon={ShieldCheck} label="Asks you what its rules do not allow" />
          <ArrowRight className="size-3.5 text-muted-foreground mt-1.5 shrink-0" />
          <Stop icon={MessageSquareReply} label="Reports what came of it" />
        </ol>
      </div>
      <p className="text-xs text-pretty text-muted-foreground">
        A Holi that is new here, or whose soul or rules changed, runs only after this machine
        approved what it says.
      </p>
    </div>
  )
}

/** A caption over a group of controls, where a wrapping label would steal
 *  their presses. */
function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

// ── 3. Who it is ──────────────────────────────────────────────────────────

export function WhoStep({
  draft,
  set,
}: {
  draft: WizardDraft
  set: (patch: Partial<WizardDraft>) => void
}): React.JSX.Element {
  const name = draft.name ?? HOLI_MASCOT_LABELS[draft.mascot]
  const nameError =
    draft.name !== undefined && holiSlug(draft.name) === ''
      ? 'Give it a name with a letter or a digit in it.'
      : undefined
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <span className="flex size-20 shrink-0 items-center justify-center rounded-full bg-foreground/[0.04]">
          <PixelPersona name={draft.mascot} color={draft.color} crop="full" scale={2} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <FormField label="Name" required error={nameError}>
            <Input
              aria-label="Name"
              maxLength={40}
              value={name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </FormField>
        </div>
      </div>
      <Labelled label="Face">
        <ToggleGroup
          type="single"
          size="sm"
          spacing={1}
          aria-label="Face"
          className="grid grid-cols-5"
          value={draft.mascot}
          onValueChange={(m) => m !== '' && set({ mascot: m as HoliMascot })}
        >
          {HOLI_MASCOTS.map((m) => (
            <ToggleGroupItem key={m} value={m} aria-label={HOLI_MASCOT_LABELS[m]}>
              <PixelPersona name={m} color={draft.color} still />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Labelled>
      <Labelled label="Colour">
        <ToggleGroup
          type="single"
          size="sm"
          spacing={1}
          aria-label="Colour"
          className="grid grid-cols-6"
          value={draft.color}
          onValueChange={(c) => c !== '' && set({ color: c })}
        >
          {HOLI_COLOURS.map((c) => (
            <ToggleGroupItem key={c} value={c} aria-label={`Colour ${c}`}>
              {/* The Holi's own colour: categorical identity, as data. */}
              <span className="size-4 rounded-full" style={{ backgroundColor: c }} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Labelled>
      <FormField label="Short description">
        <Input
          aria-label="Short description"
          placeholder="Turns a customer note into a PDF proposal"
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </FormField>
    </div>
  )
}

// ── 4. What it does ───────────────────────────────────────────────────────

/** Claude Code's model aliases, as the settings offer them. */
const MODELS = [
  { value: 'default', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

export function DoesStep({
  draft,
  set,
}: {
  draft: WizardDraft
  set: (patch: Partial<WizardDraft>) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <FormField label="Soul">
        <Textarea
          aria-label="Soul"
          className="min-h-40 text-sm"
          placeholder={
            'You write proposals for our customers.\n- Lay them out as tilbud/template.md.\n- Ask before quoting a price that is not in the price list.'
          }
          value={draft.soul}
          onChange={(e) => set({ soul: e.target.value })}
        />
      </FormField>
      <p className="-mt-4 text-xs text-muted-foreground">
        Who it is and what it should always keep in mind. Left empty, it starts with a heading for
        you to fill in later.
      </p>
      <FormField label="Documents it takes">
        <Textarea
          aria-label="Documents it takes"
          className="min-h-20 font-mono text-xs"
          placeholder="kunder/**/*.md"
          value={draft.accepts}
          onChange={(e) => set({ accepts: e.target.value })}
        />
      </FormField>
      <p className="-mt-4 text-xs text-muted-foreground">
        Vault paths, one a line: <code className="font-mono">**</code> any folders,{' '}
        <code className="font-mono">*</code> within a name. Empty: any document.
      </p>
      <FormField label="Model" orientation="horizontal">
        <Select value={draft.model} onValueChange={(v) => set({ model: v })}>
          <SelectTrigger size="sm" className="w-36" aria-label="Model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODELS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
    </div>
  )
}

// ── 5. What it may do ─────────────────────────────────────────────────────

/** A folder as the rule that lets a run write in it. */
export function folderRule(folder: string): string {
  const clean = folder.trim().replace(/^\/+|\/+$/g, '')
  return `Edit(${clean}/**)`
}

function AddField({
  label,
  placeholder,
  button,
  toRule,
  onAdd,
}: {
  label: string
  placeholder: string
  button: string
  toRule: (text: string) => string
  onAdd: (rule: string) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const add = () => {
    if (text.trim() === '') return
    const rule = toRule(text)
    const refused = holiRuleError(rule)
    if (refused !== null) {
      setError(refused.replace(/`/g, ''))
      return
    }
    onAdd(rule)
    setText('')
    setError(undefined)
  }
  return (
    <FormField label={label} error={error}>
      <InputGroup>
        <InputGroupInput
          aria-label={label}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError(undefined)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton onClick={add}>
            <Plus className="size-3.5" />
            {button}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </FormField>
  )
}

export function MayStep({
  draft,
  set,
}: {
  draft: WizardDraft
  set: (patch: Partial<WizardDraft>) => void
}): React.JSX.Element {
  const add = (rule: string) => {
    if (!draft.allow.includes(rule)) set({ allow: [...draft.allow, rule] })
  }
  return (
    <div className="flex flex-col gap-6">
      <Frame stacked spacing="sm">
        <Fact icon={ShieldCheck} title="Everything else asks you">
          A run uses Claude Code's own permission prompts. What is not listed here, it asks you
          first, in the Agents view or the Inbox when you are away.
        </Fact>
        <Fact icon={FileText} title="Name the folders it writes">
          A bare Edit or Write is refused: a run that could write anywhere could rewrite AGENTS.md,
          .holi/ or .claude/, and through them every later run.
        </Fact>
        <Fact icon={StickyNote} title="Its memory is always allowed">
          Keeping its own memory never asks: those commands redact anything that looks like a
          credential.
        </Fact>
      </Frame>
      <AddField
        label="A folder it may write"
        placeholder="tilbud"
        button="Allow"
        toRule={folderRule}
        onAdd={add}
      />
      <AddField
        label="Another Claude Code rule"
        placeholder="Bash(holi google read:*)"
        button="Add"
        toRule={(t) => t.trim()}
        onAdd={add}
      />
      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">Allowed without asking</span>
        {draft.allow.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet: it asks before each action.</p>
        ) : (
          <ul aria-label="Allowed without asking" className="flex flex-wrap gap-2">
            {draft.allow.map((rule) => (
              <li key={rule}>
                <Badge variant="secondary" size="lg" className="gap-1 pe-0.5 font-mono">
                  {rule}
                  <IconButton
                    size="icon-xs"
                    label={`Remove ${rule}`}
                    onClick={() => set({ allow: draft.allow.filter((r) => r !== rule) })}
                  >
                    <X />
                  </IconButton>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── 6. Habits ─────────────────────────────────────────────────────────────

const KINDS = [
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
] as const

const nextLabel = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

export function HabitStep({
  draft,
  set,
}: {
  draft: WizardDraft
  set: (patch: Partial<WizardDraft>) => void
}): React.JSX.Element {
  const habit = draft.habit
  const put = (patch: Partial<WizardDraft['habit']>) => set({ habit: { ...habit, ...patch } })
  const next = habit.on ? nextHabitRun(habitCron(habit)) : null
  return (
    <div className="flex flex-col gap-6">
      <FormField label="Give it a habit" orientation="horizontal">
        <Switch
          aria-label="Give it a habit"
          checked={habit.on}
          onCheckedChange={(on) => put({ on })}
        />
      </FormField>
      {habit.on ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Clock className="size-3.5 text-muted-foreground" />
            <Select
              value={habit.kind}
              onValueChange={(k) => put({ kind: k as WizardDraft['habit']['kind'] })}
            >
              <SelectTrigger size="sm" className="w-auto" aria-label="How often">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {habit.kind === 'weekly' && (
              <>
                on
                <Select value={String(habit.day)} onValueChange={(d) => put({ day: Number(d) })}>
                  <SelectTrigger size="sm" className="w-auto" aria-label="Day">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DAYS.map((d, i) => (
                      <SelectItem key={d} value={String(i)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
            at
            <Select value={habit.time} onValueChange={(time) => put({ time })}>
              <SelectTrigger size="sm" className="w-auto" aria-label="Time">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {next !== null && (
              <span className="text-xs text-muted-foreground tabular-nums">
                Next: {nextLabel.format(next)}
              </span>
            )}
          </div>
          <FormField label="What it does each time" required>
            <Textarea
              aria-label="What it does each time"
              className="min-h-28 text-sm"
              placeholder="Look through what changed in kunder/ since the previous run and write a short digest to Notes/digest.md."
              value={habit.prompt}
              onChange={(e) => put({ prompt: e.target.value })}
            />
          </FormField>
          <Alert>
            <ShieldCheck className="size-3.5" />
            <AlertTitle>Written switched off</AlertTitle>
            <AlertDescription>
              Turn it on in Automations on the machine that should run it: that approves the habit
              and this Holi there. Every machine that turns it on runs it.
            </AlertDescription>
          </Alert>
        </>
      ) : (
        <p className="text-sm text-pretty text-muted-foreground">
          No habit: it works when someone sends it a document. You can add habits later from its
          page.
        </p>
      )}
    </div>
  )
}

// ── 7. Review and create ──────────────────────────────────────────────────

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <FramePanel className="flex items-start gap-4">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1 text-sm break-words">{children}</div>
    </FramePanel>
  )
}

export function ReviewStep({
  draft,
  habits,
}: {
  draft: WizardDraft
  habits: boolean
}): React.JSX.Element {
  const name = (draft.name ?? HOLI_MASCOT_LABELS[draft.mascot]).trim()
  const accepts = lines(draft.accepts)
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <PixelPersona name={draft.mascot} color={draft.color} crop="full" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {draft.description.trim() === '' ? 'No description' : draft.description.trim()}
          </span>
        </div>
      </div>
      <Frame stacked spacing="sm">
        <Line label="Soul">
          <p className="line-clamp-4 whitespace-pre-wrap">
            {draft.soul.trim() === '' ? 'A heading to fill in later' : draft.soul.trim()}
          </p>
        </Line>
        <Line label="Takes">
          {accepts.length === 0 ? (
            'Any document'
          ) : (
            <code className="font-mono text-xs">{accepts.join(', ')}</code>
          )}
        </Line>
        <Line label="Without asking">
          {draft.allow.length === 0 ? (
            'Nothing: it asks before each action'
          ) : (
            <code className="font-mono text-xs">{draft.allow.join(', ')}</code>
          )}
        </Line>
        <Line label="Model">{draft.model === 'default' ? 'Default' : draft.model}</Line>
        {habits && (
          <Line label="Habit">
            {draft.habit.on
              ? `${KINDS.find((k) => k.value === draft.habit.kind)?.label ?? ''}${draft.habit.kind === 'weekly' ? ` on ${DAYS[draft.habit.day]}` : ''} at ${draft.habit.time}, written off`
              : 'None'}
          </Line>
        )}
      </Frame>
      <p className="text-xs text-pretty text-muted-foreground">
        Creating writes its folder to the vault. Then you approve it on this machine: until you do,
        nothing runs.
      </p>
    </div>
  )
}

/** A field of one entry a line, as a list. */
export function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}
