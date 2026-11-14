import { ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { PassThrough } from 'node:stream'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { launchPlan, spawnProgram, type Launch } from './launch'

const PTY_TRANSPORT_PREFIX = 'HOLI_OWNED_PROCESS_PTY_'
const PTY_TRANSPORT_MODE = `${PTY_TRANSPORT_PREFIX}MODE`
const PTY_TRANSPORT_COUNT = `${PTY_TRANSPORT_PREFIX}COUNT`
const PTY_TRANSPORT_CHUNK = `${PTY_TRANSPORT_PREFIX}CHUNK_`
const PTY_TRANSPORT_CHUNK_SIZE = 29_000

/** Build a Windows console-parent launch for Electron's Node-mode PTY fallback.
 * The helper reads this compressed private environment transport; the root gets
 * only the original CLI environment plus launch-specific overrides.
 */
export function windowsPtyFallbackPlan(
  launch: Launch,
  options: Pick<SpawnOptions, 'cwd' | 'env'>,
): { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string } {
  if (launch.args.some((arg) => arg.includes('\0')) || launch.file.includes('\0')) {
    throw new Error('Windows PTY fallback arguments cannot contain NUL characters.')
  }
  const helperEnv = { ...(options.env ?? process.env) }
  for (const key of Object.keys(helperEnv))
    if (key.toUpperCase().startsWith(PTY_TRANSPORT_PREFIX)) delete helperEnv[key]
  const rootEnv = { ...helperEnv, ...launch.env }
  for (const key of Object.keys(rootEnv))
    if (key.toUpperCase() === 'HOLI_OWNED_PROCESS_TRACE') delete rootEnv[key]
  const payload = gzipSync(
    Buffer.from(
      JSON.stringify({
        bin: launch.file,
        args: launch.args,
        cwd: options.cwd,
        env: rootEnv,
        stopFile: '',
        parentPid: process.pid,
      }),
      'utf8',
    ),
  ).toString('base64')
  const chunks = payload.match(new RegExp(`.{1,${PTY_TRANSPORT_CHUNK_SIZE}}`, 'g')) ?? []
  const helper = windowsAdapterLaunch(helperEnv, {
    [PTY_TRANSPORT_MODE]: 'environment',
    [PTY_TRANSPORT_COUNT]: String(chunks.length),
    ...Object.fromEntries(chunks.map((chunk, index) => [`${PTY_TRANSPORT_CHUNK}${index}`, chunk])),
  })
  return helper
}

function windowsAdapterLaunch(
  env: NodeJS.ProcessEnv,
  transport: Record<string, string>,
): { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string } {
  const encoded = Buffer.from(WINDOWS_ADAPTER, 'utf16le').toString('base64')
  const systemRoot =
    [process.env.SystemRoot, process.env.WINDIR].find(
      (value) => value && win32.isAbsolute(value),
    ) ?? 'C:\\Windows'
  const cwd = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
  return {
    file: win32.join(cwd, 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    env: { ...env, ...transport },
    cwd,
  }
}

/**
 * Start a managed program whose lifetime includes every descendant it creates.
 * On Windows a small PowerShell/.NET adapter assigns the suspended root to a
 * kill-on-close Job Object before resuming it. The adapter's close event is
 * delayed until the Job Object is empty; stopping the adapter closes the job.
 * Other platforms retain the existing detached process-group behavior.
 */
export function spawnOwnedProgram(
  bin: string,
  args: readonly string[],
  options: SpawnOptions,
  parentPid = process.pid,
): ChildProcess {
  if (process.platform !== 'win32') {
    return spawnProgram(bin, [...args], { ...options, detached: true })
  }

  const launchEnv = { ...(options.env ?? process.env) }
  let traceEnabled = false
  for (const key of Object.keys(launchEnv)) {
    const name = key.toUpperCase()
    if (name === 'HOLI_OWNED_PROCESS_TRACE') {
      traceEnabled ||= launchEnv[key] === '1'
      delete launchEnv[key]
    } else if (name.startsWith(PTY_TRANSPORT_PREFIX)) delete launchEnv[key]
  }
  let plan
  try {
    plan = launchPlan(bin, args, { env: launchEnv, platform: 'win32' })
  } catch (error) {
    const failed = new ChildProcess()
    failed.stdin = new PassThrough()
    failed.stdout = new PassThrough()
    failed.stderr = new PassThrough()
    failed.stdin.end()
    failed.stdout.destroy()
    failed.stderr.destroy()
    process.nextTick(() => failed.emit('error', error as Error))
    return failed
  }
  const helperLaunch = windowsAdapterLaunch(launchEnv, {})
  const child = spawn(helperLaunch.file, helperLaunch.args, {
    ...options,
    cwd: helperLaunch.cwd,
    env: { ...launchEnv, ...(traceEnabled ? { HOLI_OWNED_PROCESS_TRACE: '1' } : {}) },
    detached: false,
    windowsHide: true,
    stdio: [
      'pipe',
      Array.isArray(options.stdio)
        ? (options.stdio[1] ?? 'pipe')
        : options.stdio === 'ignore' || options.stdio === 'inherit'
          ? options.stdio
          : 'pipe',
      Array.isArray(options.stdio)
        ? (options.stdio[2] ?? 'pipe')
        : options.stdio === 'ignore' || options.stdio === 'inherit'
          ? options.stdio
          : 'pipe',
    ] as SpawnOptions['stdio'],
  }) as ChildProcess
  const stopFile = join(tmpdir(), `holi-owned-${randomUUID()}.stop`)
  const spec = JSON.stringify({
    bin: plan.file,
    args: plan.args,
    verbatim: plan.verbatim,
    cwd: options.cwd,
    env: { ...launchEnv, ...plan.env },
    parentPid,
    stopFile,
  })
  child.stdin!.on('error', () => {
    // Channel failure stops and drains the job before callers receive close.
    if (child.pid === undefined) return
    try {
      child.kill('SIGTERM')
    } catch {
      // Closing the manager's stable handle closes its kill-on-close job.
      try {
        ChildProcess.prototype.kill.call(child, 'SIGKILL')
      } catch {
        // The ChildProcess error/close channel reports launch and exit failures.
      }
    }
  })
  child.stdin!.write(`${spec}\n`)
  const keepsStdinOpen =
    options.stdio === 'pipe' || (Array.isArray(options.stdio) && options.stdio[0] === 'pipe')
  if (!keepsStdinOpen) child.stdin!.end()
  child.kill = (signal?: NodeJS.Signals | number): boolean => {
    if (child.exitCode !== null || child.signalCode !== null) return false
    try {
      writeFileSync(stopFile, String(signal ?? 'SIGTERM'), { flag: 'wx' })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return true
      throw error
    }
  }
  child.once('close', () => rmSync(stopFile, { force: true }))
  return child
}

// Trusted code only is passed on the command line. User argv and environment
// travel in the first stdin record; the adapter reads it bytewise so bytes
// written after the record remain available as the managed program's stdin.
const WINDOWS_ADAPTER = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;
using System.IO.Compression;
using System.Web.Script.Serialization;
public static class HoliOwnedProcess {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaults, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static string Arg(string s) {
    if (s.Length > 0 && s.IndexOfAny(new char[]{' ', '\t', '\n', '\v', '"'}) < 0) return s;
    var b = new StringBuilder("\""); int slashes=0;
    foreach (char c in s) { if (c=='\\') { slashes++; continue; } if(c=='"') { b.Append('\\', slashes*2+1).Append('"'); slashes=0; } else { b.Append('\\',slashes).Append(c); slashes=0; } }
    b.Append('\\',slashes*2).Append('"'); return b.ToString();
  }
  static string ReadSpec() {
    // PTYs reserve console stdin for the CLI; managed launches keep the stdin record.
    if(Environment.GetEnvironmentVariable("HOLI_OWNED_PROCESS_PTY_MODE")=="environment") {
      int count; if(!Int32.TryParse(Environment.GetEnvironmentVariable("HOLI_OWNED_PROCESS_PTY_COUNT"),out count) || count<1 || count>10000) throw new Exception("invalid private launch transport");
      var encoded=new StringBuilder();
      for(int i=0;i<count;i++) { string part=Environment.GetEnvironmentVariable("HOLI_OWNED_PROCESS_PTY_CHUNK_"+i); if(part==null) throw new Exception("incomplete private launch transport"); encoded.Append(part); }
      byte[] compressed=Convert.FromBase64String(encoded.ToString());
      using(var source=new MemoryStream(compressed)) using(var gzip=new GZipStream(source,CompressionMode.Decompress)) using(var output=new MemoryStream()) { gzip.CopyTo(output); if(output.Length>16777216) throw new Exception("launch specification too large"); return Encoding.UTF8.GetString(output.ToArray()); }
    }
    var input=Console.OpenStandardInput(); var b=new MemoryStream(); int v;
    while((v=input.ReadByte())!=-1 && v!=10) { if(b.Length>1048576) throw new Exception("launch specification too large"); b.WriteByte((byte)v); }
    if(v==-1) throw new Exception("missing launch specification");
    return Encoding.UTF8.GetString(b.ToArray()).TrimEnd('\r');
  }
  static bool Tracing { get { return Environment.GetEnvironmentVariable("HOLI_OWNED_PROCESS_TRACE") == "1"; } }
  static void Trace(string phase, int rootPid=-1, string state="-") {
    if(!Tracing) return;
    Console.Error.WriteLine("[holi-owned-process] phase="+phase+" helperPid="+Process.GetCurrentProcess().Id+" rootPid="+rootPid+" state="+state);
    Console.Error.Flush();
  }
  public static int Run() {
    IntPtr job=IntPtr.Zero, parent=IntPtr.Zero; PROCESS_INFORMATION pi=new PROCESS_INFORMATION(); bool safelyFinished=false, stopped=false;
    try {
      Trace("before-json-record");
      var data=(System.Collections.Generic.Dictionary<string,object>)new JavaScriptSerializer().DeserializeObject(ReadSpec());
      Trace("after-json-record");
      int parentPid=Convert.ToInt32(data["parentPid"]);
      Trace("before-parent-validation");
      parent=OpenProcess(0x00101000, false, parentPid);
      if(parent==IntPtr.Zero) throw new Exception("cannot hold the Holi process handle");
      if(WaitForSingleObject(parent,0)!=0x102) throw new Exception("Holi exited before ownership was established");
      long parentCreated, selfCreated, ignored;
      Check(GetProcessTimes(parent,out parentCreated,out ignored,out ignored,out ignored));
      using(var self=Process.GetCurrentProcess()) Check(GetProcessTimes(self.Handle,out selfCreated,out ignored,out ignored,out ignored));
      if(parentCreated>selfCreated) throw new Exception("Holi process identity changed");
      Trace("after-parent-validation");
      if(File.Exists((string)data["stopFile"])) return 1;
      job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) Check(false);
      var limits=new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags=0x2000;
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))));
      string bin=(string)data["bin"]; var argv=(object[])data["args"];
      bool verbatim=data.ContainsKey("verbatim") && Convert.ToBoolean(data["verbatim"]);
      var cmd=new StringBuilder(Arg(bin));
      foreach(object a in argv) cmd.Append(' ').Append(verbatim?Convert.ToString(a):Arg(Convert.ToString(a)));
      var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(typeof(STARTUPINFO)); si.dwFlags=0x100; si.hStdInput=GetStdHandle(-10); si.hStdOutput=GetStdHandle(-11); si.hStdError=GetStdHandle(-12);
      IntPtr env=IntPtr.Zero;
      var vars=data["env"] as System.Collections.Generic.Dictionary<string,object>;
      if(vars!=null) { var eb=new StringBuilder(); var keys=new System.Collections.Generic.List<string>(vars.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase); foreach(string key in keys) if(vars[key]!=null) eb.Append(key).Append('=').Append(Convert.ToString(vars[key])).Append('\0'); eb.Append('\0'); env=Marshal.StringToHGlobalUni(eb.ToString()); }
      Trace("before-suspended-root-creation");
      Check(CreateProcess(bin,cmd,IntPtr.Zero,IntPtr.Zero,true,0x4|0x400,env,data.ContainsKey("cwd")?(string)data["cwd"]:null,ref si,out pi));
      Trace("after-suspended-root-creation",pi.dwProcessId);
      if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
      Trace("before-job-assignment",pi.dwProcessId);
      Check(AssignProcessToJobObject(job,pi.hProcess));
      Trace("after-job-assignment",pi.dwProcessId);
      if(File.Exists((string)data["stopFile"]) || WaitForSingleObject(parent,0)!=0x102) { Check(TerminateJobObject(job,1)); stopped=true; }
      else { Trace("before-root-resume",pi.dwProcessId); if(ResumeThread(pi.hThread)==0xffffffff) Check(false); Trace("after-root-resume",pi.dwProcessId); }
      while(true) {
        uint wait=WaitForSingleObject(pi.hProcess,100);
        if(WaitForSingleObject(parent,0)==0 || File.Exists((string)data["stopFile"])) { TerminateJobObject(job,1); stopped=true; break; }
        if(wait==0) break;
        if(wait!=0x102) Check(false);
      }
      uint code; Check(GetExitCodeProcess(pi.hProcess,out code));
      Trace("root-exit",pi.dwProcessId,code.ToString());
      Trace("before-job-termination",pi.dwProcessId);
      Check(TerminateJobObject(job,1));
      Trace("after-job-termination",pi.dwProcessId);
      while(true) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION counts;
        Check(QueryInformationJobObject(job,1,out counts,(uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),IntPtr.Zero));
        if(counts.ActiveProcesses==0) { Trace("job-drain-complete",pi.dwProcessId,"active=0"); safelyFinished=true; int result=stopped ? 1 : unchecked((int)code); Trace("helper-return",pi.dwProcessId,result.ToString()); return result; }
        if(WaitForSingleObject(parent,0)==0 || File.Exists((string)data["stopFile"])) { TerminateJobObject(job,1); stopped=true; }
        Thread.Sleep(50);
      }
    } catch(Exception e) { Console.Error.WriteLine("Holi could not establish managed process ownership: "+e.Message); Trace("helper-return",pi.dwProcessId,"125"); return 125; }
    finally { if(!safelyFinished) { if(job!=IntPtr.Zero) TerminateJobObject(job,1); if(pi.hProcess!=IntPtr.Zero) TerminateProcess(pi.hProcess,1); } if(pi.hThread!=IntPtr.Zero) CloseHandle(pi.hThread); if(pi.hProcess!=IntPtr.Zero) CloseHandle(pi.hProcess); if(job!=IntPtr.Zero) CloseHandle(job); if(parent!=IntPtr.Zero) CloseHandle(parent); }
  }
}
'@
if ($env:HOLI_OWNED_PROCESS_TRACE -eq '1') { [Console]::Error.WriteLine('[holi-owned-process] phase=before-add-type helperPid=' + $PID + ' rootPid=-1 state=-'); [Console]::Error.Flush() }
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Web.Extensions
if ($env:HOLI_OWNED_PROCESS_TRACE -eq '1') { [Console]::Error.WriteLine('[holi-owned-process] phase=after-add-type helperPid=' + $PID + ' rootPid=-1 state=-'); [Console]::Error.Flush() }
exit [HoliOwnedProcess]::Run()
`
