import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fixtureResult, withFixtureCleanup } from './fixture-deadline'
import { registrationInspectorSource } from './windows-owned-process-registration-witness'

const MAX_LINE = 16_384
const DEFAULT_DEADLINE_MS = 5_000

export type WitnessOptions = {
  deadlineMs?: number
  powershellPath?: string
}

export type PinRequest = {
  pid: number
  expectedImage: string
  /** Synthetic command-line nonce; checked with Win32_Process while the handle is held. */
  nonce?: string
  /** Expected native creation FILETIME, decimal string, when already captured. */
  birth?: string
  /** Cross-check a producer's creator while the producer handle is held. */
  parentPid?: number
}

export type WitnessProcess = {
  id: string
  pid: number
  image: string
  birth: string
}

export type WindowsOwnedProcessWitness = {
  pin(request: PinRequest): Promise<WitnessProcess>
  exited(id: string): Promise<boolean>
  /** DWORD read from the held process only after its kernel handle is signaled. */
  exitCode(id: string): Promise<number>
  terminate(id: string): Promise<void>
  close(): Promise<void>
}

const NATIVE_DRAIN_MS = 5_000
const CLOSE_MS = NATIVE_DRAIN_MS + 3_000

const nativeSource = (inspectRegistration: boolean) => String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class HoliPinRejected : Exception {
  public HoliPinRejected(string message) : base(message) {}
}

