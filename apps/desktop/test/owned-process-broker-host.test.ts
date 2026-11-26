import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it, onTestFinished } from 'vitest'
import { observeCompilerArtifacts } from './helpers/compiler-artifact-observation'
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
      const mark = (event, detail = Math.round(performance.now() - started)) => {
        try {
          fs.appendFileSync('native-join-events', event + '=' + detail + '\\n');
        } catch {} // Diagnostics are not evidence for the assertion barrier.
      };
      native.once('spawn', () => mark('spawn'));
      native.once('exit', (code, signal) => {
        mark('exit');
        mark('nativeExitCode', code === null ? 'null' : code);
        mark('nativeSignal', signal ?? 'null');
      });
      native.once('close', () => mark('close'));
      native.stdin?.once('close', () => mark('stdinClose'));
      for (const [name, pipe] of [
        ['stdinError', native.stdin], ['stdoutError', native.stdout], ['stderrError', native.stderr],
        ['parentInputError', process.stdin], ['parentOutputError', process.stdout], ['parentErrorError', process.stderr],
      ]) {
        pipe?.once('error', (error) => {
          const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'unknown';
          mark(name, code);
        });
      }
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

const windowsCompilerEnvKeys = new Set([
  // Windows and compiler dependency lookup; Node and PowerShell use absolute images.
  'systemroot',
  'windir',
  'systemdrive',
  'path',
  'comspec',
  'pathext',
  // Framework installation and configuration paths.
  'programfiles',
  'programfiles(x86)',
  'programw6432',
  'programdata',
  'userprofile',
  'appdata',
  'localappdata',
  'homedrive',
  'homepath',
])

function safeWindowsCompilerEnv(source: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(
        ([key, value]) => value !== undefined && windowsCompilerEnvKeys.has(key.toLowerCase()),
      ),
    ),
    // CodeDOM's temporary files belong to the fixture, never the user's temp directory.
    TEMP: cwd,
    TMP: cwd,
  }
}

function windowsJoinAdapter(cwd: string) {
  // The Node host receives this environment and PowerShell inherits it from the host.
  const compilerEnv = safeWindowsCompilerEnv(process.env, cwd)
  const adapter = win32Adapter('RunBroker', compilerEnv, (source) => {
    // Select whole methods by exact declaration; a changed shape must fail rather than
    // pull another declaration or any of the unused broker into the fixture.
    const methods = [...source.matchAll(/^  (static [^\n]+) {\n(?:(?: {4}[^\n]*)?\n)*^  }$/gm)]
    const method = (declaration: string) => {
      const [match, duplicate] = methods.filter(([, signature]) => signature === declaration)
      if (!match || duplicate) throw new Error('Expected one matching native broker method')
      return match[0]
    }
    const shared = [
      // The unchanged protocol ReadAvailable and interop CloseSource reference this diagnostic.
      'static void RememberBrokerFailure(Exception error)',
      'static IntPtr BrokerPipe(int which)',
      'static void BrokerWriteBytes(IntPtr pipe,byte[] bytes)',
      'static bool SameKernelObject(IntPtr left,IntPtr right)',
    ].map(method)
    const [diagnosticFields, duplicateFields] =
      source.match(
        /^  static string brokerPhase="open-pipes", brokerFailurePhase;\n  static uint brokerFailureCode;$/gm,
      ) ?? []
    if (!diagnosticFields || duplicateFields)
      throw new Error('Expected native broker diagnostic fields')

    // Reuse the snapshot walker, but scope it to self and replace its parent lease guard.
    const snapshot = method(
      'static void VisitBrokerHandleTable(IntPtr process,long deadline,Action<HandleSnapshotEntry> visit)',
    )
    const guard = 'ScanBudget(deadline);'
    if (!snapshot.includes(guard))
      throw new Error('Expected a guarded native handle snapshot walker')
    const visitSelf = snapshot
      .replace('VisitBrokerHandleTable(IntPtr process,', 'VisitJoinHandleTable(')
      .replace(
        'NtQueryInformationProcess(process,',
        'NtQueryInformationProcess(GetCurrentProcess(),',
      )
      .replaceAll(guard, 'if (Clock.ElapsedMilliseconds >= deadline) throw new IOException();')
    return String.raw`
public static partial class HoliOwnedProcess {
${diagnosticFields}
${shared.join('\n')}
${visitSelf}

  private static void JoinCloseOutputAliases(IntPtr input, IntPtr output, IntPtr error) {
    var self = GetCurrentProcess();
    IntPtr outputPin = IntPtr.Zero, errorPin = IntPtr.Zero;
    int outputCount = 0, errorCount = 0;
    bool outputClosed = false, errorClosed = false;
    try {
      const uint DuplicateSameAccess = 2;
      brokerPhase = "pin-output";
      Check(DuplicateHandle(self, output, self, out outputPin, 0, false, DuplicateSameAccess));
      brokerPhase = "pin-error";
      Check(DuplicateHandle(self, error, self, out errorPin, 0, false, DuplicateSameAccess));
      brokerPhase = "compare-pipes";
      if (SameKernelObject(outputPin, errorPin) || SameKernelObject(outputPin, input) ||
          SameKernelObject(errorPin, input)) throw new IOException();

      // Add-Type has returned and the fixture does not use console writers. A CRT or
      // PowerShell alias can still hold the pipe open. Only close a local slot after
      // comparing it to an owned pin, never on the basis of its type or slot value.
      brokerPhase = "scan-aliases";
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
      brokerPhase = "verify-aliases";
      if (!outputClosed || !errorClosed) throw new IOException();
    } catch (Exception failure) {
      RememberBrokerFailure(failure);
      throw;
    } finally {
      bool closedOutputPin = outputPin == IntPtr.Zero || CloseHandle(outputPin);
      bool closedErrorPin = errorPin == IntPtr.Zero || CloseHandle(errorPin);
      if (!closedOutputPin || !closedErrorPin) {
        brokerPhase = "close-pins";
        throw new IOException();
      }
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
      brokerPhase = "read-finish";
      var one = new byte[1];
      foreach (byte expected in Encoding.UTF8.GetBytes("finish")) {
        int count;
        if (!ReadFile(input, one, 1, out count, IntPtr.Zero) || count != 1 || one[0] != expected)
          return 125;
      }
      File.WriteAllText("native-finished", "done");
      return 0;
    } catch (Exception failure) {
      RememberBrokerFailure(failure);
      try {
        File.WriteAllText("native-join-failure", brokerFailurePhase + "," +
          brokerFailureCode.ToString(CultureInfo.InvariantCulture));
      } catch { } // Diagnostics cannot change the fixture's exit status.
      return 125; // Never report errors through the closed stderr handle.
    }
  }
}
`
  })
  return { ...adapter, cwd }
}

