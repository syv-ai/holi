import { A, rig } from './activation-fixture'
import { openTurnLog, TURNS_FILE } from '../main/host/turn-log'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('keeps live sessions and persisted turn records independent of the history switch', async () => {
  const { enter, call, roots } = await rig()
  const settings = join(roots[A], '.holi/settings/app.yaml')
  await mkdir(join(roots[A], '.holi/settings'), { recursive: true })
  await writeFile(settings, 'agentHistory: false\n')
  await enter(A)

  // History controls browsing, not the active session or turn-record APIs.
  const sessions = await call(A, 'agent.sessions')
  expect(sessions).toEqual([expect.objectContaining({ id: 'abc12345', state: 'idle' })])
  expect(await call(A, 'agent.history')).toEqual([])
  const record = { base: 'before', end: 'after', at: '2026-11-25T12:00:00Z', sessionId: 'abc12345' }
  await openTurnLog(roots[A]).append(record)
  expect(await call(A, 'agent.turns')).toEqual([record])
  expect(JSON.parse(await readFile(join(roots[A], TURNS_FILE), 'utf8'))).toEqual([record])

  await writeFile(settings, 'agentHistory: true\n')
  await expect(call(A, 'agent.history')).resolves.toEqual([
    expect.objectContaining({ id: 'abc12345', state: 'idle' }),
  ])
})
