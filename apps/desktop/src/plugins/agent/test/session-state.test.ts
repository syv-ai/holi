import { describe, expect, it, vi } from 'vitest'
import {
  isLive,
  parseListing,
  readContextPercent,
  summarise,
  summarisePast,
} from '../main/claude/listing'
import { createSessionState, type ListingSource } from '../main/host/session-state'

const ROOT = '/Users/ada/Holi/syv/vault'

type Row = Record<string, unknown>
const row = (id: string, over: Row = {}): Row => ({
  id,
  cwd: ROOT,
  kind: 'background',
  sessionId: `${id}-uuid`,
  name: `Session ${id}`,
  pid: 100,
  status: 'idle',
  state: 'done',
  ...over,
})
const BUSY = { status: 'busy', state: 'working' }
const HELD = 'the assistant is working'

/** The state over a scripted listing, with the vault's sync holds recorded. */
function setup(initial: Row[] = []) {
  let listing: Row[] = initial
  /** What `claude agents` prints instead of the listing: null is a call that
   *  failed altogether. */
  let broken: { stdout: string | null } | null = null
  let attached = true
  const source: ListingSource = {
    root: ROOT,
    read: async () => (broken !== null ? broken.stdout : JSON.stringify(listing)),
  }
  const held: string[] = []
  const released: string[] = []
  const changes = vi.fn()
  const ended: Array<[string, number | null]> = []
  const state = createSessionState({
    source: () => (attached ? source : null),
    vault: () => ({
      root: ROOT,
      head: () => Promise.resolve('base'),
      commitNow: () => Promise.resolve(null),
      pauseSync: (reason: string) => {
        held.push(reason)
        return () => {
          released.push(reason)
        }
      },
    }),
    provider: { parseListing, isLive, summarise, summarisePast, readContextPercent },
    onChange: changes,
    idleRecheckMs: 5,
    idleConfirmMs: 10,
    log: () => {},
  })
  state.onTurnEnd((id, pending) => ended.push([id, pending]))
  return {
    state,
    held,
    released,
    changes,
    ended,
    list: (rows: Row[]) => {
      listing = rows
    },
    breakWith: (stdout: string | null) => {
      broken = { stdout }
    },
    mend: () => {
      broken = null
    },
    detach: () => {
      attached = false
    },
    states: () => state.sessions().map((s) => [s.id, s.state]),
  }
}

