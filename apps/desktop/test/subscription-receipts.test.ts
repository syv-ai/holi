import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { openRepo } from '../src/main/git'
import { createSubscriptionReceipts } from '../src/main/vault/subscription-receipts'

const exec = promisify(execFile)
let root: string

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

async function repository(text = 'first\n') {
  root = await mkdtemp(join(tmpdir(), 'subscription-receipt-'))
  await exec('git', ['init', '-b', 'main', root])
  for (const [key, value] of Object.entries({
    'user.name': 'Test',
    'user.email': 'test@example.invalid',
    'commit.gpgsign': 'false',
  }))
    await exec('git', ['-C', root, 'config', key, value])
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'notes/a.md'), text)
  await exec('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/test/vault.git'])
  await commit()
  return openRepo(root)
}

async function commit() {
  await exec('git', ['-C', root, 'add', '-A'])
  await exec('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'update'])
}

const remote = 'test/vault'

describe('subscription display receipts', () => {
  it('returns readable text without acknowledging it, and binds proof to captured commit', async () => {
    const repo = await repository()
    const scope = { path: 'notes', baseline: await repo.head() }
    const receipts = createSubscriptionReceipts()
    const valid = () => true
    const initial = await receipts.capture({
      repo,
      root,
      remote,
      path: 'notes/a.md',
      scope,
      valid,
    })
    expect(initial.text).toBe('first\n')
    expect(initial.receipt).toBeTruthy()

    await writeFile(join(root, 'notes/a.md'), 'second\n')
    await commit()
    const captured = receipts.consume(initial.receipt!, {
      remote,
      root,
      path: 'notes/a.md',
      scope: JSON.stringify(scope),
    })
    expect(captured?.revision).toBeTruthy()
    expect(await repo.show(captured!.revision, 'notes/a.md')).toBe('first\n')
    expect(
      receipts.consume(initial.receipt!, {
        remote,
        root,
        path: 'notes/a.md',
        scope: JSON.stringify(scope),
      }),
    ).toBeNull()
  })

  it('issues proof for committed empty text and refuses a replacement object at the same path', async () => {
    const repo = await repository('')
    const scope = { path: 'notes', baseline: await repo.head() }
    const receipts = createSubscriptionReceipts()
    const args = { repo, root, remote, path: 'notes/a.md', scope, valid: () => true }
    const empty = await receipts.capture(args)
    expect(empty).toMatchObject({ text: '', receipt: expect.any(String) })

    await writeFile(join(root, 'notes/a.md'), 'replacement\n')
    await commit()
    const replacementSha = await repo.head()
    await exec('git', ['-C', root, 'reset', '--hard', scope.baseline!])
    await writeFile(join(root, 'notes/a.md'), 'replacement\n')
    await exec('git', ['-C', root, 'replace', scope.baseline!, replacementSha!])
    const replacement = await receipts.capture(args)
    expect(replacement.text).toBe('replacement\n')
    expect(replacement.receipt).toBeNull()
  })

  it('returns readable text without proof when baseline history or repository objects are unavailable', async () => {
    const repo = await repository()
    const receipts = createSubscriptionReceipts()
    const args = { repo, root, remote, path: 'notes/a.md', valid: () => true }
    expect(
      await receipts.capture({ ...args, scope: { path: 'notes', baseline: 'a'.repeat(40) } }),
    ).toEqual({ text: 'first\n', receipt: null })
    const baseline = await repo.head()
    await rm(join(root, '.git'), { recursive: true, force: true })
    expect(await receipts.capture({ ...args, scope: { path: 'notes', baseline } })).toEqual({
      text: 'first\n',
      receipt: null,
    })
    await rm(join(root, 'notes/a.md'))
    await expect(receipts.capture({ ...args, scope: null })).rejects.toThrow()
  })

  it('does not issue proof for dirty, unsubscribed, or invalidated display context', async () => {
    const repo = await repository('committed\n')
    const scope = { path: 'notes', baseline: await repo.head() }
    const receipts = createSubscriptionReceipts()
    const args = { repo, root, remote, path: 'notes/a.md', valid: () => true }
    await writeFile(join(root, 'notes/a.md'), 'dirty\n')
    expect((await receipts.capture({ ...args, scope })).receipt).toBeNull()
    expect((await receipts.capture({ ...args, scope: null })).receipt).toBeNull()
    expect((await receipts.capture({ ...args, scope, valid: () => false })).receipt).toBeNull()
  })
})
