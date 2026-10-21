/**
 * Tasks as a trigger source for scheduled agents
 * (docs/features/scheduled-agents.md, Triggers): the open tasks' due moments,
 * told to the vault's plugins while an approved schedule listens for tasks.
 *
 * Read off each scan of the vault rather than on a timer: a moment is a time,
 * and the agent's check is what notices it has come; the list only has to be
 * told again when the tasks change.
 */
import { ANCHOR_HOUR, DAY_MS, parseStamp, type Moment, type VaultSnapshot } from '@holi/shared'
import type { Disposer, PluginCtx } from '../../../main/plugin-api'
import { snapshotTasks } from '../shared/task-file'
import type { Task } from '../shared/types'

/** A naive wall-clock epoch (`parseStamp`'s) as this machine's local instant. */
function local(naive: number): Date {
  const d = new Date(naive)
  return new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
  )
}

/**
 * Each open task's two moments. Due at a time, it is due and overdue then.
 * Due on a day, it is due that morning, at the hour a timeless reminder
 * fires, and overdue the next morning at the same hour: a day-only task is
 * not late until its day is over, and a run at midnight helps nobody.
 */
export function taskMoments(tasks: readonly Task[]): Moment[] {
  const out: Moment[] = []
  for (const t of tasks) {
    if (t.status === 'done' || t.due === undefined) continue
    const stamp = parseStamp(t.due)
    if (stamp === null) continue
    const due = stamp.timed ? stamp.epoch : stamp.epoch + ANCHOR_HOUR * 3_600_000
    const overdue = stamp.timed ? due : due + DAY_MS
    out.push(
      { id: t.path, kind: 'due', at: local(due).toISOString() },
      { id: t.path, kind: 'overdue', at: local(overdue).toISOString() },
    )
  }
  return out
}

export function startTaskTriggers(ctx: PluginCtx): Disposer {
  let wanted = false
  let latest: VaultSnapshot | null = null
  const tell = (): void => {
    if (!wanted || latest === null) return
    ctx.events.emit({
      type: 'upcoming',
      source: 'task',
      moments: taskMoments(snapshotTasks(latest).items),
    })
  }
  const unhear = ctx.events.on((event) => {
    if (event.type !== 'interest') return
    wanted = event.interest.task
    // Told again at every check: a list the agent missed is repaired, and a
    // list not told again is one the router stops trusting.
    tell()
  })
  const unscan = ctx.onSnapshot((snapshot) => {
    latest = snapshot
    tell()
  })
  return () => {
    // What it told goes with it.
    if (wanted) ctx.events.emit({ type: 'upcoming', source: 'task', moments: [] })
    unhear()
    unscan()
  }
}
