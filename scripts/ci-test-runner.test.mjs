import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const runner = fileURLToPath(new URL('./ci-test-runner.mjs', import.meta.url))

async function launch(t, command, args = [], env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'holi-ci-observer-'))
  const child = spawn(process.execPath, [runner, directory, command, ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk
  })
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  t.after(async () => {
    if (!child.stdin.destroyed) child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await completion
    await rm(directory, { recursive: true, force: true })
  })
  return {
    child,
    completion,
    async events() {
      const text = await readFile(join(directory, 'events.jsonl'), 'utf8')
      return {
        text,
        events: text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      }
    },
  }
}

test(
  'streams successful output and retains safe resource and completion evidence',
  { timeout: 10_000 },
  async (t) => {
    const secret = 'fixture-private-argument-and-environment'
    const run = await launch(
      t,
      process.execPath,
      ['-e', "console.log(process.argv.at(-1)); console.error('child-stderr')", secret],
      { PRIVATE_OBSERVER_FIXTURE: secret },
    )
    const result = await run.completion
    assert.equal(result.code, 0)
    assert.ok(result.stdout.includes(secret))
    assert.ok(result.stderr.includes('child-stderr'))
    const { text, events } = await run.events()
    assert.ok(!text.includes(secret))
    assert.ok(events.some((event) => event.event === 'start'))
    const resources = events.find((event) => event.event === 'resources')
    assert.ok(resources.totalBytes > 0 && resources.freeBytes >= 0)
    assert.ok(resources.load.every(Number.isFinite))
    assert.ok(
      events.every((event) => Number.isFinite(Date.parse(event.timestamp)) && event.elapsedMs >= 0),
    )
    assert.equal(events.at(-1).event, 'exit')
    assert.equal(events.at(-1).code, 0)
  },
)

test(
  'preserves a failing child exit instead of reporting observer success',
  { timeout: 10_000 },
  async (t) => {
    const run = await launch(t, process.execPath, ['-e', 'process.exitCode = 7'])
    assert.equal((await run.completion).code, 7)
    assert.equal((await run.events()).events.at(-1).code, 7)
  },
)

test('reports failure when the test command cannot start', { timeout: 10_000 }, async (t) => {
  const run = await launch(t, join(tmpdir(), 'holi-observer-nonexistent-command'))
  assert.notEqual((await run.completion).code, 0)
  assert.ok(
    (await run.events()).events.some(
      (event) => event.event === 'spawn-error' && event.errorCode === 'ENOENT',
    ),
  )
})

test(
  'propagates child interruption and forwards POSIX wrapper termination',
  { timeout: 10_000 },
  async (t) => {
    if (process.platform === 'win32') {
      const run = await launch(t, process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"])
      assert.notEqual((await run.completion).code, 0)
      const exit = (await run.events()).events.at(-1)
      assert.ok(exit.signal || exit.code !== 0)
      return
    }
    const run = await launch(t, process.execPath, [
      '-e',
      "process.on('SIGTERM', () => { console.log('termination-received'); process.exit(0) }); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); console.log('child-ready')",
    ])
    await new Promise((resolve) => {
      let output = ''
      run.child.stdout.on('data', (chunk) => {
        output += chunk
        if (output.includes('child-ready')) resolve()
      })
    })
    run.child.kill('SIGTERM')
    const result = await run.completion
    assert.equal(result.code, 143)
    assert.ok(result.stdout.includes('termination-received'))
    assert.equal((await run.events()).events.at(-1).terminationSignal, 'SIGTERM')
  },
)

if (process.platform !== 'win32') {
  test(
    'survives test process-group death and records its failing signal',
    { timeout: 10_000 },
    async (t) => {
      const run = await launch(t, process.execPath, ['-e', "process.kill(-process.pid, 'SIGKILL')"])
      assert.equal((await run.completion).code, 137)
      assert.equal((await run.events()).events.at(-1).signal, 'SIGKILL')
    },
  )

  test(
    'cancellation drains a resistant test process group including grandchildren',
    { timeout: 10_000 },
    async (t) => {
      const descendant =
        "process.on('SIGTERM', () => {}); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); console.log('descendant-ready')"
      const root = `process.on('SIGTERM', () => {}); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' })`
      const run = await launch(t, process.execPath, ['-e', root])
      await new Promise((resolve) => {
        let output = ''
        run.child.stdout.on('data', (chunk) => {
          output += chunk
          if (output.includes('descendant-ready')) resolve()
        })
      })
      run.child.kill('SIGTERM')
      const result = await run.completion
      assert.equal(result.code, 143)
      const exit = (await run.events()).events.at(-1)
      assert.equal(exit.terminationSignal, 'SIGTERM')
      assert.equal(exit.signal, 'SIGKILL')
    },
  )
}
