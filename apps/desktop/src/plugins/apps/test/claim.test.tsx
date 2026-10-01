/**
 * The app claim's own rules; how the tree shows a folder document is core's,
 * tested there with a claim written out the same way.
 */
import { emptyVaultSnapshot } from '@holi/shared'
import { expect, test, vi } from 'vitest'
import { APP_CLAIM } from '../renderer/surface'

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

test('New App scaffolds the bundle through apps.init and opens its entry', async () => {
  const run = APP_CLAIM.create!.run
  expect(await run({ remote: 'o/r', parent: 'Finance', name: 'Budget' })).toBe(
    'Finance/Budget.app/index.html',
  )
  expect(init).toHaveBeenCalledWith('o/r', { path: 'Finance/Budget.app' })
  init.mockRejectedValueOnce(new Error('not an app'))
  expect(await run({ remote: 'o/r', parent: '', name: 'x' })).toBeNull()
})
