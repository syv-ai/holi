/**
 * The Schedules section of the settings tab (docs/features/scheduled-agents.md):
 * the vault's scheduled agents, whether each runs on this machine, when it
 * runs next and how its last runs went.
 *
 * **Turning one on is an approval.** The switch approves what the file says
 * now: its prompt, model and the rules it may run without asking, which the
 * row shows beside it, the prompt itself whenever the switch would approve it
 * (off or changed), so nobody approves text they have not read. A file changed
 * since reads "changed" and does not run until it is switched on again. This
 * switch is the only way on: the agent has no command for it.
 *
 * Writing a schedule is the agent's (the `scheduled-agents` skill) or a
 * person's in the file itself; this section never edits one.
 */
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useState } from 'react'
import { SettingsHeading, SettingsList, SettingsNote, SettingsRow } from '@/composites'
import { capClient, cn, openNoteTabAtom } from '@/plugin-api'
import { Button, Switch, Tooltip } from '@/primitives'
import type { scheduleCapabilities } from '../main/schedules/capabilities'
import type { RunRecord, ScheduleSummary } from '../main/schedules/scheduler'
import { agentIndicator } from './lib/notices'
import { openSessionAtom } from './state/send'
import { agentSessionsAtom } from './state/sessions'

export const schedulesCap = capClient<ReturnType<typeof scheduleCapabilities>>('schedules')

/** Bumped by main's `schedules` event: a run started, or one was turned on or
 *  off. The section asks again when it moves. */
export const schedulesEpochAtom = atom(0)

/** How often an open section asks again anyway: a file edited by hand sends
 *  no event, and "next run" moves on its own. */
const REFRESH_MS = 30_000

const STATUS_WORD: Record<ScheduleSummary['status'], string> = {
  on: 'on',
  off: 'off',
  changed: 'changed',
  invalid: 'invalid',
}

const STATUS_TIP: Record<ScheduleSummary['status'], string> = {
  on: 'Runs on this machine while this vault is open.',
  off: 'Does not run on this machine.',
  changed:
    'Its prompt, model or allowed tools changed since it was turned on. Switch it on again to approve the new version.',
  invalid: 'The file does not parse, so it cannot run.',
}

