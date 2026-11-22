import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createOwnedProtocol, type OwnedProcessMessage } from '../src/main/owned-process-protocol'

const secret = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const launchId = 'launch-✓-東京'

function wire(
  message: unknown,
  seq = 0,
  overrides: Record<string, unknown> = {},
  key = secret,
  id = launchId,
  direction = 'helper',
) {
  const payloadBase64 = (
    Buffer.isBuffer(message) ? message : Buffer.from(JSON.stringify(message), 'utf8')
  ).toString('base64')
  const macBase64 = createHmac('sha256', key)
    .update(`1\n${id}\n${direction}\n${seq}\n${payloadBase64}`, 'utf8')
    .digest('base64')
  return Buffer.from(
    JSON.stringify({
      version: 1,
      launchId: id,
      direction,
      seq,
      payloadBase64,
      macBase64,
      ...overrides,
    }) + '\n',
  )
}

function paired() {
  return {
    parent: createOwnedProtocol({ launchId, secret, role: 'parent' }),
    helper: createOwnedProtocol({ launchId, secret, role: 'helper' }),
  }
}

function expectRejected(codec: ReturnType<typeof createOwnedProtocol>, frame: Buffer) {
  let first: unknown
  try {
    codec.push(frame)
  } catch (error) {
    first = error
  }
  expect(first).toBeInstanceOf(Error)
  try {
    codec.finish()
  } catch (error) {
    expect(error).toBe(first)
  }
  try {
    codec.push(Buffer.alloc(0))
  } catch (error) {
    expect(error).toBe(first)
  }
}

