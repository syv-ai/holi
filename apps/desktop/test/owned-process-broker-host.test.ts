import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, onTestFinished } from 'vitest'
import { brokerHostPlan } from '../src/main/owned-process-broker-host'
import { win32Adapter } from '../src/main/owned-process-win32'

const node = process.execPath
// The native child inherits the host's environment; don't expose credentials or
// NODE_OPTIONS to either process. Keep only Windows system path prerequisites.
const env =
  process.platform === 'win32'
    ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
    : {}

function host(
  native: Parameters<typeof brokerHostPlan>[1] & { env?: NodeJS.ProcessEnv },
  observeNativeEof = false,
) {
  const plan = brokerHostPlan(node, native)
  if (observeNativeEof) {
    // The host keeps its own outputs open until the join. Observe EOF on the
    // actual inner pipes without changing the relay or adding a live handle.
    plan.args[1] += `
      const fs = require('node:fs');
      const started = performance.now();
      const mark = (event) => {
        try {
          fs.appendFileSync('native-join-events', event + '=' + Math.round(performance.now() - started) + '\\n');
        } catch {} // Diagnostics are not evidence for the assertion barrier.
      };
      native.once('spawn', () => mark('spawn'));
      native.once('exit', () => mark('exit'));
      native.once('close', () => mark('close'));
      native.stdin?.once('close', () => mark('stdinClose'));
      let ended = 0;
      for (const [event, pipe] of [['stdoutEnd', native.stdout], ['stderrEnd', native.stderr]]) {
        pipe.once('end', () => {
          if (++ended === 2) fs.writeFileSync('native-output-ended', '');
          mark(event);
        });
      }
    `
  }
  const child = spawn(plan.file, plan.args, {
    cwd: plan.cwd,
    env: native.env ?? env,
    detached: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => {})
  const closed = once(child, 'close')
  const joined = new Promise<void>((resolve) => child.once('close', () => resolve()))
  void closed.catch(() => {})
  onTestFinished(async () => {
    child.stdin.destroy()
    child.stdout.resume()
    child.stderr.resume()
    await joined
  })
  return { ...plan, child, closed }
}

function nodeHost(source: string, cwd = process.cwd(), observeNativeEof = false) {
  return host({ file: node, args: ['-e', source], cwd }, observeNativeEof)
}

function windowsJoinFixture(cwd: string) {
  // Add-Type's CodeDOM compiler needs writable temp space, not the parent's environment.
  const adapter = win32Adapter('RunBroker', { ...env, TEMP: cwd, TMP: cwd }, (source) => {
    // Keep the real broker body compiling, but run only the fixture entry.
    const entry = 'public static int RunBroker()'
    if (source.split(entry).length !== 2) throw new Error('Expected one native broker entry')
    // Use the compiled snapshot layout and walker, but do not consult the broker's parent lease.
    const snapshots = source.match(
      /^  static void VisitBrokerHandleTable\([^\n]+\) {\n[\s\S]+?^  }$/gm,
    )
    const guard = 'ScanBudget(deadline);'
    if (snapshots?.length !== 1 || !snapshots[0].includes(guard))
      throw new Error('Expected one guarded native handle snapshot walker')
    const visitSelf = snapshots[0]
      .replace('VisitBrokerHandleTable(IntPtr process,', 'VisitJoinHandleTable(')
      .replace(
        'NtQueryInformationProcess(process,',
        'NtQueryInformationProcess(GetCurrentProcess(),',
      )
      .replaceAll(guard, 'if (Clock.ElapsedMilliseconds >= deadline) throw new IOException();')
    return (
      source.replace(entry, 'private static int RunOriginalBroker()') +
      String.raw`
public static partial class HoliOwnedProcess {
${visitSelf}

  private static void JoinCloseOutputAliases(IntPtr input, IntPtr output, IntPtr error) {
    var self = GetCurrentProcess();
    IntPtr outputPin = IntPtr.Zero, errorPin = IntPtr.Zero;
    int outputCount = 0, errorCount = 0;
    bool outputClosed = false, errorClosed = false;
    try {
      const uint DuplicateSameAccess = 2;
      Check(DuplicateHandle(self, output, self, out outputPin, 0, false, DuplicateSameAccess));
      Check(DuplicateHandle(self, error, self, out errorPin, 0, false, DuplicateSameAccess));
      if (SameKernelObject(outputPin, errorPin) || SameKernelObject(outputPin, input) ||
          SameKernelObject(errorPin, input)) throw new IOException();

      // Add-Type has returned and the fixture does not use console writers. A CRT or
      // PowerShell alias can still hold the pipe open. Only close a local slot after
      // comparing it to an owned pin, never on the basis of its type or slot value.
      VisitJoinHandleTable(Clock.ElapsedMilliseconds + 1000, entry => {
        var slot = entry.HandleValue;
        if (slot == input || slot == outputPin || slot == errorPin) return;
        if (SameKernelObject(slot, outputPin)) {
          Check(CloseHandle(slot));
          outputCount++;
          if (slot == output) outputClosed = true;
        } else if (SameKernelObject(slot, errorPin)) {
          Check(CloseHandle(slot));
          errorCount++;
          if (slot == error) errorClosed = true;
        }
      });
      if (!outputClosed || !errorClosed) throw new IOException();
    } finally {
      bool closedOutputPin = outputPin == IntPtr.Zero || CloseHandle(outputPin);
      bool closedErrorPin = errorPin == IntPtr.Zero || CloseHandle(errorPin);
      if (!closedOutputPin || !closedErrorPin) throw new IOException();
    }
    // One per stream means only the original standard handle was present.
    File.WriteAllText("native-handles-closed", outputCount.ToString(CultureInfo.InvariantCulture) +
      "," + errorCount.ToString(CultureInfo.InvariantCulture));
  }

  public static int RunBroker() {
    try {
      File.WriteAllText("native-entered", "");
      var input = BrokerPipe(-10);
      var output = BrokerPipe(-11);
      var error = BrokerPipe(-12);
      BrokerWriteBytes(output, Encoding.UTF8.GetBytes("terminal\n"));
      JoinCloseOutputAliases(input, output, error);
      var one = new byte[1];
      foreach (byte expected in Encoding.UTF8.GetBytes("finish")) {
        int count;
        if (!ReadFile(input, one, 1, out count, IntPtr.Zero) || count != 1 || one[0] != expected)
          return 125;
      }
      File.WriteAllText("native-finished", "done");
      return 0;
    } catch {
      return 125; // Never report errors through the closed stderr handle.
    }
  }
}
`
    )
  })
  return { ...adapter, cwd }
}

// These fixture files are written only by the test, with fixed-size records.
function readJoinMarker(cwd: string, name: string, maxBytes: number): string | undefined {
  try {
    const path = join(cwd, name)
    const stat = statSync(path)
    if (stat.isFile() && stat.size <= maxBytes) return readFileSync(path, 'utf8')
  } catch {
    // A marker may not exist yet; don't hide the original failure.
  }
}

async function collect(
  stream: Readable,
  slow = false,
  observe?: (chunk: Buffer) => void,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
    observe?.(chunk)
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
    const started = performance.now()
    const elapsed = () => Math.round(performance.now() - started)
    let phase = 'prepare'
    const phaseMs: Record<string, number> = { prepare: 0 }
    function enter(next: string) {
      phase = next
      phaseMs[next] = elapsed()
    }
    let reported = false
    let inspectFixture: (() => object) | undefined
    function reportFailure() {
      if (reported) return
      reported = true
      console.error(
        'HOLI_BROKER_JOIN_PHASE ' +
          JSON.stringify({ phase, elapsedMs: elapsed(), phaseMs, ...inspectFixture?.() }),
      )
    }

    const directory = mkdtemp(join(tmpdir(), 'holi-broker-host-'))
    let closeFixture: (() => Promise<void>) | undefined
    onTestFinished(async ({ task }) => {
      if (!closeFixture && task.result?.state === 'fail') reportFailure()
      await closeFixture?.()
      const cwd = await directory.catch(() => undefined)
      if (cwd) await rm(cwd, { recursive: true, force: true })
    })
    const cwd = await directory
    if (reported) return // Preparation timed out; do not spawn during teardown.
    const native = process.platform === 'win32' ? windowsJoinFixture(cwd) : undefined
    enter('spawn')
    const { child } = native
      ? host(native, true)
      : nodeHost(
          `
              const { writeFileSync } = require('node:fs');
              let command = '';
              process.stdin.setEncoding('utf8').on('data', (chunk) => {
                command += chunk;
                if (command !== 'finish') return;
                process.once('exit', () => writeFileSync('native-finished', 'done'));
                process.exit(0);
              });
              process.stdout.end('terminal\\n');
              process.stderr.end();
            `,
          cwd,
          true,
        )
    // Vitest runs these hooks in reverse order: report a timeout before host() joins.
    onTestFinished(({ task }) => {
      if (task.result?.state === 'fail') reportFailure()
    })
    type Status = [number | null, NodeJS.Signals | null]
    let hostExit: Status | null = null
    let hostClose: Status | null = null
    let finishWriteOk: boolean | null = null
    child.once('spawn', () => (phaseMs.hostSpawn = elapsed()))
    child.once('exit', (code, signal) => {
      phaseMs.hostExit = elapsed()
      hostExit = [code, signal]
    })
    // Observe physical close (even if spawning raised an error) before consuming output.
    const closed = new Promise<Status>((resolve) => {
      child.once('close', (code, signal) => {
        phaseMs.hostClose = elapsed()
        hostClose = [code, signal]
        resolve(hostClose)
      })
    })
    closeFixture = async () => {
      child.stdin.destroy()
      child.stdout.resume()
      child.stderr.resume()
      await closed
    }
    const earlyClose = closed.then(() => {
      throw new Error('Broker host closed before the terminal frame')
    })
    let reportTerminal!: (seen: boolean) => void
    const firstFrame = new Promise<boolean>((resolve) => {
      reportTerminal = resolve
    })
    const terminal = Buffer.from('terminal\n')
    let prefix = Buffer.alloc(0)
    let terminalSeen = false
    const stdout = collect(child.stdout, false, (chunk) => {
      if (prefix.length === terminal.length) return
      prefix = Buffer.concat([prefix, chunk.subarray(0, terminal.length - prefix.length)])
      if (prefix.length < terminal.length) return
      terminalSeen = prefix.equals(terminal)
      phaseMs.firstFrame = elapsed()
      reportTerminal(terminalSeen)
    })
    const startup = Promise.race([
      firstFrame,
      earlyClose,
      stdout.then(() => {
        throw new Error('Broker host stdout ended before the terminal frame')
      }),
    ])
    const stderr = collect(child.stderr)
    void stderr.catch(() => {})
    const finished = join(cwd, 'native-finished')
    const innerEof = join(cwd, 'native-output-ended')
    inspectFixture = () => {
      const counts = readJoinMarker(cwd, 'native-handles-closed', 19)
      const events = readJoinMarker(cwd, 'native-join-events', 160) ?? ''
      return {
        terminalSeen,
        innerEof: existsSync(innerEof),
        nativeEntered: existsSync(join(cwd, 'native-entered')),
        nativeHandlesClosed: counts !== undefined && /^\d{1,9},\d{1,9}$/.test(counts),
        nativeAliasCounts:
          counts !== undefined && /^\d{1,9},\d{1,9}$/.test(counts) ? counts : undefined,
        nativeFinished: existsSync(finished),
        // Inner times start at observer installation in the host, not at test start.
        innerMs: Object.fromEntries(
          [
            ...events.matchAll(/^(spawn|exit|close|stdinClose|stdoutEnd|stderrEnd)=(\d{1,9})$/gm),
          ].map(([, event, ms]) => [event, Number(ms)]),
        ),
        parentStdinOpen: !child.stdin.destroyed && !child.stdin.writableEnded,
        finishWriteOk,
        hostExit,
        hostClose,
      }
    }
    try {
      // PowerShell compilation is startup, not part of the inner-pipe EOF barrier.
      enter('terminal')
      expect(await startup).toBe(true)
      enter('inner-eof')
      await expect.poll(() => existsSync(innerEof)).toBe(true)
      enter('pre-release-assertions')
      expect(existsSync(finished)).toBe(false)
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
      enter('finish-submit')
      child.stdin.write('finish', (error) => {
        phaseMs.finishWrite = elapsed()
        finishWriteOk = !error
      }) // Release the inner process without sending parent EOF.
      enter('physical-join')
      const [status, output, errors] = await Promise.all([closed, stdout, stderr])
      enter('joined-assertions')
      expect(status).toEqual([0, null])
      expect(await readFile(finished, 'utf8')).toBe('done')
      expect(output.toString()).toBe('terminal\n')
      expect(errors).toHaveLength(0)
    } catch (error) {
      reportFailure() // An ordinary failure must be captured before finally releases input.
      throw error
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
