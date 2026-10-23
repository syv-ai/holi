/**
 * A Holi's runs, newest first (docs/features/holis.md, A Holi's page): the
 * document each took and when, what came of it (needs you, working, changed
 * files, its report), and what to do about it: review its changes, keep or
 * revert them, open its session. Runs that said nothing and changed nothing
 * fold into one line.
 *
 * What a run changed is the agent's to know (its turn log, by job id), read
 * through core's run atoms; this page only asks.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronRight, FileText, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { IconStackEmpty } from '@/components/reui/icon-stack-empty'
import { Churn } from '@/composites'
import { Button, Icon } from '@/primitives'
import {
  agentRunFilesAtom,
  agentRunsReviewedAtom,
  agentsSelectionAtom,
  agentSessionRowsAtom,
  cn,
  keepAgentRunAtom,
  loadAgentRunsAtom,
  reviewAgentRunAtom,
  revertAgentRunAtom,
  showAgentSessionAtom,
  useHasCapability,
} from '@/plugin-api'
import { StateLabel, ago, useNow } from './parts'
import { holiSeenAtom, runNeedsYou, runState, type HoliRun, type HoliSummary } from './state'

const stamp = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

function Entry({
  holi,
  run,
  now,
  focused,
}: {
  holi: HoliSummary
  run: HoliRun
  now: number
  focused: boolean
}): React.JSX.Element {
  const sessions = useAtomValue(agentSessionRowsAtom)
  const seen = useAtomValue(holiSeenAtom)[holi.id]
  const files = useAtomValue(agentRunFilesAtom)[run.jobId]
  const reviewed = useAtomValue(agentRunsReviewedAtom)[run.jobId]
  const review = useSetAtom(reviewAgentRunAtom)
  const keep = useSetAtom(keepAgentRunAtom)
  const revert = useSetAtom(revertAgentRunAtom)
  const show = useSetAtom(showAgentSessionAtom)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const state = runState(run, sessions)
  const needs = runNeedsYou(run, sessions, seen)
  const changed = files !== undefined && files.length > 0
  const live = sessions.some((s) => s.id === run.jobId)
  const added = files?.reduce((n, f) => n + f.added, 0) ?? 0
  const removed = files?.reduce((n, f) => n + f.removed, 0) ?? 0

  const act = (p: Promise<{ ok: boolean; message?: string } | void>) => {
    setBusy(true)
    setError(null)
    void p.then((res) => {
      setBusy(false)
      if (res !== undefined && !res.ok) setError(res.message ?? 'That did not work.')
    })
  }

  return (
    <article
      aria-label={`${run.path}, ${stamp.format(new Date(run.at))}`}
      data-run={run.jobId}
      data-focused={focused ? '' : undefined}
      className={cn(
        'flex flex-col gap-2 border-b border-divider px-6 py-4',
        focused && 'bg-foreground/[0.03]',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono text-foreground/85">{run.path}</span>
        <span className="tabular-nums">{stamp.format(new Date(run.at))}</span>
        <span className="tabular-nums">· {ago(new Date(run.at).getTime(), now)}</span>
        <span className="ms-auto flex items-center gap-2">
          {needs ? (
            <StateLabel state="needs-you" />
          ) : state === 'working' ? (
            <StateLabel state="working" />
          ) : changed ? (
            <span className="flex items-center gap-1.5">
              {reviewed === 'reverted'
                ? 'Reverted'
                : reviewed === 'kept'
                  ? 'Kept'
                  : 'Changed files'}
              <Churn added={added} removed={removed} />
            </span>
          ) : run.report === undefined ? (
            <span>Nothing to report</span>
          ) : (
            <StateLabel state="done" />
          )}
        </span>
      </div>

      {run.report !== undefined && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {run.report.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {changed && (
          <Button size="xs" variant="secondary" onClick={() => review(run.jobId)}>
            Review changes
          </Button>
        )}
        {changed && reviewed === undefined && state !== 'working' && (
          <>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => keep(run.jobId)}>
              Keep
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => act(revert(run.jobId))}
            >
              Revert
            </Button>
          </>
        )}
        <Button
          size="xs"
          variant={state === 'needs-you' ? 'secondary' : 'ghost'}
          disabled={busy}
          onClick={() => act(show({ session: run.jobId, live }))}
        >
          Open session
        </Button>
      </div>
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </article>
  )
}

/** Runs that said nothing and changed nothing, as one line that opens. */
function Quiet({
  holi,
  runs,
  now,
}: {
  holi: HoliSummary
  runs: HoliRun[]
  now: number
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col border-b border-divider">
      <Button
        variant="ghost"
        className="h-9 w-full justify-start gap-2 rounded-none px-6 text-xs font-normal text-muted-foreground hover:bg-foreground/[0.03]"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon icon={ChevronRight} size="sm" className={cn('motion-respond', open && 'rotate-90')} />
        {runs.length} quiet {runs.length === 1 ? 'run' : 'runs'}, nothing to report
      </Button>
      {open &&
        runs.map((r) => <Entry key={r.jobId} holi={holi} run={r} now={now} focused={false} />)}
    </div>
  )
}

