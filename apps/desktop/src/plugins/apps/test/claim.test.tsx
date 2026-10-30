/**
 * The app claim's own rules; how the tree shows a folder document is core's,
 * tested there with a claim written out the same way.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { expect, test, vi } from 'vitest'
import { atom } from 'jotai'
import { APP_CLAIM, newAppPrompt } from '../renderer/surface'

const init = vi.hoisted(() => vi.fn(async (_remote: string, _p: unknown) => ({ created: [] })))
vi.mock('../renderer/apps-cap', () => ({ appsCap: { init } }))

const snapshot = (...files: string[]) => ({
  ...emptyVaultSnapshot(),
  files: files.map((path) => ({ path, updatedAt: '' })),
})

test('offers Finish this app only to a bundle with an entry and no manifest', () => {
  const finish = APP_CLAIM.rowMenu!.find((i) => i.label === 'Finish this app')!
  expect(finish.when!('A.app', snapshot('A.app/index.html'))).toBe(true)
  expect(finish.when!('A.app', snapshot('A.app/index.html', 'A.app/app.yaml'))).toBe(false)
  expect(finish.when!('A.app', snapshot('A.app/app.yaml'))).toBe(false)
})

test('New app hands what it is for to a new agent session, and opens nothing itself', async () => {
  const run = APP_CLAIM.create!.run
  const start = vi.fn(async (_args: { name?: string; prompt: string }) => ({ ok: true as const }))
  const agent = {
    name: 'Claude',
    sessions: atom([]),
    targets: atom({ sessions: [], default: 'new' }),
    ask: vi.fn(),
    start,
  }
  expect(APP_CLAIM.create!.agent).toBe(true)
  expect(await run({ remote: 'o/r', parent: 'Finance', name: 'a burndown', agent })).toBeNull()
  expect(start).toHaveBeenCalledWith({
    name: 'a burndown',
    prompt: newAppPrompt('Finance', 'a burndown'),
  })
  expect(newAppPrompt('Finance', 'a burndown')).toMatch(
    /^Build a vault app in `Finance\/`: a burndown/,
  )
  expect(newAppPrompt('', 'x')).toMatch(/^Build a vault app at the root of this vault: x/)
  expect(init).not.toHaveBeenCalled()
  expect(await run({ remote: 'o/r', parent: '', name: 'x', agent: null })).toBeNull()
})
