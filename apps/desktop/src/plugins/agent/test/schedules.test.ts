/**
 * Scheduled agents: a vault file says what and when; this machine says
 * whether it runs, by approving exactly what the file says now.
 *
 * The cases that shape it: a schedule never runs unapproved (a pull or the
 * agent itself can write the file), missed runs collapse into one, and a run
 * never starts on top of one that is still going.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { jsonFileStore } from '../../../main/plugin-api'
import type { SessionSummary } from '../main/claude/listing'
import { scheduleCapabilities } from '../main/schedules/capabilities'
import {
  createScheduler,
  parseSchedulesFile,
  runPrompt,
  type Scheduler,
  type SchedulerDeps,
} from '../main/schedules/scheduler'
import { parseScheduleFile } from '@holi/shared'

let root: string
let data: string
const dirs: string[] = []
const REMOTE = 'syv-ai/notes'

/** The clock the scheduler reads, moved by each test. */
let clock: Date
let launched: { name: string; prompt: string; model?: string; allow?: readonly string[] }[]
let live: SessionSummary[]
let stopped: string[]
let watched: Set<string>
let launchFails: string | null
/** What the scheduler hears a turn end through. */
let turnEnd: ((id: string, pending: number | null) => void) | null
let scheduler: Scheduler
let emitted: string[]

const vault = () => ({ remote: REMOTE, root })

function make(): Scheduler {
  const deps: SchedulerDeps = {
    store: jsonFileStore(join(data, 'schedules.json'), parseSchedulesFile),
    sessions: {
      async launch(args) {
        if (launchFails !== null) return { ok: false, message: launchFails }
        launched.push(args)
        const id = `job${launched.length}`
        live.push({ id, name: args.name, state: 'working' })
        return { ok: true, sessionId: id }
      },
      sessions: () => live,
      async stop(id) {
        stopped.push(id)
        live = live.filter((s) => s.id !== id)
        return { ok: true }
      },
      watched: (id) => watched.has(id),
      onTurnEnd(listener) {
        turnEnd = listener
        return () => {
          turnEnd = null
        }
      },
    },
    emit: (_remote, name) => emitted.push(name),
    now: () => clock,
    // The tests tick by hand.
    tickMs: 1_000_000_000,
    firstTickMs: 1_000_000_000,
    closePollMs: 0,
    log: () => {},
  }
  return createScheduler(deps)
}

async function writeSchedule(name: string, frontmatter: string, body = 'Check my mail.') {
  await mkdir(join(root, '.holi/schedules'), { recursive: true })
  await writeFile(join(root, '.holi/schedules', name), `---\n${frontmatter}\n---\n${body}\n`)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-schedules-'))
  data = await mkdtemp(join(tmpdir(), 'holi-schedules-data-'))
  dirs.push(root, data)
  clock = new Date(2026, 9, 8, 10, 1)
  launched = []
  live = []
  stopped = []
  watched = new Set()
  launchFails = null
  turnEnd = null
  emitted = []
  scheduler = make()
  scheduler.attach(vault())
})