export function HoliFeed({
  holi,
  focus,
}: {
  holi: HoliSummary
  /** A run to bring forward, by its session's id. */
  focus?: string
}): React.JSX.Element {
  const sessions = useAtomValue(agentSessionRowsAtom)
  const files = useAtomValue(agentRunFilesAtom)
  // A habit is the one way to give it work from here: offered while the
  // automations plugin runs.
  const habits = useHasCapability('schedules.list')
  const select = useSetAtom(agentsSelectionAtom)
  const seen = useAtomValue(holiSeenAtom)[holi.id]
  const setSeen = useSetAtom(holiSeenAtom)
  const load = useSetAtom(loadAgentRunsAtom)
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const now = useNow()

  // What each run changed, asked again as runs come and their sessions move.
  const jobs = holi.runs.map((r) => r.jobId)
  const states = holi.runs.map((r) => runState(r, sessions)).join(',')
  const key = `${jobs.join(',')}|${states}`
  useEffect(() => {
    setLoadError(false)
    void load(jobs).catch(() => setLoadError(true))
    // `key` stands for `jobs` and their states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, load])

  // Opened: the reports that asked for the person have been seen.
  useEffect(() => {
    setSeen((s) => ({ ...s, [holi.id]: new Date().toISOString() }))
    return () => setSeen((s) => ({ ...s, [holi.id]: new Date().toISOString() }))
  }, [holi.id, setSeen])

  useEffect(() => {
    if (focus === undefined) return
    document
      .querySelector(`[data-run="${CSS.escape(focus)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focus])

  const groups = useMemo(() => {
    const out: ({ kind: 'run'; run: HoliRun } | { kind: 'quiet'; runs: HoliRun[] })[] = []
    for (const r of holi.runs) {
      const quiet =
        r.jobId !== focus &&
        r.report === undefined &&
        !runNeedsYou(r, sessions, seen) &&
        runState(r, sessions) === 'done' &&
        files[r.jobId] !== undefined &&
        files[r.jobId]!.length === 0
      const last = out.at(-1)
      if (quiet && last?.kind === 'quiet') last.runs.push(r)
      else if (quiet) out.push({ kind: 'quiet', runs: [r] })
      else out.push({ kind: 'run', run: r })
    }
    return out
  }, [holi.runs, sessions, seen, files, focus])

  if (holi.runs.length === 0) {
    return (
      <IconStackEmpty
        icon={FileText}
        title="No runs yet"
        description={`Send ${holi.name} a document from the menu beside the document's Agent button, or give it a habit and it runs on its own.`}
        action={
          habits
            ? {
                label: 'Add a habit',
                icon: Plus,
                onClick: () => select({ owner: 'automations', id: `new:${holi.id}` }),
              }
            : undefined
        }
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-holi-feed={holi.id}>
      {loadError && (
        <div className="flex items-center gap-2 px-6 py-2 text-xs text-muted-foreground">
          Could not read what its runs changed.
          <Button size="xs" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        </div>
      )}
      {groups.map((g) =>
        g.kind === 'run' ? (
          <Entry
            key={g.run.jobId}
            holi={holi}
            run={g.run}
            now={now}
            focused={g.run.jobId === focus}
          />
        ) : (
          <Quiet key={g.runs[0]!.jobId} holi={holi} runs={g.runs} now={now} />
        ),
      )}
    </div>
  )
}