describe('session state', () => {
  it('reads the live sessions and the history from one listing', async () => {
    const t = setup([row('aaaaaaaa'), row('bbbbbbbb', { pid: undefined, status: undefined })])
    await t.state.refresh()
    expect(t.state.sessions().map((s) => s.id)).toEqual(['aaaaaaaa'])
    expect(t.state.history().map((s) => s.id)).toEqual(['bbbbbbbb'])
    expect(t.state.liveIds()).toEqual(['aaaaaaaa'])
    expect(t.state.isLive('bbbbbbbb')).toBe(false)
    expect(t.state.row('bbbbbbbb')?.id).toBe('bbbbbbbb')
    expect(t.state.nameOf('aaaaaaaa')).toBe('Session aaaaaaaa')
    expect(t.state.nameOf('nobody00')).toBeUndefined()
  })

  describe('a blocked session', () => {
    const blocked = { status: 'idle', state: 'blocked' }
    const phase = (t: ReturnType<typeof setup>, id: string) =>
      t.state.sessions().find((s) => s.id === id)?.phase

    it('is new while it has had no prompt', async () => {
      const t = setup([row('aaaaaaaa', blocked)])
      t.state.startedEmpty('aaaaaaaa')
      await t.state.refresh()
      expect(phase(t, 'aaaaaaaa')).toBe('new')
    })

    it('started with a prompt, its turn finished and handed back to you', async () => {
      const t = setup([row('aaaaaaaa', blocked)])
      t.state.startedWithPrompt('aaaaaaaa')
      await t.state.refresh()
      expect(phase(t, 'aaaaaaaa')).toBe('done')
    })

    it('seen working, then blocked, has finished a turn', async () => {
      const t = setup([row('aaaaaaaa', BUSY)])
      await t.state.refresh()
      t.list([row('aaaaaaaa', blocked)])
      // A turn ends on two consecutive idle readings.
      await t.state.refresh()
      await new Promise((r) => setTimeout(r, 20))
      await t.state.refresh()
      expect(t.states()).toEqual([['aaaaaaaa', 'idle']])
      expect(phase(t, 'aaaaaaaa')).toBe('done')
    })

    it('said something to, then blocked, has finished a turn', async () => {
      const t = setup([row('aaaaaaaa', blocked)])
      t.state.startedEmpty('aaaaaaaa')
      t.state.spoke('aaaaaaaa')
      await t.state.refresh()
      expect(phase(t, 'aaaaaaaa')).toBe('done')
    })
  })

  describe('a read that failed', () => {
    it.each([
      ['a call that failed', null],
      ['output that is not a listing', 'Error: could not reach the supervisor'],
    ])('keeps a turn, its hold and the sessions through %s', async (_name, stdout) => {
      const t = setup([row('aaaaaaaa', BUSY)])
      await t.state.refresh()
      expect(t.held).toEqual([HELD])

      t.breakWith(stdout)
      await t.state.refresh()
      // Nothing was read, so nothing is known to have gone.
      expect(t.states()).toEqual([['aaaaaaaa', 'working']])
      expect(t.released).toEqual([])

      // A listing that was read and is empty is another matter.
      t.mend()
      t.list([])
      await t.state.refresh()
      expect(t.states()).toEqual([])
      expect(t.released).toEqual([HELD])
    })

    it('does not tell anyone the sessions changed', async () => {
      const t = setup([row('aaaaaaaa')])
      await t.state.refresh()
      t.changes.mockClear()
      t.breakWith(null)
      await t.state.refresh()
      expect(t.changes).not.toHaveBeenCalled()
    })

    it('does not take a failed first read for a first read', async () => {
      const t = setup([row('aaaaaaaa', BUSY)])
      t.breakWith(null)
      await t.state.refresh()
      expect(t.held).toEqual([])

      // The first read that lands still finds the session mid-turn.
      t.mend()
      await t.state.refresh()
      expect(t.held).toEqual([HELD])
    })
  })

  describe('the first good read', () => {
    it('holds sync for a session found mid-turn, and only on the first read', async () => {
      const t = setup([row('aaaaaaaa', BUSY)])
      await t.state.refresh()
      expect(t.states()).toEqual([['aaaaaaaa', 'working']])
      expect(t.held).toEqual([HELD])

      // A session that turns busy later is the hook's to say, not the seed's.
      t.list([row('aaaaaaaa', BUSY), row('bbbbbbbb', BUSY)])
      await t.state.refresh()
      expect(t.held).toEqual([HELD])
      expect(t.state.sessions().find((s) => s.id === 'bbbbbbbb')?.state).toBe('working')
    })
  })

  describe('a turn ending', () => {
    it('takes two consecutive idle readings, the second on its own timer', async () => {
      const t = setup([row('aaaaaaaa', BUSY)])
      await t.state.refresh()
      t.list([row('aaaaaaaa')])
      await t.state.refresh()
      await vi.waitFor(() => expect(t.states()).toEqual([['aaaaaaaa', 'idle']]))
      expect(t.released).toEqual([HELD])
      expect(t.ended).toEqual([['aaaaaaaa', null]])
    })

    it('is not ended by an idle reading with a busy one between', async () => {
      const t = setup([row('aaaaaaaa', BUSY)])
      await t.state.refresh()
      t.list([row('aaaaaaaa')])
      await t.state.refresh()
      t.list([row('aaaaaaaa', BUSY)])
      await t.state.refresh()
      await new Promise((r) => setTimeout(r, 40))
      expect(t.states()).toEqual([['aaaaaaaa', 'working']])
      expect(t.released).toEqual([])
    })

    it('lets a session whose process went leave without ending a turn', async () => {
      const t = setup([row('aaaaaaaa', BUSY)])
      await t.state.refresh()
      t.list([row('aaaaaaaa', { pid: undefined, status: undefined, state: 'stopped' })])
      await t.state.refresh()
      expect(t.released).toEqual([HELD])
      expect(t.ended).toEqual([])
      expect(t.state.history().map((s) => s.id)).toEqual(['aaaaaaaa'])
    })
  })

  describe('the turn hooks', () => {
    it('make a session working and give back what the Stop said was pending', async () => {
      const t = setup([row('aaaaaaaa')])
      await t.state.refresh()
      t.state.noteTurn('aaaaaaaa', true)
      expect(t.states()).toEqual([['aaaaaaaa', 'working']])
      expect(t.held).toEqual([HELD])

      t.state.noteTurn('aaaaaaaa', false, 3)
      expect(t.states()).toEqual([['aaaaaaaa', 'idle']])
      expect(t.ended).toEqual([['aaaaaaaa', 3]])
      expect(t.released).toEqual([HELD])
    })

    it('stop being heard once unsubscribed', async () => {
      const t = setup([row('aaaaaaaa')])
      await t.state.refresh()
      const heard: string[] = []
      const unhear = t.state.onTurnEnd((id) => heard.push(id))
      unhear()
      t.state.noteTurn('aaaaaaaa', true)
      t.state.noteTurn('aaaaaaaa', false)
      expect(heard).toEqual([])
    })
  })

  describe('context use', () => {
    const status = (used: number | null) => ({ context_window: { used_percentage: used } })

    it('is the status line, by job id, and gone when the session is', async () => {
      const t = setup([row('aaaaaaaa'), row('bbbbbbbb')])
      await t.state.refresh()
      t.state.noteStatus('aaaaaaaa', status(41.6))
      expect(t.state.sessions().map((s) => s.contextPercent)).toEqual([42, undefined])

      // A /clear says null: back to nothing.
      t.state.noteStatus('aaaaaaaa', status(null))
      expect(t.state.sessions()[0]?.contextPercent).toBeUndefined()

      // A session that ends forgets it, and resumed it starts over.
      t.state.noteStatus('bbbbbbbb', status(10))
      t.list([row('aaaaaaaa'), row('bbbbbbbb', { pid: undefined, status: undefined })])
      await t.state.refresh()
      t.list([row('aaaaaaaa'), row('bbbbbbbb')])
      await t.state.refresh()
      expect(t.state.sessions().map((s) => s.contextPercent)).toEqual([undefined, undefined])
    })
  })

  describe('a session started with no prompt', () => {
    it('has had no turn until it is busy, a turn begins, or it is spoken to', async () => {
      const t = setup([row('aaaaaaaa'), row('bbbbbbbb'), row('cccccccc'), row('dddddddd')])
      await t.state.refresh()
      for (const id of ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd']) t.state.startedEmpty(id)
      expect(t.state.hasHadNoTurn('aaaaaaaa')).toBe(true)

      t.state.spoke('bbbbbbbb')
      expect(t.state.hasHadNoTurn('bbbbbbbb')).toBe(false)

      t.state.noteTurn('cccccccc', true)
      expect(t.state.hasHadNoTurn('cccccccc')).toBe(false)

      t.list([row('aaaaaaaa'), row('bbbbbbbb'), row('cccccccc'), row('dddddddd', BUSY)])
      await t.state.refresh()
      expect(t.state.hasHadNoTurn('dddddddd')).toBe(false)
      expect(t.state.hasHadNoTurn('aaaaaaaa')).toBe(true)
    })
  })

  describe('a read that lands late', () => {
    it('is dropped when the vault has moved on', async () => {
      const t = setup([row('aaaaaaaa')])
      const pending = t.state.refresh()
      t.detach()
      await pending
      expect(t.state.sessions()).toEqual([])
    })

    it('is followed by another when one was asked for meanwhile', async () => {
      const t = setup([row('aaaaaaaa')])
      const first = t.state.refresh()
      t.list([row('aaaaaaaa'), row('bbbbbbbb')])
      await Promise.all([first, t.state.refresh()])
      expect(t.state.liveIds()).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    })
  })

  it('lets go of the vault: nothing is working, nothing is listed, the hold is given back', async () => {
    const t = setup([row('aaaaaaaa', BUSY)])
    await t.state.refresh()
    t.state.startedEmpty('aaaaaaaa')
    t.state.reset()
    expect(t.state.sessions()).toEqual([])
    expect(t.state.hasHadNoTurn('aaaaaaaa')).toBe(false)
    expect(t.released).toEqual([HELD])

    // The next vault's first read seeds its own working set.
    await t.state.refresh()
    expect(t.held).toEqual([HELD, HELD])
  })
})