public static partial class HoliWitness {
  const uint SYNC=0x00100000, QUERY=0x1000, TERMINATE=1, SIGNALED=0, TIMEOUT=258;
  const int DrainMs=${NATIVE_DRAIN_MS};
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, System.Text.StringBuilder path, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint n, IntPtr[] handles, bool all, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h, uint code);

  sealed class Entry {
    public readonly IntPtr Handle;
    public readonly int Pid;
    public readonly string Id, Birth, Image;
    public Entry(IntPtr handle, int pid, string id, string birth, string image) {
      Handle=handle; Pid=pid; Id=id; Birth=birth; Image=image;
    }
    public override string ToString() { return Id+"|"+Pid+"|"+Birth+"|"+Image; }
  }
  static readonly object gate=new object();
  static readonly Dictionary<string,Entry> candidates=new Dictionary<string,Entry>();
  static readonly Dictionary<string,Entry> owned=new Dictionary<string,Entry>();
  static readonly ManualResetEvent stopped=new ManualResetEvent(false), finished=new ManualResetEvent(false);
  static readonly AutoResetEvent input=new AutoResetEvent(false);
  static string reason, line;
  static int serial, clientPid, parentPid, selfPid;
  static bool drained;
  static IntPtr parent;
  static Thread watcher;

  static Exception Error(string name) { return new InvalidOperationException(name+":"+Marshal.GetLastWin32Error()); }
  static string Birth(IntPtr h) {
    long c,x,k,u;
    if(!GetProcessTimes(h,out c,out x,out k,out u)) throw Error("creation-time");
    return c.ToString(System.Globalization.CultureInfo.InvariantCulture);
  }
  static string Image(IntPtr h) {
    var path=new System.Text.StringBuilder(32768); uint size=(uint)path.Capacity;
    if(!QueryFullProcessImageName(h,0,path,ref size)) throw Error("image-query");
    return System.IO.Path.GetFullPath(path.ToString());
  }
  static void Admit() { if(reason!=null) throw new InvalidOperationException("cleanup-started"); }
  public static string Pin(int pid, string expectedImage, string expectedBirth) {
    // The caller, the watched parent, and the only cleanup owner can never be targets.
    if(pid<=0 || pid==clientPid || pid==parentPid || pid==selfPid)
      throw new HoliPinRejected("invalid-target");
    IntPtr h=OpenProcess(SYNC|QUERY|TERMINATE,false,pid);
    if(h==IntPtr.Zero) throw new HoliPinRejected(Error("open-process").Message);
    try {
      string image=Image(h), birth=Birth(h);
      if(!String.Equals(image,System.IO.Path.GetFullPath(expectedImage),StringComparison.OrdinalIgnoreCase))
        throw new HoliPinRejected("image-mismatch");
      if(!String.IsNullOrEmpty(expectedBirth) && birth!=expectedBirth) throw new HoliPinRejected("birth-mismatch");
      lock(gate) {
        Admit();
        if(owned.Count+candidates.Count>=256) throw new InvalidOperationException("record-limit");
        string id=(++serial).ToString();
        candidates.Add(id,new Entry(h,pid,id,birth,image)); h=IntPtr.Zero;
        return id+"|"+birth+"|"+image;
      }
    } finally { if(h!=IntPtr.Zero) CloseHandle(h); }
  }
  public static void Verify(string id) {
    lock(gate) {
      Admit(); Entry e=candidates[id];
      if(Exited(e,0)) throw new HoliPinRejected("process-exited-before-pin");
      owned.Add(id,e); candidates.Remove(id);
    }
  }
  public static void ReleaseCandidate(string id) {
    lock(gate) {
      Entry e;
      if(reason==null && candidates.TryGetValue(id,out e)) {
        if(!CloseHandle(e.Handle)) throw Error("candidate-close");
        candidates.Remove(id);
      }
    }
  }
  static bool Exited(Entry e, uint ms) {
    uint result=WaitForSingleObject(e.Handle,ms);
    if(result==SIGNALED) return true;
    if(result==TIMEOUT) return false;
    throw Error("wait-failed");
  }
  public static bool Exited(string id) { lock(gate) { Admit(); return Exited(owned[id],0); } }
  public static uint? ExitCode(string id) {
    lock(gate) {
      Admit(); Entry e=owned[id];
      if(!Exited(e,0)) return null;
      uint code;
      if(!GetExitCodeProcess(e.Handle,out code)) throw Error("exit-code-query");
      return code;
    }
  }
  static void Kill(Entry e) {
    if(!Exited(e,0) && !TerminateProcess(e.Handle,1)) {
      Exception failure=Error("terminate-failed");
      if(!Exited(e,0)) throw failure;
    }
  }
  public static void Kill(string id) { lock(gate) { Admit(); Kill(owned[id]); } }

  static Thread StartThread(ThreadStart run) {
    var thread=new Thread(run) { IsBackground=true }; thread.Start(); return thread;
  }
  public static void Start(int ownerPid, int watchedPid) {
    clientPid=ownerPid; parentPid=watchedPid;
    using(var self=Process.GetCurrentProcess()) selfPid=self.Id;
    parent=OpenProcess(SYNC,false,parentPid);
    if(parent==IntPtr.Zero) throw Error("parent-open");
    watcher=StartThread(delegate {
      uint r=WaitForMultipleObjects(2,new IntPtr[]{stopped.SafeWaitHandle.DangerousGetHandle(),parent},false,0xffffffff);
      if(r!=SIGNALED) Stop(r==SIGNALED+1 ? "parent-death" : "parent-wait-failure");
    });
    StartThread(Cleanup);
    StartThread(ReadInput);
  }
  // One native reader owns stdin. It still sees EOF while the PowerShell
  // command thread is blocked in CIM, a writer, or the private stall seam.
  static void ReadInput() {
    try {
      for (;;) {
        string next=Console.In.ReadLine();
        if(next==null) { Stop("eof"); return; }
        if(next=="close") { Stop("close"); return; }
        lock(gate) {
          if(reason!=null) return;
          if(line!=null || next.Length>16384) { Stop("input-failure"); return; }
          line=next; input.Set();
        }
      }
    } catch(System.IO.IOException) { Stop("eof"); }
      catch { Stop("input-failure"); }
  }
  public static string Next() {
    WaitHandle.WaitAny(new WaitHandle[]{stopped,input});
    lock(gate) { if(reason!=null) return null; string next=line; line=null; return next; }
  }
  // First writer closes admission, cancels the watcher, and wakes the sole
  // cleanup owner. Requesters do not hold the gate while joining that owner.
  public static void Stop(string why) {
    lock(gate) { if(reason==null) { reason=why; stopped.Set(); } }
  }
  public static bool JoinCleanup() { return finished.WaitOne(DrainMs+2500) && drained; }
  static void Report(string text) {
    try { Console.Error.WriteLine(text); Console.Error.Flush(); }
    catch(Exception) { /* A lost client must not interrupt the drain or discard the ledger. */ }
  }
  static void Cleanup() {
    stopped.WaitOne();
    Entry[] verified, unverified;
    lock(gate) {
      verified=new List<Entry>(owned.Values).ToArray();
      unverified=new List<Entry>(candidates.Values).ToArray();
    }
    // Keep the original handles of any targets whose exit cannot be proved.
    // Never close one just because cleanup failed or the client has gone away.
    var failures=new List<string>(); var kills=new Dictionary<Entry,string>();
    var clock=Stopwatch.StartNew();
    foreach(Entry e in verified) {
      try { Kill(e); } catch(Exception ex) { kills.Add(e,ex.Message); }
    }
    foreach(Entry e in verified) {
      try {
        if(!Exited(e,(uint)Math.Max(0,DrainMs-clock.ElapsedMilliseconds)))
          throw new InvalidOperationException(kills.ContainsKey(e) ? kills[e] : "exit-deadline");
        if(!CloseHandle(e.Handle)) throw Error("target-close");
        owned.Remove(e.Id);
      } catch(Exception ex) { failures.Add(e+"|"+ex.Message); }
    }
    foreach(Entry e in unverified) {
      if(CloseHandle(e.Handle)) candidates.Remove(e.Id);
      else failures.Add(e+"|unverified|"+Error("candidate-close").Message);
    }
    if(!watcher.Join(1000)) failures.Add("parent-watcher-join");
    else if(!CloseHandle(parent)) failures.Add(Error("parent-close").Message);
    ${inspectRegistration ? 'CleanupInspection(failures);' : ''}
    foreach(string failure in failures) Report("witness-undrained:"+failure);
    drained=failures.Count==0;
    Report("witness-cleanup:"+reason+":"+(drained ? "drained" : "failed"));
    finished.Set();
    if(drained) Environment.Exit(0);
    // In the failed case the command thread parks too: the only verified
    // handles still in the ledger must not be abandoned by exiting the host.
  }
}
`

const registrationCommands = String.raw`
function Format-Job($job) {
  return @{matches=$job.Matches; active=$job.Active; total=$job.Total; openError=$job.OpenError}
}
function Write-Survey($survey) {
  [Console]::Out.WriteLine((@{main=(Format-Job $survey.Main); guard=(Format-Job $survey.Guard); knownSlotsMatch=$survey.KnownSlotsMatch} | ConvertTo-Json -Depth 4 -Compress))
}
function Count-Root([string]$image, [string]$nonce, [int]$helper) {
  if (![IO.Path]::IsPathRooted($image) -or $nonce -cnotmatch '^[0-9a-f]{32}$') { throw 'invalid-root-query' }
  $name = [IO.Path]::GetFileName($image).Replace("'", "\'")
  $path = $image.Replace('\', '\\').Replace("'", "\'")
  $base = "SELECT ProcessId FROM Win32_Process WHERE Name = '$name'"
  $unknown = "$base AND ParentProcessId = $helper AND (ExecutablePath IS NULL OR (ExecutablePath = '$path' AND CommandLine IS NULL))"
  if (@(Get-CimInstance -Query $unknown -ErrorAction Stop).Count -gt 0) { throw 'unknown-root-query' }
  $query = "$base AND ExecutablePath = '$path' AND CommandLine LIKE '%$nonce%'"
  return @(Get-CimInstance -Query $query -ErrorAction Stop | ForEach-Object {
    if ($null -eq $_.ProcessId -or $_.ProcessId -le 0) { throw 'unknown-root-query' }
    $_.ProcessId
  }).Count
}
`

const registrationOps = String.raw`
        'inspect-parent' {
          [HoliWitness]::PinInspectionParent([string]$r.birth)
          [Console]::Out.WriteLine('{"ok":true}')
        }
        'survey-jobs' {
          Write-Survey ([HoliWitness]::SurveyRegistration([string]$r.helper, [string]$r.jobId, [string]$r.commitGuardId, [string]$r.jobHandle, [string]$r.commitGuardHandle))
        }
        'resurvey-jobs' { Write-Survey ([HoliWitness]::ResurveyRegistration()) }
        'reuse-slot' {
          $values = [HoliWitness]::ReuseRegistrationSlot()
          [Console]::Out.WriteLine((@{reused=$values[0]; distinct=$values[1]; open=$values[2]} | ConvertTo-Json -Compress))
        }
        'replacement-open' { [Console]::Out.WriteLine((@{open=[HoliWitness]::ReplacementOpen()} | ConvertTo-Json -Compress)) }
        'count-root' {
          $helper = [HoliWitness]::ExitedHelperPid([string]$r.helper)
          $count = Count-Root ([string]$r.image) ([string]$r.nonce) $helper
          [Console]::Out.WriteLine((@{count=$count} | ConvertTo-Json -Compress))
        }
`

function script(parentPid: number, allowStall: boolean, inspectRegistration: boolean): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
${nativeSource(inspectRegistration)}
${inspectRegistration ? registrationInspectorSource : ''}
'@
${inspectRegistration ? registrationCommands : ''}
[HoliWitness]::Start(${process.pid}, ${parentPid})
try {
  [Console]::Out.WriteLine('{"ready":true}')
  while (($line = [HoliWitness]::Next()) -ne $null) {
    $r = ConvertFrom-Json -InputObject $line
    try {
      switch ($r.op) {
        'pin' {
          $packed = [HoliWitness]::Pin([int]$r.pid, [string]$r.image, [string]$r.birth)
          $parts = $packed.Split('|', 3); $id=$parts[0]
          try {
            if ($r.nonce -or $r.parentPid) {
              $candidate = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([int]$r.pid)" -ErrorAction Stop
              if ($r.nonce -and (!$candidate.CommandLine -or !$candidate.CommandLine.Contains([string]$r.nonce))) { throw [HoliPinRejected]::new('nonce-mismatch') }
              if ($r.parentPid -and $candidate.ParentProcessId -ne $r.parentPid) { throw [HoliPinRejected]::new('parent-mismatch') }
            }
            [HoliWitness]::Verify($id)
          } catch { [HoliWitness]::ReleaseCandidate($id); throw }
          [Console]::Out.WriteLine((@{id=$id; birth=$parts[1]; image=$parts[2]} | ConvertTo-Json -Compress))
        }
        'exited' { [Console]::Out.WriteLine((@{exited=[HoliWitness]::Exited([string]$r.id)} | ConvertTo-Json -Compress)) }
        'exit-code' {
          $code = [HoliWitness]::ExitCode([string]$r.id)
          if ($null -eq $code) { [Console]::Out.WriteLine('{"error":"process-not-signaled"}') }
          else { [Console]::Out.WriteLine((@{code=$code} | ConvertTo-Json -Compress)) }
        }
        'terminate' { [HoliWitness]::Kill([string]$r.id); [Console]::Out.WriteLine('{"ok":true}') }
        ${inspectRegistration ? registrationOps : ''}
        ${allowStall ? `'stall' { [Console]::Out.WriteLine('{"stalled":true}'); [Threading.Thread]::Sleep(-1) }` : ''}
        default { throw 'unknown-operation' }
      }
    } catch {
      $failure = $_.Exception.GetBaseException()
      if ($failure -isnot [HoliPinRejected]) { throw }
      [Console]::Out.WriteLine((@{error=$failure.Message} | ConvertTo-Json -Compress))
    }
  }
} catch {
  # Publish the bounded command failure before waking the native cleanup owner,
  # which may finish the drain and exit this process immediately.
  $stage = [string]$r.op
  if ($stage -cnotmatch '^[a-z][a-z-]{2,30}$') { $stage = 'unknown-op' }
  $errorCode = $_.Exception.GetBaseException().Message
  if ($errorCode -cnotmatch '^[a-z][a-z-]{2,40}(:[0-9]+)?$') { $errorCode = 'native-command-failed' }
  try {
    [Console]::Error.WriteLine("witness-command-failure:$($stage):$errorCode")
    [Console]::Error.Flush()
  } finally { [HoliWitness]::Stop('command-failure') }
}
finally {
  [HoliWitness]::Stop('command-failure')
  [void][HoliWitness]::JoinCleanup()
  # Only the native owner may exit the host. On failure retain the undrained handles.
  [Threading.Thread]::Sleep(-1)
}
`
}

