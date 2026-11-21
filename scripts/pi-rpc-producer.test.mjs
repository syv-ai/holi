import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { checkPiRpcProducer } from './pi-rpc-producer.mjs'
import { leaseBuildScript } from './producer-command.mjs'

async function checkFixture(t, params, adapter) {
  const roots = new Set()
  t.after(() => {
    // Every adapter is an in-memory ChildProcess fake. No kernel resources
    // were admitted; the test that owns these roots can remove them.
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })
  const result = await checkPiRpcProducer({
    ...params,
    adapter: {
      spawnChild(command, args, options) {
        roots.add(dirname(options.env.PI_NATIVE_PROBE_EVIDENCE))
        return adapter.spawnChild(command, args, options)
      },
      probePresence: adapter.probePresence,
    },
  })
  assert.deepEqual(adapter.commands[0][1], [leaseBuildScript])
  return result
}

const posixTest = process.platform === 'win32' ? test.skip : test
const cleanup = { piRunDrained: true, fixtureServerClosed: true, localRootRemoved: true }
const good = {
  observedVersion: '1.0.0',
  expectedVersion: '1.0.0',
  package: '@earendil-works/pi-coding-agent',
  scenarios: {
    ...Object.fromEntries(
      [
        'streamCompletion',
        'consecutiveTurns',
        'modelError',
        'cancel',
        'noToolsRequest',
        'appendSystemPrompt',
        'statsResponse',
        'steerAndFollowUp',
      ].map((key) => [key, 'pass']),
    ),
    modelErrorReported: true,
  },
  recordCount: 5,
  commandCount: 2,
  records: [
    { type: 'agent_start' },
    { type: 'agent_settled' },
    { type: 'response', command: 'set_model', success: true },
    { type: 'response', command: 'prompt', success: true },
    { type: 'response', command: 'get_session_stats', success: true },
  ],
  commands: [{ argv: ['--no-tools'], noTools: true }, { type: 'abort' }],
  tools: [],
  cleanup,
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const rolesInOrder = ['version', 'rpc-first', 'rpc-cancel']
const fakeNativeIds = [1910000000, 1910000001, 1910000002]
const cachePath = (root, { id, role }) => join(root, 'admissions', `${role}-${id}`, 'proof.json')
const readCache = (root, lease) => JSON.parse(readFileSync(cachePath(root, lease), 'utf8'))
function writeCache(root, lease, cache) {
  const bytes = JSON.stringify(cache)
  writeFileSync(cachePath(root, lease), bytes, { mode: 0o600 })
  lease.proofSha256 = sha256(bytes)
}

function writeArtifact(env, workerPid, evidence, options) {
  const { roles = rolesInOrder, change, coldRole } = options ?? {}
  const root = dirname(env.PI_NATIVE_PROBE_EVIDENCE)
  const bytes = typeof evidence === 'string' ? evidence : JSON.stringify(evidence)
  const worker = {
    version: 1,
    runId: env.PI_NATIVE_PROBE_RUN_ID,
    nonce: env.PI_NATIVE_PROBE_NONCE,
    workerPid,
  }
  const leases = roles.map((role) => {
    const id = randomUUID()
    const proof = role === coldRole ? 'kernel-absence' : 'settled'
    const lease = { role, id, proof }
    const [pid, reaper, anchor] = fakeNativeIds
    const header = `HOLI-POSIX-1 ${id}\n`
    const journal = `${header}ROOT ${pid}\nREAPER ${reaper}\nANCHOR ${anchor}\nCOMPLETE\n`
    const settled = `${header}SETTLED\n`
    const path = join(root, 'ownership', id)
    mkdirSync(join(root, 'admissions', `${role}-${id}`), { mode: 0o700 })
    mkdirSync(path, { mode: 0o700 })
    writeFileSync(join(path, 'journal'), journal, { mode: 0o600 })
    if (proof === 'settled') writeFileSync(join(path, 'settled'), settled, { mode: 0o600 })
    writeCache(root, lease, {
      ...worker,
      id,
      role,
      journal,
      ...(proof === 'settled'
        ? { settled }
        : {
            absenceSnapshot: {
              protocol: 'posix-kill-0',
              absent: [reaper, -reaper, anchor, pid, -pid],
            },
          }),
    })
    return lease
  })
  writeFileSync(env.PI_NATIVE_PROBE_EVIDENCE, bytes, { mode: 0o600 })
  writeFileSync(join(root, 'worker.json'), JSON.stringify(worker), { mode: 0o600 })
  const receipt = {
    ...worker,
    state: 'final',
    admission: leases.length ? 'leases-settled' : 'no-admission',
    leases,
    evidenceSha256: sha256(bytes),
  }
  const record = change ? change(receipt, root) : receipt
  if (record !== undefined)
    writeFileSync(
      join(root, 'settlement.json'),
      typeof record === 'string' ? record : JSON.stringify(record),
      { mode: 0o600 },
    )
}

function artifactRunner(evidence, { code = 0, ...options } = {}) {
  return fakeProcess({
    onWorker({ child, close, fakePid, env }) {
      child.pid = fakePid
      child.emit('spawn')
      writeArtifact(env, fakePid + 1, evidence, options)
      close(code)
    },
  })
}

function retained(result) {
  assert.equal(result.cleanup.status, 'incomplete')
  assert.equal(result.cleanup.temporaryRootRemoved, false)
  assert.ok(existsSync(result.cleanup.retainedRoot))
}

test('requires exact Pi version and binary for native producer probe', async () => {
  await assert.rejects(checkPiRpcProducer({}), /binary and exact expected version/)
  await assert.rejects(
    checkPiRpcProducer({ bin: '/missing/pi' }),
    /binary and exact expected version/,
  )
})

posixTest(
  'removes the root with complete worker, lease and RPC evidence, without re-probing detached PIDs',
  async (t) => {
    t.mock.method(process, 'kill', () => assert.fail('parent re-probed a cached native proof'))
    const adapter = artifactRunner(good)
    const result = await checkFixture(t, input, adapter)
    assert.equal(result.outcome, 'pass', result.detail)
    assert.deepEqual(result.cleanup, { temporaryRootRemoved: true })
    assert.deepEqual(result.evidence, good)
    assert.match(
      adapter.commands[1][1].at(-1),
      /^\^captures bounded native Pi RPC producer records through PiRpcRun\$$/,
    )
    if (process.platform !== 'win32')
      assert.deepEqual(adapter.probes, [12345, -12345, 12346, -12346])
  },
)

posixTest(
  'verifies the receipt without forwarding personal provider credentials or exposing the challenge to the build',
  async (t) => {
    const adapter = artifactRunner(good)
    const spawn = adapter.spawnChild
    const saved = process.env.PI_NATIVE_PROBE_SECRET
    process.env.PI_NATIVE_PROBE_SECRET = 'must-not-inherit'
    try {
      adapter.spawnChild = (command, args, options) => {
        assert.equal(options.env.PI_NATIVE_PROBE_SECRET, undefined)
        if (args[0] === leaseBuildScript) {
          assert.equal(options.env.PI_NATIVE_PROBE_NONCE, undefined)
          assert.equal(options.env.PI_NATIVE_PROBE_RUN_ID, undefined)
        } else {
          assert.notEqual(options.env.PI_NATIVE_PROBE_NONCE, options.env.PI_NATIVE_PROBE_RUN_ID)
        }
        return spawn(command, args, options)
      }
      assert.equal((await checkFixture(t, input, adapter)).outcome, 'pass')
    } finally {
      if (saved === undefined) delete process.env.PI_NATIVE_PROBE_SECRET
      else process.env.PI_NATIVE_PROBE_SECRET = saved
    }
  },
)

test('retains the root for malformed or partial evidence even with a receipt and cleanup flags', async (t) => {
  for (const evidence of [
    '{',
    ' '.repeat(65 * 1024),
    {},
    { cleanup },
    { ...good, recordCount: 0 },
    { ...good, commandCount: -1 },
    { ...good, scenarios: { ...good.scenarios, steerAndFollowUp: 'unverified' } },
    { ...good, package: 'different-package' },
    { ...good, commands: [{ argv: ['--mode', 'rpc'], noTools: false }, { type: 'abort' }] },
  ]) {
    const result = await checkFixture(t, input, artifactRunner(evidence))
    assert.equal(result.outcome, 'unverified')
    assert.equal(result.stage, 'evidence')
    retained(result)
  }
})

posixTest(
  'uses the complete cached cold proof without probing its journal identities',
  async (t) => {
    t.mock.method(process, 'kill', () => assert.fail('parent re-probed a cached cold proof'))
    const coldRole = 'rpc-first'
    const adapter = artifactRunner(good, { coldRole })
    const result = await checkFixture(t, input, adapter)
    assert.equal(result.outcome, 'pass')
    assert.deepEqual(result.cleanup, { temporaryRootRemoved: true })

    const invalid = artifactRunner(good, {
      coldRole,
      change(receipt, root) {
        const lease = receipt.leases[1]
        const cache = readCache(root, lease)
        cache.absenceSnapshot.absent.pop()
        writeCache(root, lease, cache)
        return receipt
      },
    })
    retained(await checkFixture(t, input, invalid))
  },
)

function changeCache(change) {
  return (receipt, root) => {
    const lease = receipt.leases.at(-1)
    const cache = readCache(root, lease)
    change(cache, join(root, 'ownership', lease.id))
    writeCache(root, lease, cache)
    return receipt
  }
}

for (const [label, change] of Object.entries({
  missing: () => undefined,
  truncated: () => '{"version":1,',
  'duplicate fields': (receipt) => JSON.stringify(receipt).replace('{', '{"version":0,'),
  'partial staging file': (receipt, root) => {
    writeFileSync(join(root, 'settlement.tmp'), '{', { mode: 0o600 })
    return receipt
  },
  oversized: () => ' '.repeat(4097),
  partial: ({ version, runId, nonce, workerPid }) => ({ version, runId, nonce, workerPid }),
  nonfinal: (receipt) => ({ ...receipt, state: 'pending' }),
  version: (receipt) => ({ ...receipt, version: 2 }),
  'run mismatch': (receipt) => ({ ...receipt, runId: randomUUID() }),
  'nonce mismatch': (receipt) => ({ ...receipt, nonce: randomUUID() }),
  'worker mismatch': (receipt) => ({ ...receipt, workerPid: receipt.workerPid + 1 }),
  'evidence mismatch': (receipt) => ({ ...receipt, evidenceSha256: '0'.repeat(64) }),
  'lease omitted': (receipt) => ({ ...receipt, leases: receipt.leases.slice(0, -1) }),
  'lease mismatch': (receipt) => ({
    ...receipt,
    leases: [{ ...receipt.leases[0], id: randomUUID() }, ...receipt.leases.slice(1)],
  }),
  'lease duplicate': (receipt) => ({
    ...receipt,
    leases: [receipt.leases[0], receipt.leases[0], receipt.leases[2]],
  }),
  'native-only proof': ({ leases }) => ({ leases }),
  'empty native ownership': (receipt, root) => {
    const path = join(root, 'ownership', receipt.leases[0].id)
    rmSync(path, { recursive: true })
    mkdirSync(path, { mode: 0o700 })
    return receipt
  },
  ...Object.fromEntries(
    rolesInOrder.map((role) => [
      `missing ${role} cache`,
      (receipt, root) => {
        rmSync(
          cachePath(
            root,
            receipt.leases.find((lease) => lease.role === role),
          ),
        )
        return receipt
      },
    ]),
  ),
  'stale cache digest': (receipt) => {
    receipt.leases.at(-1).proofSha256 = '0'.repeat(64)
    return receipt
  },
  'cache owner mismatch': changeCache((cache) => {
    cache.workerPid++
  }),
  'cache nonce mismatch': changeCache((cache) => {
    cache.nonce = randomUUID()
  }),
  'cache path mismatch': changeCache((cache) => {
    cache.id = randomUUID()
  }),
  'cache role mismatch': changeCache((cache) => {
    cache.role = 'version'
  }),
  'cache protocol mismatch': changeCache((cache, path) => {
    cache.journal = cache.journal.replace('HOLI-POSIX-1', 'HOLI-POSIX-2')
    writeFileSync(join(path, 'journal'), cache.journal)
  }),
  'native journal changed after caching': changeCache((cache, path) => {
    writeFileSync(join(path, 'journal'), cache.journal.replace('1910000000', '1910000003'))
  }),
  'partial native journal': changeCache((cache, path) => {
    cache.journal = cache.journal.replace('COMPLETE\n', '')
    writeFileSync(join(path, 'journal'), cache.journal)
  }),
  'failed native journal': changeCache((cache, path) => {
    cache.journal += 'ERROR drain 1\n'
    writeFileSync(join(path, 'journal'), cache.journal)
  }),
  'failed native terminal': changeCache((cache, path) => {
    writeFileSync(join(path, 'failed'), `HOLI-POSIX-1 ${cache.id}\nFAILED drain\n`, { mode: 0o600 })
  }),
  'partial native terminal': changeCache((cache, path) => {
    writeFileSync(join(path, 'settled.tmp'), 'HOLI-POSIX-1 ', { mode: 0o600 })
  }),
  'noncanonical ownership': (receipt, root) => {
    const path = join(root, 'ownership', receipt.leases[0].id)
    rmSync(path, { recursive: true })
    symlinkSync(join(root, 'admissions'), path, 'dir')
    return receipt
  },
  'work still present': (receipt, root) => {
    mkdirSync(join(root, 'worker-tmp', 'probe-work'), { mode: 0o700 })
    return receipt
  },
})) {
  posixTest(`retains valid RPC evidence with ${label} settlement`, async (t) => {
    const result = await checkFixture(t, input, artifactRunner(good, { change }))
    assert.equal(result.outcome, 'unverified')
    assert.equal(result.stage, 'cleanup')
    retained(result)
  })
}

test('distinguishes runner exec refusal from failure after admission is possible', async (t) => {
  const unavailable = await checkFixture(
    t,
    input,
    fakeProcess({
      onWorker({ child }) {
        child.emit('error', Object.assign(new Error('missing command'), { code: 'ENOENT' }))
        child.emit('close', null)
      },
    }),
  )
  assert.match(unavailable.detail, /could not start: missing command/)
  assert.equal(unavailable.cleanup.temporaryRootRemoved, true)
})

posixTest('only an explicit no-admission settlement can retire a zero-lease worker', async (t) => {
  const evidence = {
    expectedVersion: input.expectedVersion,
    failure: { stage: 'setup', message: 'worker setup failed' },
    cleanup,
  }
  for (const valid of [false, true]) {
    const result = await checkFixture(
      t,
      input,
      artifactRunner(evidence, {
        code: 1,
        roles: [],
        change: (receipt) => (valid ? receipt : undefined),
      }),
    )
    assert.equal(result.outcome, 'unverified')
    assert.match(result.detail, /runner exited 1/)
    assert.equal(result.cleanup.temporaryRootRemoved, valid)
  }
  retained(await checkFixture(t, input, artifactRunner(good, { roles: [] })))
})

posixTest('preserves version/provider failures with or without a valid settlement', async (t) => {
  for (const [stage, observedVersion, roles] of [
    ['version', 'wrong', ['version']],
    ['native-rpc', input.expectedVersion, ['version', 'rpc-first']],
  ]) {
    for (const valid of [false, true]) {
      const evidence = {
        expectedVersion: input.expectedVersion,
        observedVersion,
        failure: { stage, message: 'consumer assertion failed' },
        cleanup,
      }
      const result = await checkFixture(
        t,
        input,
        artifactRunner(evidence, {
          code: 1,
          roles,
          change: (receipt) => (valid ? receipt : undefined),
        }),
      )
      assert.equal(result.outcome, 'mismatch')
      assert.equal(result.stage, stage)
      assert.match(
        result.detail,
        stage === 'version' ? /Observed Pi version/ : /consumer assertion failed/,
      )
      if (valid) assert.equal(result.cleanup.temporaryRootRemoved, true)
      else retained(result)
    }
  }
})

posixTest('a failing worker receipt cannot omit the last registered lease', async (t) => {
  const evidence = {
    expectedVersion: input.expectedVersion,
    observedVersion: input.expectedVersion,
    failure: { stage: 'native-rpc', message: 'first provider failure' },
    cleanup,
  }
  const result = await checkFixture(
    t,
    input,
    artifactRunner(evidence, {
      code: 1,
      // Two leases would be enough for a failure in the first RPC run, but the
      // independently recorded third lease makes this receipt incomplete.
      change: (receipt) => ({ ...receipt, leases: receipt.leases.slice(0, 2) }),
    }),
  )
  retained(result)
  assert.match(result.detail, /first provider failure/)
})

test('an exit zero with cleanup booleans and partial evidence retains the root', async (t) => {
  const adapter = fakeProcess({
    onWorker({ child, close, fakePid, env }) {
      child.pid = fakePid
      child.emit('spawn')
      writeFileSync(
        env.PI_NATIVE_PROBE_EVIDENCE,
        JSON.stringify({
          cleanup: { piRunDrained: true, fixtureServerClosed: true, localRootRemoved: true },
        }),
        { mode: 0o600 },
      )
      close(0)
    },
  })
  const result = await checkFixture(t, input, adapter)
  assert.equal(result.outcome, 'unverified')
  assert.equal(result.cleanup.status, 'incomplete')
  assert.ok(existsSync(join(result.cleanup.retainedRoot, 'evidence.json')))
})

function fakeProcess({ onWorker, probePresence, buildCode = 0 }) {
  const fakePid = 12345
  const commands = []
  const stops = []
  const probes = []
  return {
    commands,
    stops,
    probes,
    spawnChild(command, args, options) {
      commands.push([command, args])
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.unref = () => {}
      child.kill = (signal) => {
        stops.push(signal)
        if (signal === 'SIGTERM') throw Object.assign(new Error('signal EPERM'), { code: 'EPERM' })
        close(null, signal)
        return true
      }
      const close = (code, signal = null) => {
        child.emit('exit', code, signal)
        child.stdout.destroy()
        child.stderr.destroy()
        child.emit('close', code, signal)
      }
      queueMicrotask(() => {
        if (args[0] === leaseBuildScript) {
          child.pid = fakePid
          child.emit('spawn')
          close(buildCode)
        } else onWorker({ child, close, fakePid: fakePid + 1, env: options.env })
      })
      return child
    },
    probePresence(pid) {
      probes.push(pid)
      assert.ok([fakePid, -fakePid, fakePid + 1, -(fakePid + 1)].includes(pid))
      if (Math.abs(pid) !== fakePid && probePresence?.(pid) === true) return
      throw Object.assign(new Error('absent'), { code: 'ESRCH' })
    },
  }
}

const input = { bin: '/fake/pi', expectedVersion: '1.0.0' }

test('a failed helper build never enters the Pi worker', async (t) => {
  const adapter = fakeProcess({ buildCode: 1, onWorker: () => assert.fail('worker started') })
  const result = await checkFixture(t, input, adapter)
  assert.equal(adapter.commands.length, 1)
  assert.equal(result.stage, 'setup')
  assert.match(result.detail, /helper build exited 1/)
  assert.equal(result.cleanup.temporaryRootRemoved, true)
})

test('runner group absence without a detached lease receipt retains evidence', async (t) => {
  const adapter = fakeProcess({
    onWorker({ child, close, fakePid, env }) {
      child.pid = fakePid
      child.emit('spawn')
      writeFileSync(join(dirname(env.PI_NATIVE_PROBE_EVIDENCE), 'reaper.receipt'), 'simulated')
      close(7)
    },
  })
  const result = await checkFixture(t, input, adapter)
  assert.match(result.detail, /runner exit 7/)
  assert.match(result.cleanup.error, /detached worker lease settlement receipt/)
  assert.ok(existsSync(join(result.cleanup.retainedRoot, 'reaper.receipt')))
  assert.deepEqual(adapter.stops, [])
  if (process.platform !== 'win32') assert.deepEqual(adapter.probes, [12345, -12345, 12346, -12346])
})

test('a close without a PID receipt does not prove the worker never launched', async (t) => {
  const adapter = fakeProcess({
    onWorker({ child, close }) {
      child.emit('spawn')
      close(7)
    },
  })
  const result = await checkFixture(t, input, adapter)
  assert.match(result.detail, /runner exit 7/)
  assert.match(result.cleanup.error, /Missing runner launch or exit receipt/)
  assert.equal(result.cleanup.temporaryRootRemoved, false)
  assert.deepEqual(adapter.stops, [])
})

test('only ESRCH proves a POSIX group absent; preserve overflow and signal errors', async (t) => {
  if (process.platform === 'win32') return
  for (const mode of ['transient EPERM', 'EPERM', 'zombie', 'unexpected EINVAL']) {
    let attempts = 0
    const adapter = fakeProcess({
      onWorker({ child, fakePid }) {
        child.pid = fakePid
        child.emit('spawn')
        child.stdout.write(Buffer.alloc(256 * 1024 + 1))
      },
      probePresence(pid) {
        if (pid > 0) return
        if (mode === 'transient EPERM' && attempts++ > 0) return
        if (mode === 'zombie') return true
        throw Object.assign(new Error(mode), { code: mode.endsWith('EINVAL') ? 'EINVAL' : 'EPERM' })
      },
    })
    const result = await checkFixture(t, input, adapter)
    assert.equal(result.stage, 'runner')
    assert.match(result.detail, /output exceeded bound/)
    assert.match(result.cleanup.error, /signal EPERM/)
    assert.match(
      result.cleanup.error,
      new RegExp(
        {
          'transient EPERM': 'detached worker lease settlement receipt',
          EPERM: 'group 12346 absent: EPERM',
          zombie: 'group 12346 absent: still present',
          'unexpected EINVAL': 'group 12346 absent: EINVAL',
        }[mode],
      ),
    )
    assert.deepEqual(adapter.stops, ['SIGTERM', 'SIGKILL'])
    assert.equal(result.cleanup.temporaryRootRemoved, false)
  }
})

test('runner exit with a held pipe still honours timeout without signalling the exited handle', async (t) => {
  const adapter = fakeProcess({
    onWorker({ child, fakePid }) {
      child.pid = fakePid
      child.emit('spawn')
      child.emit('exit', 7, null)
    },
  })
  const result = await checkFixture(t, { ...input, timeout: 20 }, adapter)
  assert.match(result.detail, /timed out/)
  assert.match(result.cleanup.error, /Runner close was not observed/)
  assert.deepEqual(adapter.stops, [])
  assert.equal(result.cleanup.temporaryRootRemoved, false)
})
