import { describe, expect, test } from 'vitest'
import { createChecks } from '../main/checks'

describe('community readiness checks', () => {
  test('a completed ticket only answers for a current matching launch', async () => {
    const checks = createChecks(async () => true)
    const check = { run: ['tool'], hint: 'Not ready' }
    const run = (fingerprint: string) =>
      checks.run('/vault', 'sample', check, '/plugin', fingerprint)
    const first = await run('old pin')
    if (first.kind !== 'joined') throw new Error('expected a joined check')
    expect(first.answerSince('old pin')).toEqual({ ok: true })
    expect(first.answerSince('new pin')).toBeNull()

    await checks.forget('/vault', 'sample')
    expect(first.answerSince('old pin')).toBeNull()
    const second = await run('new pin')
    if (second.kind !== 'joined') throw new Error('expected a joined check')
    expect(first.answerSince('new pin')).toEqual({ ok: true })
    expect(second.answerSince('new pin')).toEqual({ ok: true })
  })

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
    const drained = await pending
    expect(drained.kind === 'joined' && drained.answerSince('')).toBeNull()
    expect(checks.get('/vault', 'sample')).toBeNull()
    await expect(checks.run('/vault', 'sample', check, '/plugin')).resolves.toEqual({
      kind: 'stopped',
    })
    expect(checks.get('/vault', 'sample')).toBeNull()
  })
})
