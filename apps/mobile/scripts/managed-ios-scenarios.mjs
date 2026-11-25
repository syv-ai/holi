import assert from 'node:assert/strict'
import {
  writeFile,
  readFile,
  rm,
  stat,
  realpath,
  symlink,
  mkdir,
  readdir,
  cp,
  link,
} from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createManagedGitFixture } from './managed-git-fixture.mjs'

/** Real app requests, with independent host Git/filesystem assertions. */
export async function runManagedIOSScenarios({
  simulator,
  container,
  bundleId,
  artifacts,
  runId,
  command,
  signal,
}) {
  const fixture = await createManagedGitFixture(artifacts)
  const documents = join(container, 'Documents')
  const reportPath = join(documents, 'vault-format-report.json')
  const requestPath = join(documents, `managed-request-${runId}.json`)
  const outcomes = []
  let active,
    ordinal = 0
  const simctl = (...args) => command('xcrun', ['simctl', ...args])
  const stop = async () => {
    if (!active) return
    try {
      process.kill(active.pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') {
        active = undefined
        return
      }
      throw error
    }
    await simctl('terminate', simulator, bundleId)
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(active.pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') {
          active = undefined
          return
        }
        throw error
      }
      await sleep(50)
    }
    throw new Error('Owned managed app did not drain')
  }
  const wait = async (path, matches = () => true) => {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      process.kill(active.pid, 0)
      try {
        const value = JSON.parse(await readFile(path, 'utf8'))
        if (matches(value)) return value
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      }
      await sleep(100, undefined, { signal })
    }
    throw new Error(`Managed app evidence timed out: ${path}`)
  }
  const request = async (name, action, target, options = {}) => {
    await stop()
    const caseId = `${++ordinal}-${name}`
    const payload = {
      runId,
      caseId,
      action,
      target,
      endpoint: fixture.endpoint,
      username: fixture.username,
      ...options,
    }
    const token = payload.token ?? fixture.password
    delete payload.token
    await writeFile(requestPath, JSON.stringify(payload))
    await rm(reportPath, { force: true })
    const output = await command('xcrun', ['simctl', 'launch', simulator, bundleId], {
      env: {
        ...process.env,
        SIMCTL_CHILD_HOLI_COMPAT_RUN_ID: runId,
        SIMCTL_CHILD_HOLI_STORAGE_PHASE: 'managed-git',
        SIMCTL_CHILD_HOLI_MANAGED_GIT_REQUEST: requestPath,
        SIMCTL_CHILD_HOLI_MANAGED_GIT_CREDENTIAL: token,
      },
    })
    const pid = Number(output.match(/: (\d+)$/)?.[1])
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    active = { pid, caseId }
    if (options.holdAt) {
      const marker = await wait(
        join(documents, `managed-checkpoint-${runId}-${caseId}.json`),
        (value) => value.phase === options.holdAt,
      )
      assert.equal(marker.runId, runId)
      assert.equal(marker.caseId, caseId)
      assert.equal(marker.pid, pid)
      assert.equal(marker.phase, options.holdAt)
      return marker
    }
    const report = await wait(reportPath)
    assert.equal(report.runId, runId)
    assert.equal(report.phase, 'managed-git')
    assert.ok(report.managedGit, JSON.stringify(report))
    assert.equal(report.managedGit.caseId, caseId)
    assert.equal(report.managedGit.pid, pid)
    outcomes.push(report.managedGit)
    await writeFile(
      join(artifacts, 'managed-outcomes.json'),
      JSON.stringify({ runId, outcomes }, null, 2),
    )
    return report.managedGit
  }
  const targetFor = (name, branch = 'review/mobile') => ({
    remote: 'fixture/vault',
    root: join(documents, `managed-${runId}-${name}`),
    branch,
  })
  const refs = async () => fixture.git(fixture.bare, 'show-ref', '--heads')
  const passed = (result) => assert.equal(result.ok, true, JSON.stringify(result))
  const refused = (result) => assert.equal(result.ok, false, JSON.stringify(result))
  try {
    await simctl('keychain', simulator, 'add-root-cert', fixture.cert)
    const target = targetFor('selected')
    const unrelatedBefore = await fixture.git(fixture.bare, 'rev-parse', 'refs/heads/main')
    const acquired = await request('selected-clone', 'acquire', target)
    passed(acquired)
    assert.equal(acquired.identity.remote, target.remote)
    assert.equal(acquired.identity.branch, target.branch)
    assert.equal(await fixture.git(target.root, 'symbolic-ref', 'HEAD'), 'refs/heads/review/mobile')
    assert.equal(await fixture.git(target.root, 'rev-parse', 'HEAD'), fixture.selectedHead)
    assert.equal(
      await readFile(join(target.root, 'selected.md'), 'utf8'),
      'selected branch bytes\n',
    )
    assert.deepEqual(
      await readFile(join(target.root, 'assets/binary.bin')),
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    )
    assert.equal((await stat(join(target.root, 'run.sh'))).mode & 0o111, 0o111)
    assert.match(await fixture.git(target.root, 'ls-files', '--stage', 'run.sh'), /^100755 /)
    const restored = await request('cold-reopen', 'reopen', target)
    passed(restored)
    assert.equal(restored.identity.nativeId, acquired.identity.nativeId)
    const alias = `${target.root}-alias`
    await symlink(target.root, alias)
    const aliased = await request('canonical-alias', 'reopen', { ...target, root: alias })
    passed(aliased)
    assert.equal(aliased.identity.nativeId, acquired.identity.nativeId)
    await writeFile(join(fixture.seed, 'remote.md'), 'server update\n')
    await fixture.git(fixture.seed, 'add', 'remote.md')
    await fixture.git(fixture.seed, 'commit', '-m', 'server update')
    await fixture.git(fixture.seed, 'push', fixture.bare, 'HEAD:refs/heads/review/mobile')
    const advanced = await fixture.git(fixture.seed, 'rev-parse', 'HEAD')
    passed(await request('fetch-selected', 'fetch', target))
    assert.equal(await fixture.git(target.root, 'rev-parse', 'HEAD'), fixture.selectedHead)
    assert.equal(
      await fixture.git(target.root, 'rev-parse', 'refs/remotes/origin/review/mobile'),
      advanced,
    )
    await assert.rejects(readFile(join(target.root, 'remote.md')), { code: 'ENOENT' })
    const beforeRejection = await refs()
    refused(await request('reject-behind', 'publish', target))
    assert.equal(await refs(), beforeRejection)
    await fixture.git(target.root, 'reset', '--hard', 'refs/remotes/origin/review/mobile')
    await fixture.git(target.root, 'config', 'user.name', 'Holi fixture')
    await fixture.git(target.root, 'config', 'user.email', 'fixture@example.invalid')
    await writeFile(join(target.root, 'client.md'), 'client update\n')
    await writeFile(join(target.root, 'machine.local.md'), 'machine-only fixture bytes\n')
    await fixture.git(target.root, 'add', 'client.md')
    await fixture.git(target.root, 'commit', '-m', 'client update')
    const outgoing = await fixture.git(target.root, 'rev-parse', 'HEAD')
    passed(await request('publish-selected', 'publish', target))
    assert.equal(await fixture.git(fixture.bare, 'rev-parse', 'refs/heads/review/mobile'), outgoing)
    assert.equal(await fixture.git(fixture.bare, 'rev-parse', 'refs/heads/main'), unrelatedBefore)
    assert.equal(await fixture.git(fixture.bare, 'show', `${outgoing}:client.md`), 'client update')
    assert.equal(
      await readFile(join(target.root, 'machine.local.md'), 'utf8'),
      'machine-only fixture bytes\n',
    )
    await assert.rejects(
      fixture.git(fixture.bare, 'cat-file', '-e', `${outgoing}:machine.local.md`),
    )
    passed(await request('refresh-base', 'fetch', target))
    await writeFile(join(target.root, '.env'), 'protected fixture bytes\n')
    await fixture.git(target.root, 'add', '--force', '.env')
    await fixture.git(target.root, 'commit', '-m', 'historical protected content')
    await rm(join(target.root, '.env'))
    await fixture.git(target.root, 'add', '-u')
    await fixture.git(target.root, 'commit', '-m', 'remove protected content')
    const traffic = fixture.requests.length
    const privacy = await request('reject-hidden-history', 'publish', target)
    refused(privacy)
    assert.equal(privacy.refusal.code, 'protected-content')
    assert.equal(fixture.requests.length, traffic)
    assert.equal(await fixture.git(fixture.bare, 'rev-parse', 'refs/heads/review/mobile'), outgoing)
    const linked = targetFor('linked-reflog')
    passed(await request('linked-reflog-clone', 'acquire', linked))
    const reflog = join(linked.root, '.git/logs/refs/remotes/origin/review/mobile')
    await mkdir(dirname(reflog), { recursive: true })
    const originalLog = await readFile(reflog).catch((error) => {
      if (error.code === 'ENOENT') return Buffer.alloc(0)
      throw error
    })
    const sentinel = join(documents, `unowned-sentinel-${runId}.local.md`)
    await writeFile(sentinel, originalLog)
    await rm(reflog, { force: true })
    await link(sentinel, reflog)
    await fixture.git(fixture.seed, 'fetch', fixture.bare, 'refs/heads/review/mobile')
    await fixture.git(fixture.seed, 'reset', '--hard', 'FETCH_HEAD')
    await writeFile(join(fixture.seed, 'reflog-advance.md'), 'independent server advance\n')
    await fixture.git(fixture.seed, 'add', 'reflog-advance.md')
    await fixture.git(fixture.seed, 'commit', '-m', 'advance reflog')
    await fixture.git(fixture.seed, 'push', fixture.bare, 'HEAD:refs/heads/review/mobile')
    const linkTraffic = fixture.requests.length
    const linkedFetch = await request('linked-reflog-refusal', 'fetch', linked)
    assert.deepEqual(
      await readFile(sentinel),
      originalLog,
      'Fetch modified an unowned hardlink target',
    )
    assert.deepEqual(await readFile(reflog), originalLog)
    refused(linkedFetch)
    assert.equal(fixture.requests.length, linkTraffic)
    assert.equal(
      await fixture.git(linked.root, 'rev-parse', 'refs/remotes/origin/review/mobile'),
      outgoing,
    )
    for (const branch of fixture.protectedBranches) {
      const blocked = targetFor(branch.replace('/', '-'), branch)
      refused(await request(`reject-${branch.replace('/', '-')}`, 'acquire', blocked))
      await assert.rejects(stat(blocked.root), { code: 'ENOENT' })
    }
    const collision = targetFor('collision')
    await mkdir(collision.root)
    await writeFile(join(collision.root, 'user.md'), 'preserve existing bytes')
    refused(await request('existing-content', 'acquire', collision))
    assert.equal(await readFile(join(collision.root, 'user.md'), 'utf8'), 'preserve existing bytes')
    refused(
      await request('bad-auth', 'acquire', targetFor('bad-auth'), {
        token: 'invalid-disposable-token',
      }),
    )
    for (const name of ['missing', 'forbidden', 'drop', 'redirect']) {
      const failed = { ...targetFor(name), remote: `fixture/${name}` }
      refused(
        await request(name, 'acquire', failed, {
          endpoint: `${fixture.origin}/fixture/${name}.git`,
        }),
      )
    }
    assert.equal(fixture.collectorRequests, 0)
    assert.equal(fixture.collectorConnections, 0)
    for (const phase of ['before-publication', 'after-publication']) {
      const interrupted = targetFor(phase)
      const marker = await request(`kill-${phase}`, 'acquire', interrupted, { holdAt: phase })
      const app = await simctl('get_app_container', simulator, bundleId, 'app')
      const executable = await command('ps', ['-p', String(active.pid), '-o', 'comm='])
      assert.equal(await realpath(executable), await realpath(join(app, 'mobile')))
      process.kill(active.pid, 'SIGKILL')
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(active.pid, 0)
        } catch (error) {
          if (error.code === 'ESRCH') {
            active = undefined
            break
          }
          throw error
        }
        await sleep(50)
      }
      assert.equal(active, undefined)
      if (phase === 'before-publication') {
        await assert.rejects(stat(interrupted.root), { code: 'ENOENT' })
        assert.equal(
          await readFile(join(marker.paths.stage, 'selected.md'), 'utf8'),
          'selected branch bytes\n',
        )
        await writeFile(
          join(marker.paths.stage, 'retained.local.md'),
          'interrupted machine-local bytes',
        )
      }
      const recovered = await request(`recover-${phase}`, 'acquire', interrupted)
      passed(recovered)
      assert.equal(
        await fixture.git(interrupted.root, 'symbolic-ref', 'HEAD'),
        'refs/heads/review/mobile',
      )
      if (phase === 'before-publication')
        assert.equal(
          await readFile(join(interrupted.root, 'retained.local.md'), 'utf8'),
          'interrupted machine-local bytes',
        )
      assert.ok((await readdir(marker.paths.container)).includes('.holi-acquisition.json'))
    }
    assert.equal(fixture.backendFailures, 0)
    const proof = {
      runId,
      cases: outcomes.length,
      branch: target.branch,
      binaryBytes: 256,
      executableMode: '100755',
      unrelatedRefPreserved: true,
      hardlinkedReflogRefused: true,
      selectedClone: fixture.selectedHead,
      fetched: advanced,
      published: outgoing,
      collectorRequests: fixture.collectorRequests,
      ownedCleanup: false,
    }
    await writeFile(join(artifacts, 'managed-proof.json'), JSON.stringify(proof, null, 2))
    return proof
  } catch (error) {
    await writeFile(
      join(artifacts, 'managed-http.json'),
      JSON.stringify(
        { requests: fixture.requests, backendFailures: fixture.backendFailures },
        null,
        2,
      ),
    )
    await cp(documents, join(artifacts, 'managed-failure-documents'), {
      recursive: true,
      dereference: false,
      force: false,
      errorOnExist: true,
    })
    throw error
  } finally {
    try {
      await stop()
    } finally {
      try {
        await fixture.close()
      } finally {
        await rm(requestPath, { force: true })
      }
    }
  }
}