type Response = Record<string, unknown>
type NativeCleanup = { reason: string; drained: boolean }

/** Starts a Windows-only private observer. All operations are serialized and deadline-bound. */
export function startWitness(options: WitnessOptions = {}): Promise<WindowsOwnedProcessWitness> {
  return launchWitness(options, process.pid, false)
}

/** Only for native self-tests of a disconnected client or a blocked command thread. */
export async function startWitnessSelfTest(options: WitnessOptions & { parentPid?: number } = {}) {
  const witness = await launchWitness(options, options.parentPid ?? process.pid, true)
  return {
    witness: witness as WindowsOwnedProcessWitness,
    disconnect: () => witness.disconnect(),
    join: () => witness.joinCleanup(),
    stall: () => witness.stall(),
  }
}

export function startRegistrationWitness(options: WitnessOptions) {
  return launchWitness(options, process.pid, false, true)
}

async function launchWitness(
  options: WitnessOptions,
  parentPid: number,
  allowStall: boolean,
  inspectRegistration = false,
) {
  if (process.platform !== 'win32') throw new Error('Windows-only process witness')
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
  if (!Number.isInteger(deadlineMs) || deadlineMs < 250 || deadlineMs > 30_000)
    throw new Error('invalid deadline')
  if (!Number.isSafeInteger(parentPid) || parentPid < 1 || parentPid > 0x7fffffff)
    throw new Error('invalid witness parent')
  const source = script(parentPid, allowStall, inspectRegistration)
  const command = inspectRegistration
    ? [
        '-Command',
        `$b=[Convert]::FromBase64String('${gzipSync(source).toString('base64')}');$m=[IO.MemoryStream]::new($b);$z=[IO.Compression.GzipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($z,[Text.Encoding]::UTF8);& ([ScriptBlock]::Create($r.ReadToEnd()))`,
      ]
    : ['-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')]
  if (command[1]!.length > 32_000)
    throw new Error('witness script exceeds the Win32 command-line budget')
  const child = spawn(
    options.powershellPath ?? 'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', ...command],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const witness = new WitnessClient(child, deadlineMs)
  await withFixtureCleanup(
    () => witness.waitUntilReady(),
    () => witness.closeIfFailed(),
  )
  return witness
}