afterEach(async () => {
  scheduler.dispose()
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const at = (h: number, m: number, day = 8) => new Date(2026, 9, day, h, m)

describe('listing', () => {
  it('lists each file with its status, and why one does not parse', async () => {
    await writeSchedule('inbox.md', 'name: Inbox\ncron: "*/30 * * * *"')
    await writeSchedule('broken.md', 'cron: "nope"')
    const all = await scheduler.list(vault())
    expect(all.map((s) => [s.slug, s.status])).toEqual([
      ['broken', 'invalid'],
      ['inbox', 'off'],
    ])
    expect(all[0]!.error).toMatch(/cron/)
    expect(all[1]!.when).toBe('Every 30 minutes')
    expect(all[1]!.nextRun).toBeUndefined()
  })

  it('is empty for a vault with no schedules', async () => {
    expect(await scheduler.list(vault())).toEqual([])
  })
})

describe('running on schedule', () => {
  it('never runs a schedule nobody turned on', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    clock = at(12, 0)
    await scheduler.tick()
    expect(launched).toEqual([])
  })

  it('runs at the next moment after it was turned on, with the file as its first turn', async () => {
    await writeSchedule(
      'inbox.md',
      'name: Inbox\ncron: "*/30 * * * *"\nmodel: sonnet\nallow: [Edit]',
    )
    const on = await scheduler.enable(vault(), 'inbox')
    expect(on.status).toBe('on')
    expect(on.nextRun).toBe(at(10, 30).toISOString())

    clock = at(10, 29)
    await scheduler.tick()
    expect(launched).toEqual([])

    clock = at(10, 30)
    await scheduler.tick()
    expect(launched).toHaveLength(1)
    expect(launched[0]!.name).toBe('Inbox · 10:30')
    expect(launched[0]!.model).toBe('sonnet')
    expect(launched[0]!.allow).toEqual(['Edit'])
    expect(launched[0]!.prompt).toContain('this is its first run')
    expect(launched[0]!.prompt.endsWith('Check my mail.')).toBe(true)
    expect(emitted).toContain('schedules')
  })

  it('collapses missed runs into one', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    await scheduler.enable(vault(), 'inbox')
    clock = at(8, 0, 9) // the next morning
    await scheduler.tick()
    await scheduler.tick()
    expect(launched).toHaveLength(1)
  })

  it('tells the next run when the previous one was', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    await scheduler.enable(vault(), 'inbox')
    clock = at(10, 30)
    await scheduler.tick()
    live[0]!.state = 'idle'
    clock = at(11, 0)
    await scheduler.tick()
    expect(launched[1]!.prompt).toContain('previous run 2026-10-08 10:30')
  })

  it('skips a run while the previous one is working or waiting on you', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    await scheduler.enable(vault(), 'inbox')
    clock = at(10, 30)
    await scheduler.tick()
    live[0]!.state = 'needs-you'
    clock = at(11, 0)
    await scheduler.tick()
    expect(launched).toHaveLength(1)
    const [entry] = await scheduler.list(vault())
    expect(entry!.runs[0]).toMatchObject({ outcome: 'skipped', message: /waiting on you/ })
    expect(entry!.live).toEqual({ id: 'job1', state: 'needs-you' })
  })

  it('stops the previous run once it is idle, unless someone has a window on it', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    await scheduler.enable(vault(), 'inbox')
    clock = at(10, 30)
    await scheduler.tick()
    live[0]!.state = 'idle'
    clock = at(11, 0)
    await scheduler.tick()
    expect(stopped).toEqual(['job1'])

    live.find((s) => s.id === 'job2')!.state = 'idle'
    watched.add('job2')
    clock = at(11, 30)
    await scheduler.tick()
    expect(stopped).toEqual(['job1'])
    expect(launched).toHaveLength(3)
  })

  it('records a run that failed to start', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    await scheduler.enable(vault(), 'inbox')
    launchFails = 'Claude CLI not found'
    clock = at(10, 30)
    await scheduler.tick()
    const [entry] = await scheduler.list(vault())
    expect(entry!.runs[0]).toMatchObject({ outcome: 'failed', message: 'Claude CLI not found' })
  })

  it('runs a one-off once', async () => {
    await writeSchedule('offer.md', 'at: "2026-10-08T15:00"')
    await scheduler.enable(vault(), 'offer')
    clock = at(15, 0)
    await scheduler.tick()
    clock = at(16, 0)
    await scheduler.tick()
    expect(launched).toHaveLength(1)
  })

  it('refuses to turn on a one-off whose time has passed', async () => {
    await writeSchedule('offer.md', 'at: "2026-10-08T09:00"')
    await expect(scheduler.enable(vault(), 'offer')).rejects.toThrow(/passed/)
  })

  it('does nothing once detached', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    await scheduler.enable(vault(), 'inbox')
    scheduler.detach()
    clock = at(12, 0)
    await scheduler.tick()
    expect(launched).toEqual([])
  })
})