function when(iso: string | undefined): string | null {
  if (iso === undefined) return null
  const d = new Date(iso)
  const today = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return time
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

function runWords(run: RunRecord): string {
  const at = when(run.at) ?? ''
  if (run.outcome === 'started') {
    const how =
      run.trigger === 'manual'
        ? ' by hand'
        : run.trigger === 'event' && run.cause !== undefined
          ? ` on ${run.cause}`
          : ''
    if (run.finishedAt === undefined) return `${at} started${how}, running`
    const done = when(run.finishedAt) ?? ''
    return run.kept === true
      ? `${at} ran${how}, done ${done}, left open in your window`
      : `${at} ran${how}, done ${done}`
  }
  if (run.outcome === 'skipped') return `${at} skipped: ${run.message ?? ''}`
  return `${at} failed: ${run.message ?? ''}`
}

function StatusChip({ status }: { status: ScheduleSummary['status'] }): React.JSX.Element {
  return (
    <Tooltip content={STATUS_TIP[status]}>
      {/* A chip, so `--border` like the settings tab's layer badge. */}
      <span
        className={cn(
          'rounded border border-border px-1.5 py-0.5 text-[10px] leading-4',
          status === 'on' ? 'text-brand' : 'text-muted-foreground',
          status === 'changed' || status === 'invalid' ? 'text-destructive' : null,
        )}
      >
        {STATUS_WORD[status]}
      </span>
    </Tooltip>
  )
}

function ScheduleRow({
  remote,
  schedule,
  onChange,
}: {
  remote: string
  schedule: ScheduleSummary
  onChange: () => void
}): React.JSX.Element {
  const openNote = useSetAtom(openNoteTabAtom)
  const openSession = useSetAtom(openSessionAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      onChange()
    }
  }

  const on = schedule.status === 'on'
  const ref = { schedule: schedule.path }
  const session = sessions.find((s) => s.id === schedule.live?.id)
  const next = when(schedule.nextRun)
  const last = schedule.runs[0]

  return (
    <SettingsRow
      label={schedule.name}
      meta={<StatusChip status={schedule.status} />}
      description={
        schedule.error ??
        [schedule.when, next === null ? null : `next ${next}`].filter(Boolean).join(' · ')
      }
      control={
        <div className="flex items-center gap-2">
          {on && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => void act(() => schedulesCap.run(remote, ref))}
            >
              Run now
            </Button>
          )}
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            Runs here
            <Switch
              checked={on}
              disabled={busy || schedule.status === 'invalid'}
              onCheckedChange={(v) =>
                void act(() =>
                  v
                    ? schedulesCap.enable(remote, {
                        ...ref,
                        fingerprint: schedule.fingerprint ?? '',
                      })
                    : schedulesCap.disable(remote, ref),
                )
              }
            />
          </label>
        </div>
      }
    >
      <div className="space-y-1 text-[11px] text-muted-foreground">
        {schedule.allow !== undefined && (
          <p>
            {schedule.allow.length === 0 ? 'Asks before every tool it uses.' : 'Without asking: '}
            {schedule.allow.map((rule) => (
              <code key={rule} className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px]">
                {rule}
              </code>
            ))}
            {schedule.model !== undefined && <span> · model {schedule.model}</span>}
          </p>
        )}
        {!on && schedule.prompt !== undefined && (
          <div className="space-y-1">
            <p>
              {schedule.status === 'changed'
                ? 'The prompt now, which switching it on approves:'
                : 'Switching it on approves this prompt:'}
            </p>
            <pre className="max-h-48 overflow-auto rounded bg-muted px-2 py-1.5 font-mono text-[10px] whitespace-pre-wrap text-foreground">
              {schedule.prompt}
            </pre>
          </div>
        )}
        {last !== undefined && <p>Last: {runWords(last)}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="link"
            className="h-auto p-0 text-[11px] font-normal"
            onClick={() => openNote(schedule.path)}
          >
            Open {schedule.path}
          </Button>
          {session !== undefined && (
            <Button
              variant="link"
              className="h-auto gap-1.5 p-0 text-[11px] font-normal"
              onClick={() => void openSession(session.id)}
            >
              <span className={cn('size-1.5 rounded-full', agentIndicator(session).dot)} />
              Open the latest run ({agentIndicator(session).state})
            </Button>
          )}
        </div>
        {error !== null && <p className="text-destructive">{error}</p>}
      </div>
    </SettingsRow>
  )
}

export function SchedulesSection({ remote }: { remote: string }): React.JSX.Element {
  const epoch = useAtomValue(schedulesEpochAtom)
  const [schedules, setSchedules] = useState<ScheduleSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    schedulesCap
      .list(remote)
      .then((list) => {
        setSchedules(list)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [remote])

  useEffect(() => {
    load()
  }, [load, epoch])

  useEffect(() => {
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [load])

  return (
    <section>
      <SettingsHeading
        title="Scheduled agents"
        blurb="Your prompts Holi runs as agent sessions at set times, on this machine, while this vault is open. Each one is a .local.md file in .holi/schedules/, never synced."
      />
      {error !== null && <SettingsNote className="text-destructive">{error}</SettingsNote>}
      {schedules !== null && schedules.length === 0 && (
        <SettingsNote className="py-3">
          None yet. Ask the agent for one, for example: “Every 30 minutes on weekdays, check my new
          mail, draft replies to what you can answer and make a task for anything I have to do.”
        </SettingsNote>
      )}
      {schedules !== null && schedules.length > 0 && (
        <SettingsList>
          {schedules.map((s) => (
            <ScheduleRow key={s.path} remote={remote} schedule={s} onChange={load} />
          ))}
        </SettingsList>
      )}
    </section>
  )
}