describe('owned process protocol', () => {
  it('round-trips role-specific messages in both directions', () => {
    const { parent, helper } = paired()
    const helperMessages: OwnedProcessMessage[] = [
      { type: 'hello', helperPid: 21, parentPid: 12, birth: '1234', parentBirth: '1200' },
      { type: 'root-created', rootPid: 25 },
      { type: 'root-exit', rootPid: 25, rootExitCode: 0xffffffff },
      { type: 'ready' },
      {
        type: 'empty',
        exitCode: 0,
        rootExitCode: 0,
        rootPid: 25,
        reason: 'natural',
        outputFailed: false,
      },
      { type: 'handoff', exitCode: 0, rootExitCode: 0, rootPid: 42 },
      { type: 'error', code: 'nativeQueryFailure' },
    ]
    for (const message of helperMessages)
      expect(parent.push(helper.encode(message))).toEqual([message])
    const parentMessages: OwnedProcessMessage[] = [
      { type: 'auth', helperPid: 21, parentPid: 12, mode: 'ordinary' },
      { type: 'stop', signal: 'SIGKILL' },
      { type: 'acknowledge' },
    ]
    for (const message of parentMessages)
      expect(helper.push(parent.encode(message))).toEqual([message])
    parent.finish()
    helper.finish()
  })

  it('handles fragmented and coalesced frames', () => {
    const { parent, helper } = paired()
    const first = helper.encode({ type: 'ready' })
    const second = helper.encode({ type: 'error', code: 'helperFailure' })
    expect(parent.push(first.subarray(0, 4))).toEqual([])
    expect(parent.push(Buffer.concat([first.subarray(4), second]))).toEqual([
      { type: 'ready' },
      { type: 'error', code: 'helperFailure' },
    ])
    parent.finish()
  })

  it('uses the documented cross-language MAC bytes and base64 payload', () => {
    const { helper } = paired()
    const frame = helper.encode({ type: 'ready' })
    const envelope = JSON.parse(frame.toString('utf8'))
    expect(envelope.payloadBase64).toBe(Buffer.from('{"type":"ready"}', 'utf8').toString('base64'))
    expect(envelope.macBase64).toBe(
      createHmac('sha256', secret)
        .update(`1\n${launchId}\nhelper\n0\n${envelope.payloadBase64}`, 'utf8')
        .digest('base64'),
    )
  })

  it('rejects invalid UTF-8, malformed payload, extra envelope fields, and noncanonical base64', () => {
    const cases = [
      Buffer.from([0xff, 0x0a]),
      wire({ type: 'ready' }, 0, { extra: true }),
      wire({ type: 'ready' }, 0, { payloadBase64: 'YQ==\n' }),
      wire(Buffer.from([0xff]).toString('utf8')),
      Buffer.from('{"version":1}\n'),
    ]
    for (const frame of cases)
      expectRejected(createOwnedProtocol({ launchId, secret, role: 'parent' }), frame)
  })

  it('rejects wrong secrets, identifiers, directions, versions, and MACs', () => {
    const bad = [
      wire({ type: 'ready' }, 0, {}, Buffer.alloc(32, 1)),
      wire({ type: 'ready' }, 0, {}, secret, 'other'),
      wire({ type: 'ready' }, 0, {}, secret, launchId, 'parent'),
      wire({ type: 'ready' }, 0, { version: 2 }),
      wire({ type: 'ready' }, 0, { macBase64: Buffer.alloc(32).toString('base64') }),
      wire({ type: 'ready' }, 0, { macBase64: Buffer.alloc(31).toString('base64') }),
    ]
    for (const frame of bad)
      expectRejected(createOwnedProtocol({ launchId, secret, role: 'parent' }), frame)
  })

  it('requires consecutive safe sequence numbers', () => {
    for (const seq of [1, 2, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expectRejected(
        createOwnedProtocol({ launchId, secret, role: 'parent' }),
        wire({ type: 'ready' }, seq),
      )
    }
    const { parent } = paired()
    parent.push(wire({ type: 'ready' }))
    expectRejected(parent, wire({ type: 'ready' }))
  })

  it('validates terminal payload ranges, paired nulls, and role directions', () => {
    const invalid = [
      { type: 'empty', exitCode: -1, rootExitCode: null, rootPid: null },
      { type: 'empty', exitCode: 0, rootExitCode: null, rootPid: 3 },
      { type: 'empty', exitCode: 0, rootExitCode: 0x1_0000_0000, rootPid: 3 },
      { type: 'handoff', exitCode: 1, rootExitCode: 0, rootPid: 3 },
      { type: 'handoff', exitCode: 0, rootExitCode: 1, rootPid: 3 },
      { type: 'handoff', exitCode: 0, rootExitCode: 0, rootPid: 0 },
      { type: 'error', code: 'untrusted exception detail' },
      { type: 'hello', helperPid: 0, parentPid: 2 },
      { type: 'empty', exitCode: 0, rootExitCode: null, rootPid: null, extra: true },
    ]
    for (const message of invalid) {
      expect(() =>
        createOwnedProtocol({ launchId, secret, role: 'helper' }).encode(
          message as OwnedProcessMessage,
        ),
      ).toThrow()
      expectRejected(createOwnedProtocol({ launchId, secret, role: 'parent' }), wire(message))
    }
    expect(() =>
      createOwnedProtocol({ launchId, secret, role: 'parent' }).encode({ type: 'ready' }),
    ).toThrow()
    expect(() =>
      createOwnedProtocol({ launchId, secret, role: 'helper' }).encode({
        type: 'stop',
        signal: 'SIGTERM',
      }),
    ).toThrow()
  })

  it('requires exact paired guard registration and typed root evidence', () => {
    const setup = {
      type: 'setup',
      mode: 'retained',
      parentBirth: '1234',
      jobId: '11111111-1111-4111-8111-111111111111',
      jobHandle: 'a4',
      commitGuardId: '22222222-2222-4222-8222-222222222222',
      commitGuardHandle: 'b4',
    }
    expect(paired().parent.push(wire(setup))).toEqual([setup])
    for (const record of [
      { ...setup, commitGuardHandle: undefined },
      { ...setup, commitGuardHandle: null },
      { ...setup, commitGuardHandle: setup.jobHandle },
      { ...setup, commitGuardId: setup.jobId },
      { ...setup, mode: 'ordinary' },
      { type: 'root-created', rootPid: 3, rootExitCode: 0 },
      { type: 'root-exit', rootPid: 3 },
      { type: 'root-exit', rootPid: 3, rootExitCode: '259' },
      { type: 'root-exit', rootPid: 3, rootExitCode: 0x1_0000_0000 },
    ])
      expectRejected(paired().parent, wire(record))
  })

  it('requires one exact STOP decision in REGISTERED, not SETUP', () => {
    const binding = {
      jobId: '11111111-1111-4111-8111-111111111111',
      jobHandle: null,
      commitGuardId: null,
      commitGuardHandle: null,
    }
    const registered = { type: 'registered' as const, ...binding }
    for (const stop of [null, 'SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
      const { parent, helper } = paired()
      const decision = { ...registered, stop }
      expect(helper.push(parent.encode(decision))).toEqual([decision])
    }
    for (const decision of [
      registered,
      ...[0, false, 'SIGSTOP', 'sigterm', [], {}].map((stop) => ({ ...registered, stop })),
      { ...registered, stop: null, admit: true },
    ]) {
      expect(() => paired().parent.encode(decision as OwnedProcessMessage)).toThrow()
      expectRejected(paired().helper, wire(decision, 0, {}, secret, launchId, 'parent'))
    }
    const duplicate = Buffer.from(
      JSON.stringify({ ...registered, stop: null }).replace(
        /}$/,
        String.raw`,"st\u006fp":"SIGKILL"}`,
      ),
    )
    expectRejected(paired().helper, wire(duplicate, 0, {}, secret, launchId, 'parent'))
    expectRejected(
      paired().parent,
      wire({ ...binding, type: 'setup', mode: 'ordinary', parentBirth: '1234', stop: null }),
    )
  })

  it('enforces frame and combined lifetime byte bounds, including the newline', () => {
    const baseId = 'x'
    const base = createOwnedProtocol({ launchId: baseId, secret, role: 'helper' }).encode({
      type: 'ready',
    })
    const exactId = 'x'.repeat(baseId.length + 4096 - base.length)
    const exactFrame = createOwnedProtocol({ launchId: exactId, secret, role: 'helper' }).encode({
      type: 'ready',
    })
    expect(exactFrame.length).toBe(4096)
    expect(
      createOwnedProtocol({ launchId: exactId, secret, role: 'parent' }).push(exactFrame),
    ).toEqual([{ type: 'ready' }])
    const { parent } = paired()
    const accepted = wire({ type: 'ready' })
    expect(accepted.length).toBeLessThan(4096)
    expect(parent.push(accepted)).toEqual([{ type: 'ready' }])
    const tooLong = Buffer.concat([Buffer.alloc(4095, 0x20), Buffer.from('\n')])
    expectRejected(createOwnedProtocol({ launchId, secret, role: 'parent' }), tooLong)
    const bounded = createOwnedProtocol({ launchId, secret, role: 'helper' })
    let total = 0
    while (true) {
      try {
        total += bounded.encode({ type: 'ready' }).length
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect(total).toBeLessThanOrEqual(32 * 1024)
        expect(() => bounded.encode({ type: 'ready' })).toThrow(error)
        break
      }
    }
  })

  it('requires a complete final frame and makes errors sticky by identity', () => {
    const codec = createOwnedProtocol({ launchId, secret, role: 'parent' })
    codec.push(Buffer.from('{"version":'))
    let error: unknown
    try {
      codec.finish()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(() => codec.finish()).toThrow(error)
    expect(() => codec.push(Buffer.alloc(0))).toThrow(error)
  })

  it('allows healthy finish to be idempotent and rejects later traffic', () => {
    const codec = createOwnedProtocol({ launchId, secret, role: 'parent' })
    codec.finish()
    codec.finish()
    expect(() => codec.push(Buffer.alloc(0))).toThrow()
  })
})

it('rejects duplicate decoded keys and noncanonical uint tokens even with matching MAC', () => {
  for (const payload of [
    String.raw`{"type":"ready","t\u0079pe":"ready"}`,
    ...['0.0', '0e0', '-0', '00'].map(
      (code) => `{"type":"handoff","exitCode":${code},"rootExitCode":0,"rootPid":42}`,
    ),
  ])
    expectRejected(paired().parent, wire(Buffer.from(payload)))
  expectRejected(
    paired().parent,
    Buffer.from(
      String(wire({ type: 'ready' })).replace('"seq":0', String.raw`"s\u0065q":0,"seq":0`),
    ),
  )
  expectRejected(
    paired().parent,
    Buffer.from(String(wire({ type: 'ready' })).replace('"seq":0', '"seq":-0')),
  )
  expectRejected(paired().parent, Buffer.concat([Buffer.from('\ufeff'), wire({ type: 'ready' })]))
})

it('requires an authenticated exact parent epoch in HELLO', () => {
  const hello = {
    type: 'hello',
    helperPid: 21,
    parentPid: 12,
    birth: '133694208000000001',
    parentBirth: '133694208000000000',
  }
  expect(paired().parent.push(wire(hello))).toEqual([hello])
  for (const parentBirth of [undefined, null, 133694208000000000, '0133694208000000000'])
    expectRejected(paired().parent, wire({ ...hello, parentBirth }))
})

it('distinguishes object absence from a native zero query and exact slot consumption', () => {
  const proof = {
    type: 'recovered',
    action: 'recover',
    parentPid: 12,
    parentBirth: '1234',
    jobId: '11111111-1111-4111-8111-111111111111',
    commitGuardId: '22222222-2222-4222-8222-222222222222',
    jobState: 'closed-zero',
    jobBefore: 1,
    jobAfter: 0,
    jobActiveBefore: 3,
    jobActiveAfter: 0,
    guardState: 'absent',
    guardBefore: null,
    guardAfter: null,
    guardActiveBefore: null,
    guardActiveAfter: null,
  }
  expect(paired().parent.push(wire(proof))).toEqual([proof])
  for (const changes of [
    { action: 'revoke' },
    { jobState: 'absent' },
    { guardState: 'closed-zero' },
    { guardActiveAfter: 0 },
    { jobBefore: 0 },
    { jobBefore: 2 },
    { jobAfter: 1 },
    { jobActiveAfter: 1 },
    { jobActiveBefore: null },
    { jobAfter: undefined },
    { extra: true },
  ])
    expectRejected(paired().parent, wire({ ...proof, ...changes }))
})
