/**
 * One automation, after MonoCode's automation editor (MIT, Copyright (c) 2026
 * Nick; see ../../holis/NOTICE.md), top to bottom:
 *
 * - Its name, with Cancel or Reset, Run now and Create or Save; under it the
 *   Active switch (runs on this machine) and who carries it out (`HoliPicker`).
 * - **Triggers**: each a sentence ("Every weekday at [11:00]"), the time zone
 *   and the next run; Add trigger. A cron no sentence says stays as written.
 *   The events that start it (`on:`) are sentences too ("When a file is
 *   [added] in [inbox/**]"), read and written the way main runs them.
 * - **Instructions**: the prompt, with its model and what it may do without
 *   asking under it.
 * - **Advanced**: the catch-up window for missed runs.
 * - **Run history**, for one that exists.
 *
 * Writing it approves nothing: Active is the approval (`schedules.enable`, at
 * the UI door), sent the fingerprint of what was just written or shown, so it
 * approves exactly that. With a Holi, that covers the Holi's soul and rules
 * too; a change to either reads Changed and waits to be turned on again.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronDown, Ellipsis, Play, Plus, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { activeRemoteAtom, cn } from '@/plugin-api'
import { cronOfTrigger } from '@holi/shared'
import { HoliPicker } from './holi-picker'
import { schedulesCap, type ScheduleSummary } from './schedules-cap'
import { selectAutomationAtom } from './state'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Frame, FramePanel } from '@/components/reui/frame'
import { IconButton } from '@/composites/icon-button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { type Draft, same } from './automation-draft'
import { cronFor, Pill, KINDS, retype, TriggerRow } from './automation-triggers'
import { EVENTS, eventError, EventRow } from './automation-events'
import { RunHistory } from './automation-run-history'

const MODELS = [
  { value: 'default', label: 'Default model' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

/** How late a missed run may still start. Absent in the file: always, once. */
const CATCH_UP = [
  { value: 'always', label: 'Always, once' },
  { value: '0', label: 'Do not catch up' },
  { value: '30', label: '30 minutes' },
  { value: '120', label: '2 hours' },
  { value: '720', label: '12 hours' },
  { value: '1440', label: '24 hours' },
]

/** What it may do without asking, one rule a line, in a pill's popover. */
function AllowPill({
  allow,
  onChange,
}: {
  allow: string[]
  onChange: (allow: string[]) => void
}): React.JSX.Element {
  const [text, setText] = useState(allow.join('\n'))
  return (
    <Popover onOpenChange={(open) => open && setText(allow.join('\n'))}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="xs">
          <ShieldCheck className="size-3.5" />
          {allow.length === 0 ? 'Asks for everything' : `${allow.length} allowed`}
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <p className="text-xs text-muted-foreground">
          Claude Code rules it may use without asking, one a line. Name the folders it writes:{' '}
          <code className="font-mono">Edit(tilbud/**)</code>, never a bare Edit. Everything else
          asks you.
        </p>
        <Textarea
          aria-label="Allowed without asking"
          className="min-h-28 font-mono text-xs"
          placeholder={'Bash(holi google read:*)\nEdit(**/task.*.md)'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() =>
            onChange(
              text
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l !== ''),
            )
          }
        />
      </PopoverContent>
    </Popover>
  )
}

