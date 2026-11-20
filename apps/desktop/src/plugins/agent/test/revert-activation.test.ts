import { A, B, adapters, deferred, nestedErrors, rig } from './activation-fixture'

import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withFileLock } from '../../../main/vault/vault-files'

describe('activation-owned revert', () => {
  it('makes the admitted revert with a real Git commit in A only', async () => {
    const userData = await mkdtemp('/private/tmp/h674-')
    const { enter, call, roots } = await rig(userData, undefined, true)
    for (const remote of [A, B] as const) {
      await writeFile(join(roots[remote], 'same.md'), 'before')
      execFileSync('git', ['-C', roots[remote], 'add', 'same.md'])
      execFileSync('git', ['-C', roots[remote], 'commit', '-qm', 'same fixture'])
    }
    const head = (remote: typeof A | typeof B) =>
      execFileSync('git', ['-C', roots[remote], 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const beforeA = head(A)
    const beforeB = head(B)
    await enter(A)
    await expect(call(A, 'agent.revert', { path: 'same.md', text: 'A restored' })).resolves.toEqual(
      {
        ok: true,
      },
    )
    expect(head(A)).not.toBe(beforeA)
    expect(head(B)).toBe(beforeB)
    expect(
      execFileSync('git', ['-C', roots[A], 'log', '-1', '--format=%s'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('agent revert')
    expect(await readFile(join(roots[A], 'same.md'), 'utf8')).toBe('A restored')
    expect(await readFile(join(roots[B], 'same.md'), 'utf8')).toBe('before')
  })

  it('holds stop and replacement behind a locked revert while vault B writes the same path', async () => {
    const userData = await mkdtemp('/private/tmp/h674-')
    const { host, enter, replace, call, roots, registry } = await rig(userData, undefined, true)
    await writeFile(join(roots[A], 'shared.md'), 'A before')
    await writeFile(join(roots[B], 'shared.md'), 'B before')
    for (const remote of [A, B] as const) {
      execFileSync('git', ['-C', roots[remote], 'add', 'shared.md'])
      execFileSync('git', ['-C', roots[remote], 'commit', '-qm', 'shared fixture'])
    }
    const head = (remote: typeof A | typeof B) =>
      execFileSync('git', ['-C', roots[remote], 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const beforeA = head(A)
    await enter(A)
    let releaseLock!: () => void
    let lockEntered!: () => void
    const locked = new Promise<void>((resolve) => (lockEntered = resolve))
    const release = new Promise<void>((resolve) => (releaseLock = resolve))
    const holding = withFileLock(join(roots[A], 'shared.md'), async () => {
      lockEntered()
      await release
    })
    await locked
    expect(registry.has('agent.revert', A)).toBe(true)
    const revertA = call(A, 'agent.revert', { path: 'shared.md', text: 'A after' })
    await new Promise((resolve) => setImmediate(resolve))
    await enter(B)
    const b = await call(B, 'agent.revert', { path: 'shared.md', text: 'B after' })
    expect(b).toEqual({ ok: true })
    const afterB = head(B)
    const stopping = host.stop(A)
    const replacement = replace(A)
    let stopped = false
    let replaced = false
    void stopping.then(() => (stopped = true))
    void replacement.then(() => (replaced = true))
    await new Promise((resolve) => setImmediate(resolve))
    expect(stopped).toBe(false)
    expect(replaced).toBe(false)
    expect(host.displayed()).toBe(B)
    releaseLock()
    await Promise.all([holding, revertA, stopping, replacement])
    expect(await readFile(join(roots[A], 'shared.md'), 'utf8')).toBe('A after')
    expect(await readFile(join(roots[B], 'shared.md'), 'utf8')).toBe('B after')
    expect(head(A)).not.toBe(beforeA)
    expect(head(B)).toBe(afterB)
    expect(
      execFileSync('git', ['-C', roots[A], 'log', '-1', '--format=%s'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('agent revert')
  })

  it('retains the native Git commit failure after the revert already wrote the file', async () => {
    const userData = await mkdtemp('/private/tmp/h674-')
    const { host, enter, call, roots, expectFailedDrain } = await rig(userData, undefined, true)
    await writeFile(join(roots[A], 'committed.md'), 'before')
    const hooks = join(userData, 'hooks')
    await mkdir(hooks)
    const hook = join(hooks, 'pre-commit')
    await writeFile(hook, '#!/bin/sh\nexit 1\n')
    await chmod(hook, 0o755)
    execFileSync('git', ['-C', roots[A], 'config', 'core.hooksPath', hooks])
    await enter(A)
    const mutationError = await call(A, 'agent.revert', {
      path: 'committed.md',
      text: 'written before commit failed',
    }).catch((error: unknown) => error)
    expect(mutationError).toBeInstanceOf(Error)
    expect(await readFile(join(roots[A], 'committed.md'), 'utf8')).toBe(
      'written before commit failed',
    )
    expectFailedDrain()
    const stopped = await host.stop(A).catch((error: unknown) => error)
    expect(nestedErrors(stopped)).toContain(mutationError)
    await expect(host.stop(A)).rejects.toBe(stopped)
    await expect(enter(A)).rejects.toBe(stopped)
  })

  it('drains deletion through a file lock while the other vault keeps the same path', async () => {
    const userData = await mkdtemp('/private/tmp/h674-delete-')
    const { host, enter, call, roots } = await rig(userData, undefined, true)
    await writeFile(join(roots[A], 'shared.md'), 'A before')
    await writeFile(join(roots[B], 'shared.md'), 'B before')
    for (const remote of [A, B] as const) {
      execFileSync('git', ['-C', roots[remote], 'add', 'shared.md'])
      execFileSync('git', ['-C', roots[remote], 'commit', '-qm', 'shared fixture'])
    }
    await enter(A)
    let unlock!: () => void
    let entered!: () => void
    const locked = new Promise<void>((resolve) => (entered = resolve))
    const release = new Promise<void>((resolve) => (unlock = resolve))
    const holding = withFileLock(join(roots[A], 'shared.md'), async () => {
      entered()
      await release
    })
    await locked
    const deletion = call(A, 'agent.revert', { path: 'shared.md', delete: true })
    await new Promise((resolve) => setImmediate(resolve))
    await enter(B)
    await expect(call(B, 'agent.revert', { path: 'shared.md', text: 'B kept' })).resolves.toEqual({
      ok: true,
    })
    const stopping = host.stop(A)
    const replacement = enter(A)
    unlock()
    await Promise.all([holding, deletion, stopping, replacement])
    await expect(readFile(join(roots[A], 'shared.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(join(roots[B], 'shared.md'), 'utf8')).toBe('B kept')
  })

  it.each(['read', 'delete'] as const)(
    'retains a native %s failure on the admitted activation',
    async (operation) => {
      const userData = await mkdtemp('/private/tmp/h674-')
      const { host, enter, call, roots, expectFailedDrain } = await rig(userData, undefined, true)
      await writeFile(join(roots[A], 'native.md'), 'before')
      execFileSync('git', ['-C', roots[A], 'add', 'native.md'])
      execFileSync('git', ['-C', roots[A], 'commit', '-qm', 'tracked fixture'])
      await enter(A)
      const nativeFailure = new Error(`native ${operation} failed`)
      if (operation === 'read')
        adapters.readGates.push({ fragment: 'native.md', error: nativeFailure })
      else adapters.removeGates.push({ fragment: 'native.md', error: nativeFailure })
      const mutation = await call(
        A,
        'agent.revert',
        operation === 'delete'
          ? { path: 'native.md', delete: true }
          : { path: 'native.md', base: 'before', text: 'after' },
      ).catch((error: unknown) => error)
      expect(mutation).toBe(nativeFailure)
      expectFailedDrain()
      const stopped = await host.stop(A).catch((error: unknown) => error)
      expect(nestedErrors(stopped)).toContain(nativeFailure)
      await expect(host.stop(A)).rejects.toBe(stopped)
      await expect(enter(A)).rejects.toBe(stopped)
    },
  )

  it('keeps conflict and invalid-path refusals non-poisoning, but retains an admitted write failure', async () => {
    const userData = await mkdtemp('/private/tmp/h674-failure-')
    const { host, enter, replace, call, roots, expectFailedDrain } = await rig(
      userData,
      undefined,
      true,
    )
    await writeFile(join(roots[A], 'note.md'), 'changed elsewhere')
    const outside = join(userData, 'outside.md')
    await writeFile(outside, 'outside the vault')
    await symlink(outside, join(roots[A], 'outside-link.md'))
    await enter(A)
    await expect(
      call(A, 'agent.revert', { path: 'note.md', base: 'original', text: 'reviewed' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call(A, 'agent.revert', { path: '../outside.md', delete: true })).rejects.toThrow()
    await expect(
      call(A, 'agent.revert', { path: 'outside-link.md', text: 'must not escape' }),
    ).rejects.toThrow()
    await expect(host.stop(A)).resolves.toBeUndefined()
    await enter(A)

    const entered = deferred()
    const release = deferred()
    const failure = new Error('delayed revert write failure')
    adapters.writeGates.push({
      fragment: `${roots[A]}/`,
      entered: entered.resolve,
      wait: release.promise,
      error: failure,
    })
    adapters.writeGateReleases.push(release.resolve)
    const mutation = call(A, 'agent.revert', { path: 'note.md', text: 'replacement' }).catch(
      (error: unknown) => error,
    )
    await entered.promise
    expectFailedDrain()
    const stopping = host.stop(A).catch((error: unknown) => error)
    let replacementSettled = false
    const replacement = replace(A).then(
      () => {
        replacementSettled = true
        return undefined
      },
      (error: unknown) => {
        replacementSettled = true
        return error
      },
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(replacementSettled).toBe(false)
    release.resolve()
    const [mutationError, stopError, replacementError] = await Promise.all([
      mutation,
      stopping,
      replacement,
    ])
    expect(mutationError).toBe(failure)
    expect(replacementError).toBe(stopError)
    expect(stopError).toBeInstanceOf(AggregateError)
    expect(nestedErrors(stopError)).toContain(failure)
    await expect(host.stop(A)).rejects.toBe(stopError)
    await expect(enter(A)).rejects.toBe(stopError)
  })
})
