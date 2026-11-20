import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, onTestFinished } from 'vitest'
import { brokerHostPlan } from '../src/main/owned-process-broker-host'

const node = process.execPath
// The native child inherits the host's environment; don't expose credentials or
// NODE_OPTIONS to either process. Keep only Windows system path prerequisites.
const env =
  process.platform === 'win32'
    ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
    : {}

function host(native: Parameters<typeof brokerHostPlan>[1], observeNativeEof = false) {
  const plan = brokerHostPlan(node, native)
  if (observeNativeEof) {
    // The host keeps its own outputs open until the join. Observe EOF on the
    // actual inner pipes without changing the relay or adding a live handle.
    plan.args[1] += `
      let ended = 0;
      for (const pipe of [native.stdout, native.stderr]) {
        pipe.once('end', () => {
          if (++ended === 2) require('node:fs').writeFileSync('native-output-ended', '');
        });
      }
    `
  }
  const child = spawn(plan.file, plan.args, {
    cwd: plan.cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => {})
  const closed = once(child, 'close')
  void closed.catch(() => {})
  onTestFinished(() => {
    child.stdin.destroy()
    child.stdout.resume()
    child.stderr.resume()
  })
  return { ...plan, child, closed }
}

function nodeHost(source: string, cwd = process.cwd(), observeNativeEof = false) {
  return host({ file: node, args: ['-e', source], cwd }, observeNativeEof)
}

async function collect(stream: Readable, slow = false): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
    if (slow) await delay(2)
  }
  return Buffer.concat(chunks)
}

