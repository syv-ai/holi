import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startOwnedPty } from './pi-native-tui-process.mjs'

const posix = { skip: process.platform === 'win32' }
async function fixture(context, command, args, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'holi-660-owned-pty-test-'))
  const handle = await startOwnedPty({
    command,
    args,
    cwd: root,
    env: { PATH: process.env.PATH ?? '', HOME: root, TERM: 'xterm-256color', ...options.env },
    stateDirectory: root,
    timeoutMs: options.timeoutMs ?? 5000,
    terminalSize: options.terminalSize,
    maxOutputBytes: options.maxOutputBytes ?? 262144,
  })
  context.after(async () => {
    try {
      const receipt = await handle.close()
      assert.equal(receipt.drained, true)
      await rm(root, { recursive: true })
    } catch (error) {
      context.diagnostic(`Retained owned PTY state: ${root}`)
      throw error
    }
  })
  return { handle, stateDirectory: root }
}
function assertGone(receipt) {
  for (const pid of [receipt.supervisorPid, receipt.anchorPid, receipt.nativePid].filter(Boolean))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
}

test(
  'short-lived native child is reaped before releasing its anchored process group',
  posix,
  async (t) => {
    const { handle } = await fixture(t, '/bin/sh', ['-c', 'printf "done\\n"'])
    assert.equal((await handle.waitForExit()).code, 0)
    const receipt = await handle.close()
    assert.match(handle.output.toString(), /done/)
    assertGone(receipt)
    assert.deepEqual(await handle.close(), receipt)
  },
)

test('native applications observe the requested PTY dimensions', posix, async (t) => {
  const { handle } = await fixture(t, '/bin/sh', ['-c', 'stty size'], {
    terminalSize: { rows: 40, columns: 120 },
  })
  assert.equal((await handle.waitForExit()).code, 0)
  assert.equal(handle.output.toString().trim(), '40 120')
  assertGone(await handle.close())
})

test(
  'forwards real raw PTY input through a separate acknowledged control channel',
  posix,
  async (t) => {
    const { handle } = await fixture(t, '/bin/sh', [
      '-c',
      'IFS= read -r line; printf "reply:%s\\n" "$line"',
    ])
    await handle.write('typed\n')
    assert.equal((await handle.waitForExit()).code, 0)
    const receipt = await handle.close()
    assert.match(handle.output.toString(), /reply:typed/)
    assertGone(receipt)
  },
)

test(
  'deadline is sticky and TERM-resistant native child and descendant are drained',
  posix,
  async (t) => {
    const { handle } = await fixture(
      t,
      '/bin/sh',
      [
        '-c',
        'trap "" TERM; (trap "" TERM; while :; do sleep 1; done) & echo DESCENDANT:$!; while :; do sleep 1; done',
      ],
      { timeoutMs: 1000 },
    )
    await assert.rejects(handle.waitForExit(), /deadline/)
    const descendant = Number(/DESCENDANT:(\d+)/.exec(handle.output.toString())?.[1])
    assert.ok(descendant > 1)
    const receipt = await handle.close()
    assertGone(receipt)
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' })
    await assert.rejects(handle.waitForExit(), /deadline/)
  },
)

test('output overflow remains failure after verified cleanup', posix, async (t) => {
  const { handle } = await fixture(t, '/bin/sh', ['-c', 'while :; do printf 1234567890; done'], {
    maxOutputBytes: 64,
  })
  await assert.rejects(handle.waitForExit(), /exceeded/)
  assertGone(await handle.close())
  await assert.rejects(handle.waitForExit(), /exceeded/)
})

test('native exec failure still reaps the producer and session anchor', posix, async (t) => {
  const { handle } = await fixture(t, '/definitely/not/here', [])
  assert.notEqual((await handle.waitForExit()).code, 0)
  assertGone(await handle.close())
})

test(
  'late input after native exit or close fails without losing ownership cleanup',
  posix,
  async (t) => {
    const { handle } = await fixture(t, '/bin/sh', ['-c', 'exit 0'])
    await handle.waitForExit()
    await assert.rejects(handle.write('late-before-release'), /closed/)
    assertGone(await handle.close())
    await assert.rejects(handle.write('late'), /closed/)
  },
)

test(
  'supervisor interruption is sticky even during close with a zero-exiting native child',
  posix,
  async (t) => {
    const { handle, stateDirectory } = await fixture(t, '/bin/sh', [
      '-c',
      'trap "exit 0" TERM; echo READY; while :; do sleep 1; done',
    ])
    const until = Date.now() + 2000
    while (!handle.output.toString().includes('READY')) {
      assert.ok(Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const { supervisorPid } = JSON.parse(
      await readFile(join(stateDirectory, 'owned-pty.json'), 'utf8'),
    )
    const closing = handle.close()
    process.kill(supervisorPid, 'SIGTERM')
    const receipt = await closing
    assertGone(receipt)
    assert.match(handle.failure?.message ?? '', /supervisor interrupted/)
    await assert.rejects(handle.waitForExit(), /supervisor interrupted/)
  },
)

test(
  'supervisor spawn failure is a positively absent lifecycle, not an unknown native group',
  posix,
  async (t) => {
    const { handle } = await fixture(t, '/bin/sh', [], { env: { PATH: '/definitely/missing' } })
    await assert.rejects(handle.waitForExit(), /spawn failed/)
    const receipt = await handle.close()
    assert.equal(receipt.started, false)
    assert.equal(receipt.drained, true)
  },
)