export function AutomationEditor({
  summary,
  initial,
}: {
  /** The automation as main reads it; absent for a new one. */
  summary?: ScheduleSummary
  initial: Draft
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const select = useSetAtom(selectAutomationAtom)
  const [draft, setDraft] = useState<Draft>(initial)
  // Main read it again (a save, a run, a pull): follow it, unless something
  // is typed over what was there.
  const shown = useRef(initial)
  useEffect(() => {
    if (same(draft, shown.current)) setDraft(initial)
    shown.current = initial
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [removing, setRemoving] = useState(false)
  const dirty = !same(draft, initial)
  const isNew = summary === undefined
  const triggerErrors = [
    ...draft.triggers.map((t) => cronFor(t).error),
    ...draft.on.map(eventError),
  ].filter(Boolean)
  const triggerCount = draft.triggers.length + draft.on.length
  const canSave =
    draft.name.trim() !== '' &&
    draft.prompt.trim() !== '' &&
    triggerCount > 0 &&
    triggerErrors.length === 0 &&
    (isNew || dirty)

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err))

  async function apply(fn: () => Promise<void>) {
    if (remote === null) return
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  /** Write the file, then make Active true of it: turning on approves what
   *  was just written, by the fingerprint main answered with. */
  const save = () =>
    apply(async () => {
      const saved = await schedulesCap.save(remote!, {
        ...(summary === undefined ? {} : { path: summary.path }),
        draft: {
          name: draft.name.trim(),
          crons: draft.triggers.map((t) => cronOfTrigger(t)),
          on: draft.on,
          prompt: draft.prompt,
          allow: draft.allow,
          ...(draft.holi === undefined ? {} : { holi: draft.holi }),
          ...(draft.model === undefined ? {} : { model: draft.model }),
          ...(draft.catchUpMinutes === undefined ? {} : { catchUpMinutes: draft.catchUpMinutes }),
        },
      })
      if (draft.active && saved.status !== 'on' && saved.fingerprint !== undefined) {
        await schedulesCap.enable(remote!, {
          schedule: saved.path,
          fingerprint: saved.fingerprint,
        })
      } else if (!draft.active && saved.status === 'on') {
        await schedulesCap.disable(remote!, { schedule: saved.path })
      }
      select(saved.path)
    })

  /** The switch on a saved, unchanged automation acts at once; otherwise it
   *  is part of what Save writes. */
  const toggle = (on: boolean) => {
    set({ active: on })
    if (summary === undefined || dirty) return
    void apply(async () => {
      if (on) {
        if (summary.fingerprint === undefined) throw new Error(summary.error ?? 'It cannot run.')
        await schedulesCap.enable(remote!, {
          schedule: summary.path,
          fingerprint: summary.fingerprint,
        })
      } else await schedulesCap.disable(remote!, { schedule: summary.path })
    })
  }

  const header = (
    <div className="flex shrink-0 flex-col gap-2.5 border-b border-divider">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-2.5 px-8 pt-5 pb-4">
        <div className="flex items-start gap-6">
          <Input
            autoFocus={isNew}
            aria-label="Automation name"
            placeholder="Untitled"
            className="min-w-0 flex-1 bg-transparent text-xl font-semibold tracking-tight"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
          />
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {(isNew || dirty) && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => (isNew ? select('list') : setDraft(initial))}
              >
                {isNew ? 'Cancel' : 'Reset'}
              </Button>
            )}
            {!isNew && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || summary.status !== 'on' || dirty}
                onClick={() =>
                  void apply(async () => {
                    await schedulesCap.run(remote!, { schedule: summary.path })
                  })
                }
              >
                <Play className="size-3.5" />
                Run now
              </Button>
            )}
            <Button size="sm" disabled={busy || !canSave} onClick={() => void save()}>
              {isNew ? 'Create' : 'Save'}
            </Button>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={draft.active}
            aria-label="Active on this machine"
            disabled={busy}
            onCheckedChange={toggle}
          />
          <span>
            {summary?.status === 'changed' && !dirty
              ? 'Changed: turn it on again to approve'
              : draft.active
                ? 'Active'
                : 'Inactive'}
          </span>
          <span aria-hidden="true" className="ms-2 h-3 w-px bg-divider" />
          <HoliPicker
            value={draft.holi}
            onChange={(holi) =>
              setDraft(({ holi: _old, ...d }) => (holi === undefined ? d : { ...d, holi }))
            }
          />
          {!isNew && (
            <>
              <span aria-hidden="true" className="h-3 w-px bg-divider" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton label="More" size="icon-xs">
                    <Ellipsis />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
                    Delete automation…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
        {removing && summary !== undefined && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 text-muted-foreground">
              Delete “{summary.name}”? Its file leaves the vault for everyone; git keeps it.
            </span>
            <Button size="xs" variant="ghost" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void apply(async () => {
                  await schedulesCap.remove(remote!, { schedule: summary.path })
                  select('list')
                })
              }
            >
              Delete
            </Button>
          </div>
        )}
        {(error ?? (summary?.status === 'invalid' ? summary.error : undefined)) !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {error ?? summary?.error}
          </p>
        )}
      </div>
    </div>
  )

  const settings = (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-8 py-5 pb-10">
      <section aria-label="Triggers" className="flex flex-col gap-3">
        <h2 className="px-1 text-xs font-medium text-muted-foreground">Triggers</h2>
        <Frame stacked spacing="sm">
          {triggerCount > 0 && (
            <FramePanel>
              <ul className="flex flex-col">
                {draft.triggers.map((t, i) => (
                  <TriggerRow
                    key={i}
                    trigger={t}
                    onChange={(next) =>
                      set({ triggers: draft.triggers.map((x, j) => (j === i ? next : x)) })
                    }
                    onRemove={() => set({ triggers: draft.triggers.filter((_, j) => j !== i) })}
                  />
                ))}
                {draft.on.map((t, i) => (
                  <EventRow
                    key={`on-${i}`}
                    trigger={t}
                    onChange={(next) => set({ on: draft.on.map((x, j) => (j === i ? next : x)) })}
                    onRemove={() => set({ on: draft.on.filter((_, j) => j !== i) })}
                  />
                ))}
              </ul>
            </FramePanel>
          )}
          <FramePanel flush>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="lg"
                  className="w-full justify-start font-normal text-muted-foreground hover:text-foreground"
                  disabled={triggerCount >= 20}
                >
                  <Plus className="size-3.5" />
                  Add trigger
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>On a schedule</DropdownMenuLabel>
                {KINDS.map((k) => (
                  <DropdownMenuItem
                    key={k.value}
                    onSelect={() =>
                      set({
                        triggers: [
                          ...draft.triggers,
                          retype({ kind: 'weekdays', time: '09:00' }, k.value),
                        ],
                      })
                    }
                  >
                    {k.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>On an event</DropdownMenuLabel>
                {EVENTS.map((e) => (
                  <DropdownMenuItem
                    key={e.label}
                    onSelect={() => set({ on: [...draft.on, e.trigger] })}
                  >
                    {e.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </FramePanel>
        </Frame>
        {triggerCount === 0 && (
          <p className="px-1 text-xs text-muted-foreground">
            Add a trigger: an automation runs only when one comes due or happens.
          </p>
        )}
        {summary?.at !== undefined && (
          <p className="px-1 text-xs text-muted-foreground">
            Its file names one moment, {summary.at.replace('T', ' ')}; saving here replaces it with
            these triggers.
          </p>
        )}
      </section>

      <section aria-label="Instructions" className="flex flex-col gap-3">
        <h2 className="px-1 text-xs font-medium text-muted-foreground">Instructions</h2>
        <Frame spacing="sm">
          <FramePanel flush className="flex flex-col">
            <Textarea
              aria-label="Instructions"
              className="min-h-56 resize-y bg-transparent text-sm"
              placeholder="What it should do on each run, and what to leave in the vault for you."
              value={draft.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
            />
            <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
              <Select
                value={draft.model ?? 'default'}
                onValueChange={(v) =>
                  setDraft(({ model: _old, ...d }) => (v === 'default' ? d : { ...d, model: v }))
                }
              >
                <SelectTrigger size="sm" aria-label="Model" className="w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    ...MODELS,
                    ...(draft.model !== undefined && !MODELS.some((m) => m.value === draft.model)
                      ? [{ value: draft.model, label: draft.model }]
                      : []),
                  ].map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AllowPill allow={draft.allow} onChange={(allow) => set({ allow })} />
            </div>
          </FramePanel>
        </Frame>
        <p className="px-1 text-xs text-muted-foreground">
          Skills, @file references and built-in commands work here.
          {draft.holi !== undefined &&
            ' Its Holi adds its soul, its memory and its own rules to every run.'}
        </p>
      </section>

      <Frame spacing="sm">
        <FramePanel flush className="flex flex-col">
          <Button
            variant="ghost"
            className="h-auto w-full justify-between text-start font-normal"
            aria-expanded={advanced}
            onClick={() => setAdvanced((v) => !v)}
          >
            <span className="flex flex-col gap-0.5 py-1">
              <span className="text-sm font-medium text-foreground">Advanced</span>
              <span className="text-xs text-muted-foreground">Catch-up window for missed runs</span>
            </span>
            <ChevronDown
              className={cn(
                'size-3.5 text-muted-foreground',
                cn('motion-respond', advanced && 'rotate-180'),
              )}
            />
          </Button>
          {advanced && (
            <div className="flex items-center justify-between gap-4 border-t border-divider px-(--frame-panel-px) py-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">Missed runs</span>
                <span className="text-xs text-muted-foreground">
                  How late a run this machine slept through may still start
                </span>
              </span>
              <Pill
                label="Catch-up window"
                value={draft.catchUpMinutes === undefined ? 'always' : String(draft.catchUpMinutes)}
                options={CATCH_UP}
                onChange={(v) =>
                  setDraft(({ catchUpMinutes: _old, ...d }) =>
                    v === 'always' ? d : { ...d, catchUpMinutes: Number(v) },
                  )
                }
              />
            </div>
          )}
        </FramePanel>
      </Frame>
    </div>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-automation={summary?.path ?? 'new'}>
      {header}
      {isNew ? (
        <div className="min-h-0 flex-1 overflow-y-auto">{settings}</div>
      ) : (
        <Tabs defaultValue="settings" className="flex min-h-0 flex-1 flex-col">
          <div className="mx-auto w-full max-w-4xl px-8 pt-3">
            <TabsList>
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="history">Run history</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="settings" className="min-h-0 flex-1 overflow-y-auto">
            {settings}
          </TabsContent>
          <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-8 py-5">
              <RunHistory runs={summary.runs} />
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