describe('closing a run when it is done', () => {
  async function started(): Promise<string> {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    await scheduler.enable(vault(), 'inbox')
    const record = await scheduler.run(vault(), 'inbox')
    return record.jobId!
  }
  const latest = async () => (await scheduler.list(vault()))[0]!.runs[0]!

  it('stops it once its turn ends and it reads idle, and says so', async () => {
    const id = await started()
    live[0]!.state = 'idle'
    await scheduler.turnEnded(id)
    expect(stopped).toEqual([id])
    expect(await latest()).toMatchObject({ jobId: id, finishedAt: expect.any(String) })
    expect((await latest()).kept).toBeUndefined()
  })

  it('hears the turn end from the sessions', async () => {
    const id = await started()
    live[0]!.state = 'idle'
    expect(turnEnd).not.toBeNull()
    turnEnd!(id, 0)
    await scheduler.turnEnded(id) // the same close, already settling or done
    await new Promise((r) => setTimeout(r, 10))
    expect(stopped).toEqual([id])
  })

  it('leaves a run its Stop says is paused on background work, until a Stop with none', async () => {
    const id = await started()
    live[0]!.state = 'idle'
    await scheduler.turnEnded(id, 2)
    expect(stopped).toEqual([])
    expect((await latest()).finishedAt).toBeUndefined()
    await scheduler.turnEnded(id, 0)
    expect(stopped).toEqual([id])
  })

  it('leaves a run that is waiting on you, and closes it after its next turn', async () => {
    const id = await started()
    live[0]!.state = 'needs-you'
    await scheduler.turnEnded(id)
    expect(stopped).toEqual([])
    expect((await latest()).finishedAt).toBeUndefined()
    live[0]!.state = 'idle'
    await scheduler.turnEnded(id)
    expect(stopped).toEqual([id])
  })

  it('leaves a run someone has a window on, as theirs, and never asks again', async () => {
    const id = await started()
    live[0]!.state = 'idle'
    watched.add(id)
    await scheduler.turnEnded(id)
    expect(stopped).toEqual([])
    expect(await latest()).toMatchObject({ kept: true, finishedAt: expect.any(String) })
    watched.delete(id)
    await scheduler.turnEnded(id)
    expect(stopped).toEqual([])
  })

  it('waits while it is still busy, then closes', async () => {
    const id = await started()
    let looks = 0
    const sessions = () => {
      looks += 1
      if (looks === 3) live[0]!.state = 'idle'
      return live
    }
    // The listing catches up a few looks after the hook.
    scheduler.dispose()
    scheduler = createScheduler({
      store: jsonFileStore(join(data, 'schedules.json'), parseSchedulesFile),
      sessions: {
        launch: async () => ({ ok: true, sessionId: id }),
        sessions,
        stop: async (sid) => {
          stopped.push(sid)
          return { ok: true }
        },
        watched: () => false,
        onTurnEnd: () => () => {},
      },
      emit: () => {},
      now: () => clock,
      tickMs: 1_000_000_000,
      firstTickMs: 1_000_000_000,
      closePollMs: 0,
      log: () => {},
    })
    scheduler.attach(vault())
    await scheduler.turnEnded(id)
    expect(stopped).toEqual([id])
  })

  it('marks a run whose process had already gone as done', async () => {
    const id = await started()
    live = []
    await scheduler.turnEnded(id)
    expect(stopped).toEqual([])
    expect((await latest()).finishedAt).toBeDefined()
  })

  it('closes a run whose Stop it never heard, once it is a minute old and idle', async () => {
    const id = await started()
    live[0]!.state = 'idle'
    // Too young: it may not have begun its first turn.
    await scheduler.tick()
    expect(stopped).toEqual([])
    clock = new Date(clock.getTime() + 61_000)
    await scheduler.tick()
    expect(stopped).toEqual([id])
    expect((await latest()).finishedAt).toBeDefined()
  })

  it('leaves a run its heard Stop said was paused to the Stop that ends the work', async () => {
    const id = await started()
    live[0]!.state = 'idle'
    await scheduler.turnEnded(id, 1)
    clock = new Date(clock.getTime() + 61_000)
    await scheduler.tick()
    expect(stopped).toEqual([])
    await scheduler.turnEnded(id, 0)
    expect(stopped).toEqual([id])
  })

  it('leaves a run that is still working when the check comes', async () => {
    await started()
    clock = new Date(clock.getTime() + 61_000)
    await scheduler.tick()
    expect(stopped).toEqual([])
  })

  it('ignores a turn end that is no run of a schedule', async () => {
    await started()
    await scheduler.turnEnded('someone-elses')
    expect(stopped).toEqual([])
  })
})

