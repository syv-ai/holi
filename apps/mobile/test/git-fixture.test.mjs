import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import https from 'node:https'
import { test } from 'vitest'
import { createGitFixture } from '../scripts/git-fixture.mjs'

test('fixture setup rolls back its root when certificate creation fails', async () => {
  const artifacts = await mkdtemp(join(tmpdir(), 'holi-fixture-failure-'))
  try {
    await assert.rejects(
      createGitFixture(artifacts, 'failed', {
        execute: async () => {
          throw new Error('injected certificate failure')
        },
      }),
      /injected certificate failure/,
    )
    assert.deepEqual(await readdir(artifacts), [])
  } finally {
    await rm(artifacts, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32')(
  'fixture drains a backend process group after its stdin errors',
  async () => {
    const artifacts = await mkdtemp(join(tmpdir(), 'holi-fixture-pipe-error-'))
    let fixture
    let backendPid
    let descendantPid
    let stdinErrorHandlerInstalled = false
    try {
      fixture = await createGitFixture(artifacts, 'pipe-error', {
        spawnBackend: (_command, _args, options) => {
          const descendantSource =
            "process.on('SIGTERM',()=>{});process.stdout.write('HOLI_DESCENDANT_READY:'+process.pid+'\\n');setInterval(()=>{},1000)"
          const backendSource = `
            const { spawn } = require('node:child_process')
            const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'pipe', 'inherit'] })
            descendant.stdout.pipe(process.stdout)
            setInterval(() => {}, 1000)
          `
          const child = spawn(process.execPath, ['-e', backendSource], options)
          backendPid = child.pid
          let output = ''
          child.stdout.on('data', (chunk) => {
            output += chunk
            const ready = /HOLI_DESCENDANT_READY:(\d+)\n/.exec(output)
            if (!ready || descendantPid !== undefined) return
            descendantPid = Number(ready[1])
            stdinErrorHandlerInstalled = child.stdin.listenerCount('error') > 0
            if (stdinErrorHandlerInstalled) {
              child.stdin.emit('error', new Error('injected stdin failure'))
            }
          })
          return child
        },
      })
      await new Promise((resolve, reject) => {
        const request = https.request(
          fixture.url,
          {
            method: 'GET',
            ca: readFileSync(fixture.cert),
            headers: {
              authorization: `Basic ${Buffer.from(`${fixture.username}:${fixture.password}`).toString('base64')}`,
            },
          },
          (response) => {
            response.resume()
            response.once('end', resolve)
          },
        )
        request.once('error', reject)
        request.setTimeout(2000, () => request.destroy(new Error('fixture request timed out')))
        request.end()
      })
      await fixture.close()
      assert.equal(fixture.backendFailures, 1)
      assert.equal(stdinErrorHandlerInstalled, true)
      assert.equal(typeof descendantPid, 'number')
      assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' })
      assert.throws(() => process.kill(-backendPid, 0), { code: 'ESRCH' })
    } finally {
      await fixture?.close()
      await rm(artifacts, { recursive: true, force: true })
    }
  },
)

test('fixture binds only loopback and persists redacted final evidence', async () => {
  const artifacts = await mkdtemp(join(tmpdir(), 'holi-fixture-loopback-'))
  let fixture
  try {
    fixture = await createGitFixture(artifacts, 'loopback')
    assert.match(fixture.url, /^https:\/\/127\.0\.0\.1:\d+\/fixture\.git$/)
    assert.match(fixture.invalidUrl, /^https:\/\/127\.0\.0\.1:\d+\/fixture\.git$/)
    await fixture.close()
    const manifest = await readFile(join(artifacts, 'git-fixture.json'), 'utf8')
    const evidence = JSON.parse(manifest)
    assert.equal(evidence.completed, true)
    assert.equal(evidence.authChallenges, 0)
    assert.equal(evidence.remoteAdvanced, false)
    assert.equal(evidence.backendFailures, 0)
    assert.equal(manifest.includes(fixture.password), false)
    assert.equal(manifest.includes(fixture.username), false)
  } finally {
    await fixture?.close()
    await rm(artifacts, { recursive: true, force: true })
  }
})
