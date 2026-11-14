import { describe, expect, test } from 'vitest'
import { createChecks } from '../main/checks'

describe('community readiness checks', () => {
  test('stop aborts and invalidates pending answers and refuses later runs', async () => {
    let finish!: (ok: boolean) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const checks = createChecks(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
          entered()
        }),
    )
    const check = { run: ['tool'], hint: 'Not ready' }
    const pending = checks.run('/vault', 'sample', check, '/plugin')
    await started
    const stopping = checks.stop()
    finish(true)
    await stopping
    expect(await pending).toEqual({ ok: true })
    expect(checks.get('/vault', 'sample')).toBeNull()
    await expect(checks.run('/vault', 'sample', check, '/plugin')).resolves.toEqual({
      ok: false,
      hint: 'Not ready',
    })
    expect(checks.get('/vault', 'sample')).toBeNull()
  })
})