const joinCompile =
  "Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.Web.Extensions','System.Core');"
const joinPhaseMarker = (name: 'powershell-start' | 'compile-start' | 'compile-done') =>
  `try { [IO.File]::WriteAllText('${name}', '') } catch {};`

const joinPayload = /(?<=\[Convert\]::FromBase64String\(')[A-Za-z0-9+/]+={0,2}(?='\))/g

function decodeJoinBootstrap(args: string[]) {
  const bootstrap = args.at(-1) ?? ''
  const payloads = bootstrap.match(joinPayload)
  if (args.at(-2) !== '-Command' || payloads?.length !== 1)
    throw new Error('Expected one literal gzip payload in the PowerShell command')
  return { bootstrap, script: gunzipSync(Buffer.from(payloads[0], 'base64')).toString('utf8') }
}

function windowsJoinFixture(cwd: string) {
  const adapter = windowsJoinAdapter(cwd)
  const { bootstrap, script } = decodeJoinBootstrap(adapter.args)
  if (
    script.split(joinCompile).length !== 2 ||
    !script.endsWith(`\n'@\n${joinCompile}exit [HoliOwnedProcess]::RunBroker()`)
  )
    throw new Error('Expected one Add-Type statement before the native broker entry')
  // Supply zero PowerShell pipeline objects; $source is still bound explicitly.
  // This does not read or close Win32 stdin, which RunBroker uses for finish.
  const compileWithEmptyInput = `@() | ${joinCompile}`
  const marked = script.replace(
    joinCompile,
    `${joinPhaseMarker('compile-start')}${compileWithEmptyInput}${joinPhaseMarker('compile-done')}`,
  )
  const encoded = gzipSync(Buffer.from(marked)).toString('base64')
  adapter.args[adapter.args.length - 1] =
    joinPhaseMarker('powershell-start') + bootstrap.replace(joinPayload, encoded)
  return adapter
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

function joinCompileMs(cwd: string): number | undefined {
  try {
    const start = statSync(join(cwd, 'compile-start'))
    const done = statSync(join(cwd, 'compile-done'))
    if (!start.isFile() || !done.isFile() || start.size !== 0 || done.size !== 0) return
    const duration = done.mtimeMs - start.mtimeMs
    if (start.mtimeMs > 0 && Number.isFinite(duration) && duration >= 0) return Math.round(duration)
  } catch {
    // Missing marker times are not a measurement.
  }
}

// Bounding the assertion does not cancel the work or substitute for physical close in teardown.
async function withinJoinPhase<T>(
  pending: Promise<T>,
  startedAt: number,
  timeoutMs: number,
  phase: string,
): Promise<T> {
  const deadline = startedAt + timeoutMs
  const expired = () => new Error(`Broker ${phase} exceeded ${timeoutMs} ms`)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        const remaining = Math.max(0, Math.ceil(deadline - performance.now()))
        timer = setTimeout(() => reject(expired()), remaining)
      }),
    ])
    // Even if the event loop services the result before an overdue timer, don't accept it late.
    if (performance.now() >= deadline) throw expired()
    return result
  } finally {
    clearTimeout(timer)
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

  it('allowlists Windows compiler paths without inheriting Node options or credentials', () => {
    const paths = {
      sYsTeMrOoT: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      SystemDrive: 'C:',
      Path: 'C:\\Windows\\System32',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      pAtHeXt: '.COM;.EXE;.BAT;.CMD',
      ProgramFiles: 'C:\\Program Files',
      'programfiles(X86)': 'C:\\Program Files (x86)',
      ProgramW6432: 'C:\\Program Files',
      ProgramData: 'C:\\ProgramData',
      USERPROFILE: 'C:\\Users\\fixture',
      APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming',
      LocalAppData: 'C:\\Users\\fixture\\AppData\\Local',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\fixture',
    }
    const cwd = 'C:\\private-fixture'
    expect(
      safeWindowsCompilerEnv(
        {
          ...paths,
          Temp: 'C:\\inherited-temp',
          tMp: 'C:\\inherited-temp',
          NoDe_OpTiOnS: '--require injected.cjs',
          GiThUb_ToKeN: 'synthetic-token',
          OPENAI_API_KEY: 'synthetic-key',
          AWS_SECRET_ACCESS_KEY: 'synthetic-secret',
          SSH_AUTH_SOCK: 'synthetic-socket',
          GITHUB_WORKSPACE: 'C:\\unrelated-checkout',
          DOTNET_ROOT: 'C:\\unrelated-runtime',
        },
        cwd,
      ),
    ).toEqual({ ...paths, TEMP: cwd, TMP: cwd })
  })

  it('prepares an empty Windows compiler pipeline and join phase markers without spawning', () => {
    const cwd = 'fixture-cwd'
    const original = decodeJoinBootstrap(windowsJoinAdapter(cwd).args)
    const fixture = windowsJoinFixture(cwd)
    const { bootstrap, script } = decodeJoinBootstrap(brokerHostPlan(node, fixture).args)
    const start = joinPhaseMarker('compile-start')
    const done = joinPhaseMarker('compile-done')
    const compileWithEmptyInput = `@() | ${joinCompile}`
    const markedCompile = `${start}${compileWithEmptyInput}${done}`
    // Compare as booleans so a regression does not print the command or generated source.
    expect(
      bootstrap.replace(joinPayload, '') ===
        joinPhaseMarker('powershell-start') + original.bootstrap.replace(joinPayload, ''),
    ).toBe(true)
    expect(script.split(compileWithEmptyInput).length === 2).toBe(true)
    expect(script.endsWith(`${markedCompile}exit [HoliOwnedProcess]::RunBroker()`)).toBe(true)
    // The entire decoded script, including the C# here-string, must otherwise match.
    expect(script.replace(markedCompile, joinCompile) === original.script).toBe(true)
    expect(!script.includes('RunOriginalBroker')).toBe(true)
    expect(script.split('public static int RunBroker()').length === 2).toBe(true)
    expect(script.includes('foreach (byte expected in Encoding.UTF8.GetBytes("finish"))')).toBe(
      true,
    )
    expect(script.includes('ReadFile(input, one, 1, out count, IntPtr.Zero)')).toBe(true)
  })

  it(
    'waits past the terminal frame for physical exit without requiring parent EOF',
    // Windows headroom covers cold fixture startup plus the EOF, join and teardown phases.
    { timeout: process.platform === 'win32' ? 60_000 : 20_000 },
    verifyPhysicalJoin,
  )

  async function verifyPhysicalJoin() {
    const started = performance.now()
    const elapsed = () => Math.round(performance.now() - started)
    let phase = 'prepare'
    const phaseMs: Record<string, number> = { prepare: 0 }
    function enter(next: string) {
      const now = performance.now()
      phase = next
      phaseMs[next] = Math.round(now - started)
      return now
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
    const artifactSnapshots: Array<{
      offsetMs: number
      observation: ReturnType<typeof observeCompilerArtifacts>
    }> = []
    inspectFixture = () => {
      // CodeDOM may emit temporary source/binary files in this fixture-owned cwd.
      // Report only bounded aggregate evidence, never filenames or file contents.
      const compilerArtifacts = observeCompilerArtifacts(cwd)
      const counts = readJoinMarker(cwd, 'native-handles-closed', 19)
      const events = readJoinMarker(cwd, 'native-join-events', 512) ?? ''
      const failure = readJoinMarker(cwd, 'native-join-failure', 64)
      return {
        compilerArtifacts,
        artifactSnapshots,
        artifactGrowth:
          artifactSnapshots.length < 2
            ? 'insufficient-snapshots'
            : artifactSnapshots.some((snapshot) =>
                  Object.entries(snapshot.observation.files).some(([extension, value]) => {
                    const initial = artifactSnapshots[0]?.observation.files[extension]
                    return !initial || value.count > initial.count || value.bytes > initial.bytes
                  }),
                )
              ? 'observed-growth'
              : 'no-observed-growth',
        nativeFailure:
          failure !== undefined && /^[a-z-]{1,32},\d{1,10}$/.test(failure) ? failure : undefined,
        nativeStatus: Object.fromEntries(
          [...events.matchAll(/^(nativeExitCode|nativeSignal)=([A-Za-z0-9_-]{1,40})$/gm)].map(
            ([, event, value]) => [event, value],
          ),
        ),
        pipeErrors: Object.fromEntries(
          [...events.matchAll(/^([A-Za-z]+Error)=([A-Za-z0-9_]{1,40})$/gm)].map(
            ([, event, code]) => [event, code],
          ),
        ),
        terminalSeen,
        innerEof: existsSync(innerEof),
        powerShellEntered: existsSync(join(cwd, 'powershell-start')),
        compileStarted: existsSync(join(cwd, 'compile-start')),
        compileFinished: existsSync(join(cwd, 'compile-done')),
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
      // Cold Add-Type in the Windows fixture is startup, not part of the join proof.
      const startupStarted = enter('terminal')
      let snapshotTimer: ReturnType<typeof setInterval> | undefined
      if (native) {
        const sample = () => {
          if (artifactSnapshots.length >= 10) return
          artifactSnapshots.push({
            offsetMs: elapsed() - phaseMs.terminal,
            observation: observeCompilerArtifacts(cwd),
          })
        }
        sample()
        snapshotTimer = setInterval(sample, 5_000)
      }
      let seen: boolean
      try {
        seen = await (native
          ? withinJoinPhase(startup, startupStarted, 45_000, 'fixture startup')
          : startup)
      } finally {
        if (snapshotTimer) clearInterval(snapshotTimer)
      }
      expect(seen).toBe(true)
      enter('inner-eof')
      await expect.poll(() => existsSync(innerEof)).toBe(true)
      enter('pre-release-assertions')
      expect(existsSync(finished)).toBe(false)
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
      const finishSubmitted = enter('finish-submit')
      child.stdin.write('finish', (error) => {
        phaseMs.finishWrite = elapsed()
        finishWriteOk = !error
      }) // Release the inner process without sending parent EOF.
      enter('physical-join')
      const [status, output, errors] = await withinJoinPhase(
        Promise.all([closed, stdout, stderr]),
        finishSubmitted,
        2_000,
        'physical join',
      )
      enter('joined-assertions')
      expect(status).toEqual([0, null])
      expect(await readFile(finished, 'utf8')).toBe('done')
      expect(output.toString()).toBe('terminal\n')
      expect(errors).toHaveLength(0)
      if (native) {
        console.info(
          'HOLI_BROKER_JOIN_TIMING ' +
            JSON.stringify({
              startupMs: phaseMs.firstFrame - phaseMs.terminal,
              compileMs: joinCompileMs(cwd),
              joinMs: phaseMs.hostClose - phaseMs['finish-submit'],
            }),
        )
      }
    } catch (error) {
      reportFailure() // An ordinary failure must be captured before finally releases input.
      throw error
    } finally {
      if (!child.stdin.destroyed) child.stdin.end('finish')
      await closed // Require physical close even after a phase deadline, before cwd removal.
    }
  }

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
