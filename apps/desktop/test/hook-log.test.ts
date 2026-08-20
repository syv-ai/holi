/**
 * The run log — the first agent-readable log surface in Holi.
 *
 * It exists because a transform that rewrites files silently is
 * indistinguishable from a bug. The agent is the fast path for "what just
 * happened to my file"; this is the floor it reads from.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isLocalOnlyPath } from '@holi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOOKS_LOG_FILE, appendHookLog, readHookLog } from '../src/main/vault/hooks/log'

let root: string
const dirs: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-hooklog-'))
  dirs.push(root)
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('the log file', () => {
  it('lives at .holi/hooks.local.log and never syncs', () => {
    expect(HOOKS_LOG_FILE).toBe('.holi/hooks.local.log')
    expect(isLocalOnlyPath(HOOKS_LOG_FILE)).toBe(true)
  })

  it('reads as empty before anything has been written', async () => {
    expect(await readHookLog(root)).toBe('')
  })

  it('appends rather than replacing', async () => {
    await appendHookLog(root, ['first'])
    await appendHookLog(root, ['second'])
    const text = await readHookLog(root)
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'))
  })

  it('writes one line per note', async () => {
    await appendHookLog(root, ['a', 'b'])
    expect((await readHookLog(root)).trim().split('\n')).toHaveLength(2)
  })

  it('stamps each line so the agent can tell one run from the next', async () => {
    await appendHookLog(root, ['relink: rewrote 2 files'])
    expect(await readHookLog(root)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+relink: /m)
  })

  it('writes nothing at all for an empty run', async () => {
    await appendHookLog(root, [])
    expect(await readHookLog(root)).toBe('')
  })

  it('keeps the NEWEST lines when it caps', async () => {
    // The oldest entries are the ones nobody will ever ask about, and a log
    // that grows forever is one the agent cannot read in a single tool call.
    for (let run = 0; run < 40; run += 1) {
      await appendHookLog(
        root,
        Array.from({ length: 250 }, (_, n) => `run ${run} line ${n}`),
      )
    }
    const text = await readHookLog(root)
    expect(text.trim().split('\n').length).toBeLessThanOrEqual(2000)
    expect(text).toContain('run 39 line 249')
    expect(text).not.toContain('run 0 line 0')
  })

  it('never throws — a log that fails must not become the failure it reports', async () => {
    // The whole design says a transform cannot break a commit. A log write is
    // the least important thing here, so it swallows its own errors.
    await expect(appendHookLog('/nonexistent/nowhere', ['x'])).resolves.toBeUndefined()
  })
})