describe('owned Job broker host', () => {
  it('relays the private first line and fragmented binary streams through backpressure', async () => {
    const { args, child, closed } = nodeHost(`
      const { once } = require('node:events');
      (async () => {
        for await (const chunk of process.stdin) {
          const err = chunk.map(byte => byte ^ 0xff);
          if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
          if (!process.stderr.write(err)) await once(process.stderr, 'drain');
        }
      })().catch(() => { process.exitCode = 1; });
    `)
    const privateSpec = JSON.stringify({ secret: 'test-spec-only-on-stdin', parentPid: 42 }) + '\n'
    expect(args.join(' ')).not.toContain('test-spec-only-on-stdin')
    expect(args.join(' ')).not.toContain(privateSpec)
    const bytes = Buffer.allocUnsafe(2 * 1024 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    const chunks = [Buffer.from(privateSpec.slice(0, 4)), Buffer.from(privateSpec.slice(4))]
    for (let i = 0; i < bytes.length; i += 1417) chunks.push(bytes.subarray(i, i + 1417))
    const expected = Buffer.concat(chunks)
    const expectedErr = Buffer.from(expected.map((byte) => byte ^ 0xff))
    const [stdout, stderr, status] = await Promise.all([
      collect(child.stdout, true),
      collect(child.stderr, true),
      closed,
      pipeline(Readable.from(chunks), child.stdin),
    ])
    expect(status).toEqual([0, null])
    expect(stdout.equals(expected)).toBe(true)
    expect(stderr.equals(expectedErr)).toBe(true)
  })

  it('waits past the terminal frame for physical exit without requiring parent EOF', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'holi-broker-host-'))
    onTestFinished(() => rm(cwd, { recursive: true, force: true }))
    const { child, closed } = nodeHost(
      `
        const { closeSync, writeFileSync, writeSync } = require('node:fs');
        let command = '';
        process.stdin.setEncoding('utf8').on('data', (chunk) => {
          command += chunk;
          if (command !== 'finish') return;
          process.once('exit', () => writeFileSync('native-finished', 'done'));
          process.exit(0);
        });
        // Windows named pipes need actual handle closure to produce EOF.
        // Keep raw fd closes off macOS, where lazy libuv setup can reuse them.
        if (process.platform === 'win32') {
          writeSync(1, 'terminal\\n');
          closeSync(1);
          closeSync(2);
        } else {
          process.stdout.end('terminal\\n');
          process.stderr.end();
        }
      `,
      cwd,
      true,
    )
    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)
    const finished = join(cwd, 'native-finished')
    try {
      await expect.poll(() => existsSync(join(cwd, 'native-output-ended'))).toBe(true)
      expect(existsSync(finished)).toBe(false)
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
      child.stdin.write('finish') // Release the inner process without sending parent EOF.
      const [status, output, errors] = await Promise.all([closed, stdout, stderr])
      expect(status).toEqual([0, null])
      expect(await readFile(finished, 'utf8')).toBe('done')
      expect(output.toString()).toBe('terminal\n')
      expect(errors).toHaveLength(0)
    } finally {
      if (!child.stdin.destroyed) child.stdin.end('finish')
      await closed // Release a failed barrier before its cwd cleanup hook runs.
    }
  })

  it('waits for both readable pipes when a descendant still holds them after inner exit', async () => {
    const { child, closed } = nodeHost(`
      const { spawn } = require('node:child_process');
      process.stdout.write('terminal\\n', () => {
        spawn(process.execPath, ['-e', ${JSON.stringify(`
          setTimeout(() => process.stdout.write('late stdout'), 75);
          setTimeout(() => process.stderr.write('late stderr'), 125);
        `)}], { detached: true, windowsHide: true, stdio: ['ignore', 1, 2] }).unref();
      });
    `)
    const [stdout, stderr, status] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      closed,
    ])
    expect(status).toEqual([0, null])
    expect(stdout.toString()).toBe('terminal\nlate stdout')
    expect(stderr.toString()).toBe('late stderr')
  })

  it.each([
    ['nonzero native exit', 'process.exitCode = 125', 125],
    ['native signal', 'process.kill(process.pid, "SIGTERM")', 1],
  ])('does not report success after a terminal frame followed by %s', async (_name, end, code) => {
    const { child, closed } = nodeHost(`process.stdout.write('terminal', () => { ${end}; });`)
    const [stdout, status] = await Promise.all([collect(child.stdout), closed])
    expect(stdout.toString()).toBe('terminal')
    expect(status).toEqual([code, null])
  })

  it.each(['', join(tmpdir(), 'holi-broker-host-no-such-executable', 'node')])(
    'fails closed on a synchronous or asynchronous native spawn error (%j)',
    async (file) => {
      const { child, closed } = host({ file, args: [], cwd: process.cwd() })
      const [stdout, stderr, status] = await Promise.all([
        collect(child.stdout),
        collect(child.stderr),
        closed,
      ])
      expect(status).toEqual([1, null])
      expect(stdout).toHaveLength(0)
      expect(stderr).toHaveLength(0)
    },
  )

  it('turns parent loss into EOF and keeps native alive through rollback', async () => {
    const { child, closed } = nodeHost(`
      process.stdin.resume();
      process.stdin.once('end', () => {
        process.stdout.write('eof\\n');
        setTimeout(() => {
          process.stdout.write('rolled back\\n');
          process.exitCode = 125;
        }, 75);
      });
      process.stdout.write('ready\\n');
    `)
    const [ready] = await once(child.stdout, 'data')
    expect(ready.toString()).toBe('ready\n')
    const rolledBack = collect(child.stdout)
    child.stdin.destroy() // Simulate the original parent's stdin writer disappearing.
    expect((await rolledBack).toString()).toBe('eof\nrolled back\n')
    expect(await closed).toEqual([125, null])
  })

  it('fails after a terminal frame if the outer reader closes, drains undeliverable bytes and joins', async () => {
    const { child, closed } = nodeHost(`
      const { once } = require('node:events');
      process.stdin.once('data', async () => {
        const eof = once(process.stdin, 'end');
        const block = Buffer.alloc(64 * 1024);
        for (let i = 0; i < 32; i++) {
          if (!process.stdout.write(block)) await once(process.stdout, 'drain');
        }
        await eof;
        process.stderr.write('finished after EOF\\n');
      });
      process.stdout.write('terminal\\n');
    `)
    const stderr = collect(child.stderr)
    const [terminal] = await once(child.stdout, 'data')
    expect(terminal.toString()).toBe('terminal\n')
    child.stdout.destroy()
    child.stdin.write('continue')
    expect(await closed).toEqual([1, null])
    expect((await stderr).toString()).toBe('finished after EOF\n')
  })

  it('counts the entire libuv-quoted invocation in UTF-16, including executable and separators', () => {
    const nodeImage = 'C:\\Program Files\\node.exe'
    const native = {
      file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      cwd: 'C:\\with space\\',
      args: ['', '\\', '\t', 'embedded\\\\"quote', 'astral \u{1f680}', 'line\nbreak'],
    }
    const plan = brokerHostPlan(nodeImage, native)
    expect(plan.file).toBe(nodeImage)
    expect(plan.cwd).toBe(native.cwd)
    expect(plan.args.slice(2)).toEqual(['--', native.file, native.cwd, ...native.args])
    const quote = (arg: string) =>
      arg === '' || /[ \t"]/.test(arg)
        ? '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"'
        : arg
    const used = [plan.file, ...plan.args].map(quote).join(' ').length
    const pad = 'a'.repeat(31_999 - used - 1)
    expect(() =>
      brokerHostPlan(nodeImage, { ...native, args: [...native.args, pad] }),
    ).not.toThrow()
    expect(() =>
      brokerHostPlan(nodeImage, { ...native, args: [...native.args, `${pad}a`] }),
    ).toThrow(RangeError)
  })
})