class WitnessClient implements WindowsOwnedProcessWitness {
  private buffer = ''
  private stderrBuffer = ''
  private diagnostics = ''
  private nativeCommandFailure?: Error
  private readonly nativeUndrained: string[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private closing?: Promise<void>
  private joining?: Promise<NativeCleanup>
  private failure?: Error
  private readonly ready = fixtureResult<void>()
  private readonly stalled = fixtureResult<void>()
  private readonly exit = fixtureResult<number | null>()
  private readonly closed = fixtureResult<void>()
  private readonly drainFinished = fixtureResult<NativeCleanup>()
  private nativeCleanup?: NativeCleanup
  private pending?: ReturnType<typeof fixtureResult<Response>>
  private readonly ledger = new Map<string, WitnessProcess>()
  private pinInFlight?: PinRequest

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly deadlineMs: number,
  ) {
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => this.consume(chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => this.consumeStderr(chunk))
    child.stdout.on('error', (error) => this.fail(error))
    child.stderr.on('error', (error) => this.fail(error))
    child.stdin.on('error', (error) => this.fail(error))
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code) => this.exit.settle({ value: code }))
    child.once('close', (code, signal) => {
      this.closed.settle({ value: undefined })
      if (!this.nativeCleanup)
        this.drainFinished.settle({ error: new Error('witness exited without a drain result') })
      // Unexpected death must reject any current command, but an expected
      // native close is not a new client error.
      if ((!this.closing && !this.joining) || this.pending || !this.ready.current)
        this.fail(
          this.nativeCommandFailure ?? new Error(`witness closed (${code ?? signal ?? 'unknown'})`),
        )
    })
  }

  private consume(chunk: string): void {
    if (this.failure) return
    this.buffer += chunk
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end < 0) break
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      try {
        if (line.length > MAX_LINE) throw new Error('witness response limit exceeded')
        const response = JSON.parse(line) as Response
        if (response.ready === true && !this.ready.current) this.ready.settle({ value: undefined })
        else if (response.stalled === true && !this.stalled.current)
          this.stalled.settle({ value: undefined })
        else {
          const pending = this.pending
          if (!pending) throw new Error('unsolicited witness response')
          this.pending = undefined
          pending.settle({ value: response })
        }
      } catch (error) {
        this.fail(error as Error)
        return
      }
    }
    if (this.buffer.length > MAX_LINE) this.fail(new Error('witness response limit exceeded'))
  }

  private consumeStderr(chunk: string) {
    this.diagnostics = (this.diagnostics + chunk).slice(-262_144)
    this.stderrBuffer += chunk
    for (;;) {
      const end = this.stderrBuffer.indexOf('\n')
      if (end < 0) break
      const line = this.stderrBuffer.slice(0, end).trim()
      this.stderrBuffer = this.stderrBuffer.slice(end + 1)
      if (line.startsWith('witness-undrained:')) this.nativeUndrained.push(line)
      const command = /^witness-command-failure:([a-z-]+):([a-z-]+(?::\d+)?)$/.exec(line)
      if (command)
        this.nativeCommandFailure ??= new Error(`witness ${command[1]} failed (${command[2]})`)
      const match = /^witness-cleanup:([a-z-]+):(drained|failed)$/.exec(line)
      if (match && !this.nativeCleanup) {
        this.nativeCleanup = { reason: match[1]!, drained: match[2] === 'drained' }
        this.drainFinished.settle({ value: this.nativeCleanup })
      }
    }
    this.stderrBuffer = this.stderrBuffer.slice(-MAX_LINE)
  }

  private fail(error: Error): Error {
    if (this.failure) return this.failure
    this.failure = error
    this.ready.settle({ error })
    this.stalled.settle({ error })
    this.pending?.settle({ error })
    this.pending = undefined
    // Closing admission is separate from native cleanup; the dedicated reader
    // sees broken pipe/EOF even if the command thread never returns.
    this.child.stdin.destroy()
    return error
  }

  waitUntilReady(): Promise<void> {
    return this.ready.wait(this.deadlineMs, 'witness startup').catch((error: Error) => {
      throw this.fail(error)
    })
  }

  async closeIfFailed() {
    if (this.failure) await this.joinCleanup()
  }

  private request<T>(
    op: string,
    values: Record<string, unknown>,
    decode: (response: Response) => T,
    pin?: PinRequest,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.failure) throw this.failure
      if (this.closing || this.joining) throw new Error('witness closed')
      const message = JSON.stringify({ op, ...values })
      if (message.length > MAX_LINE) throw new Error('witness request limit exceeded')
      const pending = (this.pending = fixtureResult<Response>())
      this.pinInFlight = pin
      let response: Response
      try {
        this.child.stdin.write(`${message}\n`, (error) => {
          if (error) this.fail(error)
        })
        response = await pending.wait(this.deadlineMs, `witness ${op}`)
        if (this.failure) throw this.failure
      } catch (error) {
        throw this.fail(error as Error)
      }
      if (typeof response.error === 'string') {
        this.pinInFlight = undefined
        throw new Error(response.error)
      }
      try {
        const value = decode(response)
        this.pinInFlight = undefined
        return value
      } catch (error) {
        throw this.fail(error as Error)
      }
    }
    const result = this.queue.then(run)
    this.queue = result.catch(() => undefined)
    return result
  }

  async pin(request: PinRequest): Promise<WitnessProcess> {
    if (
      !Number.isSafeInteger(request.pid) ||
      request.pid <= 0 ||
      request.pid > 0x7fffffff ||
      !isAbsolute(request.expectedImage) ||
      resolve(request.expectedImage) !== request.expectedImage ||
      (!request.nonce && !request.birth && request.parentPid === undefined)
    )
      throw new Error('invalid process identity')
    if (request.nonce !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(request.nonce))
      throw new Error('invalid fixture nonce')
    if (
      request.parentPid !== undefined &&
      (!Number.isSafeInteger(request.parentPid) || request.parentPid <= 0)
    )
      throw new Error('invalid fixture parent PID')
    if (request.birth !== undefined && !/^\d{1,20}$/.test(request.birth))
      throw new Error('invalid creation FILETIME')
    return this.request(
      'pin',
      {
        pid: request.pid,
        image: request.expectedImage,
        nonce: request.nonce,
        birth: request.birth,
        parentPid: request.parentPid,
      },
      (response) => {
        if (
          typeof response.id !== 'string' ||
          typeof response.birth !== 'string' ||
          typeof response.image !== 'string'
        )
          throw new Error('invalid pin response')
        const entry = {
          id: response.id,
          pid: request.pid,
          image: response.image,
          birth: response.birth,
        }
        this.ledger.set(entry.id, entry)
        return entry
      },
      request,
    )
  }

  exited(id: string): Promise<boolean> {
    return this.request('exited', { id: this.validId(id) }, (result) => {
      if (typeof result.exited !== 'boolean') throw new Error('invalid exit response')
      return result.exited
    })
  }

  exitCode(id: string): Promise<number> {
    return this.request('exit-code', { id: this.validId(id) }, ({ code }) => {
      if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 0xffffffff)
        throw new Error('invalid exit DWORD')
      return code
    })
  }

  pinInspectionParent(birth: string) {
    return this.request('inspect-parent', { birth }, ({ ok }) => {
      if (ok !== true) throw new Error('inspection parent not held')
    })
  }

  surveyJobs(
    helper: string,
    jobs: { jobId: string; commitGuardId: string },
    slots?: { jobHandle: string; commitGuardHandle: string },
  ) {
    return this.request(
      'survey-jobs',
      { helper: this.validId(helper), ...jobs, ...slots },
      decodeSurvey,
    )
  }

  resurveyJobs() {
    return this.request('resurvey-jobs', {}, decodeSurvey)
  }

  reuseSlot() {
    return this.request('reuse-slot', {}, ({ reused, distinct, open }) => ({
      reused: asBoolean(reused),
      distinct: asBoolean(distinct),
      open: asBoolean(open),
    }))
  }

  replacementOpen() {
    return this.request('replacement-open', {}, ({ open }) => asBoolean(open))
  }

  rootCount(helper: string, image: string, nonce: string) {
    return this.request('count-root', { helper: this.validId(helper), image, nonce }, ({ count }) =>
      asCount(count),
    )
  }

  terminate(id: string): Promise<void> {
    return this.request('terminate', { id: this.validId(id) }, (result) => {
      if (result.ok !== true) throw new Error('invalid terminate response')
    })
  }

  stall() {
    const request = this.request('stall', {}, () => {
      throw new Error('stall unexpectedly replied')
    })
    void request.catch(() => undefined)
    return { entered: this.stalled.wait(this.deadlineMs, 'witness stall entry'), request }
  }

  disconnect() {
    this.child.stdin.end()
    return this.joinCleanup()
  }

  joinCleanup(): Promise<NativeCleanup> {
    return (this.joining ??= this.awaitNativeCleanup())
  }

  private async awaitNativeCleanup(): Promise<NativeCleanup> {
    try {
      const deadline = performance.now() + CLOSE_MS
      const outcome = await this.drainFinished.wait(CLOSE_MS, 'witness native cleanup')
      if (!outcome.drained) throw new Error(`witness native drain failed (${outcome.reason})`)
      await this.closed.wait(Math.max(1, deadline - performance.now()), 'witness exit and close')
      const exit = this.exit.current
      if (!exit || !('value' in exit) || exit.value !== 0)
        throw new Error('witness native drain and exit were not proved')
      this.ledger.clear()
      this.pinInFlight = undefined
      return outcome
    } catch (error) {
      // No kill: closing the only verified handles would mask an incomplete drain.
      this.child.unref()
      this.child.stdin.destroy()
      this.child.stdout.destroy()
      this.child.stderr.destroy()
      throw new Error(
        `witness pid=${this.child.pid ?? 'none'} cleanup uncertain; ` +
          `pinned=${JSON.stringify([...this.ledger.values()])} inFlight=${JSON.stringify(this.pinInFlight ?? null)}; ` +
          `nativeUndrained=${JSON.stringify(this.nativeUndrained)}; ${this.diagnostics.trim()}`,
        { cause: error },
      )
    }
  }

  close(): Promise<void> {
    return (this.closing ??= this.closeAndJoin())
  }

  private async closeAndJoin() {
    if (!this.failure && !this.joining) {
      try {
        this.child.stdin.write('close\n', (error) => {
          if (error) this.fail(error)
        })
      } catch (error) {
        this.fail(error as Error)
      }
    }
    const outcome = await this.joinCleanup().catch((error: unknown) => {
      if (this.failure)
        throw new AggregateError([this.failure, error], 'witness client and native cleanup failed')
      throw error
    })
    if (this.failure) throw this.failure
    if (outcome.reason !== 'close') throw new Error(`unexpected witness cleanup: ${outcome.reason}`)
  }

  private validId(id: string): string {
    if (!/^\d{1,10}$/.test(id)) throw new Error('invalid witness id')
    return id
  }
}

function asBoolean(value: unknown) {
  if (typeof value !== 'boolean') throw new Error('invalid native inspector boolean')
  return value
}

function asCount(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('invalid native inspector count')
  return value
}

function decodeSurvey({ main, guard, knownSlotsMatch }: Response) {
  function job(value: unknown) {
    if (value === null || typeof value !== 'object') throw new Error('invalid inspector job')
    const { matches, active, total, openError } = value as Response
    if (
      (openError !== null && openError !== 2) ||
      (active === null) !== (openError === 2) ||
      (total === null) !== (openError === 2)
    )
      throw new Error('invalid inspector job query outcome')
    return {
      matches: asCount(matches),
      active: active === null ? null : asCount(active),
      total: total === null ? null : asCount(total),
      openError,
    }
  }
  return {
    main: job(main),
    guard: job(guard),
    knownSlotsMatch: knownSlotsMatch === null ? null : asBoolean(knownSlotsMatch),
  }
}

/** Synthetic fixture nonce helper; never use for production processes. */
export function fixtureNonce(): string {
  return randomUUID().replace(/-/g, '')
}
