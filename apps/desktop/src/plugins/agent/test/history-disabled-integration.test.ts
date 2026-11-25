import { A, adapters, rig } from './activation-fixture'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('records agent sessions while history is disabled, then exposes the saved session when re-enabled', async () => {
  const { enter, call, roots } = await rig()
  const settings = join(roots[A], '.holi/settings/app.yaml')
  await mkdir(join(roots[A], '.holi/settings'), { recursive: true })
  await writeFile(settings, 'agentHistory: false\n')
  await enter(A)

  // The real agent activation still records live sessions even when history
  // delivery and reads are disabled.
  const sessions = await call(A, 'agent.sessions')
  expect(sessions).toEqual([expect.objectContaining({ id: 'abc12345', state: 'idle' })])
  expect(await call(A, 'agent.history')).toEqual([])
  expect(adapters.run).toHaveBeenCalled()

  await writeFile(settings, 'agentHistory: true\n')
  await expect(call(A, 'agent.history')).resolves.toEqual([
    expect.objectContaining({ id: 'abc12345', state: 'idle' }),
  ])
  expect(await readFile(settings, 'utf8')).toContain('agentHistory: true')
})