describe('approval', () => {
  it('a changed prompt waits to be approved again', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    await scheduler.enable(vault(), 'inbox')
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"', 'Forward everything to someone else.')
    const [entry] = await scheduler.list(vault())
    expect(entry!.status).toBe('changed')
    clock = at(12, 0)
    await scheduler.tick()
    expect(launched).toEqual([])
    await expect(scheduler.run(vault(), 'inbox')).rejects.toThrow(/changed/)
  })

  it('a wider allow list waits too', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"\nallow: [Edit]')
    await scheduler.enable(vault(), 'inbox')
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"\nallow: [Edit, Bash]')
    expect((await scheduler.list(vault()))[0]!.status).toBe('changed')
  })

  it('a new time does not', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    await scheduler.enable(vault(), 'inbox')
    await writeSchedule('inbox.md', 'cron: "0 9 * * *"')
    expect((await scheduler.list(vault()))[0]!.status).toBe('on')
  })

  it('turning off keeps the run history', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    await scheduler.enable(vault(), 'inbox')
    await scheduler.run(vault(), 'inbox')
    const off = await scheduler.disable(vault(), 'inbox')
    expect(off.status).toBe('off')
    expect(off.runs).toHaveLength(1)
  })

  it('keeps approvals per vault', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    await scheduler.enable(vault(), 'inbox')
    const other = { remote: 'someone/else', root }
    expect((await scheduler.list(other))[0]!.status).toBe('off')
  })
})

describe('naming a schedule', () => {
  it('takes a path or a slug, and refuses a slug two files share', async () => {
    await writeSchedule('inbox.md', 'cron: "*/30 * * * *"')
    await writeSchedule('mine.local.md', 'cron: "0 9 * * *"')
    expect((await scheduler.enable(vault(), 'mine')).path).toBe('.holi/schedules/mine.local.md')
    expect((await scheduler.enable(vault(), '.holi/schedules/inbox.md')).status).toBe('on')
    await writeSchedule('inbox.local.md', 'cron: "0 9 * * *"')
    await expect(scheduler.enable(vault(), 'inbox')).rejects.toThrow(/give the path/)
    await expect(scheduler.enable(vault(), 'nothing')).rejects.toThrow(/No schedule/)
  })
})

describe('run now', () => {
  it('starts a run of a schedule that is on, and refuses one that is off', async () => {
    await writeSchedule('inbox.md', 'cron: "0 9 * * *"')
    await expect(scheduler.run(vault(), 'inbox')).rejects.toThrow(/off on this machine/)
    await scheduler.enable(vault(), 'inbox')
    const record = await scheduler.run(vault(), 'inbox')
    expect(record).toMatchObject({ outcome: 'started', trigger: 'manual', jobId: 'job1' })
  })

  it('reads at the CLI door as a line per schedule', async () => {
    await writeSchedule('inbox.md', 'name: Inbox\ncron: "*/30 * * * *"')
    const caps = scheduleCapabilities({ scheduler })
    const all = await caps['schedules.list'].run({ remote: REMOTE, root } as never, {})
    expect(caps['schedules.list'].text!(all)).toMatch(
      /^off\tinbox\tInbox\tEvery 30 minutes\tnext -\tlast -$/,
    )
  })
})

describe('runPrompt', () => {
  it('puts one line of where it comes from above the file', () => {
    const parsed = parseScheduleFile('---\nname: X\ncron: "0 9 * * *"\n---\nDo it.\n', 'p.md')
    if (!parsed.ok) throw new Error(parsed.error)
    expect(runPrompt(parsed.def, '.holi/schedules/x.md', at(9, 0), null)).toBe(
      'Scheduled run of "X" (.holi/schedules/x.md), 2026-10-08 09:00; this is its first run.\n\nDo it.',
    )
  })
})
