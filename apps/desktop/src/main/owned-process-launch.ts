import { ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { completionStream } from './owned-process-stream'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import type { Launch } from './launch'

function windowsAdapterLaunch(env: NodeJS.ProcessEnv): {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
} {
  const direct = Buffer.from(WINDOWS_ADAPTER, 'utf16le').toString('base64')
  const bootstrap = `$b=[Convert]::FromBase64String('${gzipSync(Buffer.from(WINDOWS_ADAPTER, 'utf8')).toString('base64')}');$m=[IO.MemoryStream]::new($b);$g=[IO.Compression.GzipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);& ([ScriptBlock]::Create($r.ReadToEnd()))`
  const encoded =
    direct.length <= 32767 ? direct : Buffer.from(bootstrap, 'utf16le').toString('base64')
  const systemRoot =
    [process.env.SystemRoot, process.env.WINDIR].find(
      (value) => value && win32.isAbsolute(value),
    ) ?? 'C:\\Windows'
  const cwd = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
  return {
    file: win32.join(cwd, 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    env,
    cwd,
  }
}

export function spawnOwnedLaunch(
  plan: Launch,
  options: SpawnOptions,
  parentPid: number,
  retainDescendantsOnSuccess = false,
): ChildProcess {
  const cwd =
    options.cwd instanceof URL ? fileURLToPath(options.cwd) : resolve(options.cwd ?? process.cwd())
  const launchEnv = { ...(options.env ?? process.env) }
  let traceEnabled = false
  for (const key of Object.keys(launchEnv)) {
    if (key.toUpperCase() === 'HOLI_OWNED_PROCESS_TRACE') {
      traceEnabled ||= launchEnv[key] === '1'
      delete launchEnv[key]
    }
  }
  const helperLaunch = windowsAdapterLaunch(launchEnv)
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
  const token = `holi-owned-${randomUUID()}`
  const stdoutMarker = `\\n[holi-complete-${randomUUID()}-stdout]\\n`
  const stderrMarker = `\\n[holi-complete-${randomUUID()}-stderr]\\n`
  if (retainDescendantsOnSuccess) {
    for (const [index, marker] of [stdoutMarker, stderrMarker].entries()) {
      const raw = index === 0 ? child.stdout : child.stderr
      if (!raw || typeof raw === 'string') continue
      const clean = completionStream(Buffer.from(marker))
      raw.on('error', (error) => {
        if (!clean.readableEnded) clean.destroy(error)
      })
      raw.once('close', () => {
        if (!raw.readableEnded && !clean.destroyed && !clean.readableEnded) {
          clean.destroy(new Error('managed output closed before completion'))
        }
      })
      raw.pipe(clean)
      if (index === 0) child.stdout = clean
      else child.stderr = clean
    }
  }
  const stopFile = join(tmpdir(), `${token}.stop`)
  const readyFile = join(tmpdir(), `${token}.ready`)
  const successFile = join(tmpdir(), `${token}.success`)
  const spec = JSON.stringify({
    bin: plan.file,
    args: plan.args,
    verbatim: plan.verbatim,
    cwd,
    env: { ...launchEnv, ...plan.env },
    parentPid,
    stopFile,
    readyFile,
    successFile,
    retainDescendantsOnSuccess,
    stdoutMarker,
    stderrMarker,
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
  let successCommitted = false
  Object.assign(child, {
    ownedSuccessReady: () => existsSync(readyFile),
    acknowledgeOwnedSuccess: () => {
      if (successCommitted || child.exitCode !== null || child.signalCode !== null) return false
      writeFileSync(successFile, '1', { flag: 'wx' })
      successCommitted = true
      return true
    },
  })
  child.kill = (signal?: NodeJS.Signals | number): boolean => {
    if (successCommitted || child.exitCode !== null || child.signalCode !== null) return false
    try {
      writeFileSync(stopFile, String(signal ?? 'SIGTERM'), { flag: 'wx' })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return true
      throw error
    }
  }
  child.once('close', () => {
    rmSync(stopFile, { force: true })
    rmSync(readyFile, { force: true })
    rmSync(successFile, { force: true })
  })
  return child
}

const WINDOWS_ADAPTER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = @'
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Threading;
using System.IO.Pipes;
using System.Web.Script.Serialization;
public static class HoliOwnedProcess {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
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
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
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
    IntPtr job=IntPtr.Zero, parent=IntPtr.Zero, env=IntPtr.Zero, attrList=IntPtr.Zero, handleList=IntPtr.Zero; PROCESS_INFORMATION pi=new PROCESS_INFORMATION(); bool attrInitialized=false, safelyFinished=false, stopped=false;
    string stopPath=null, readyPath=null, successPath=null;
    AnonymousPipeServerStream outputPipe=null, errorPipe=null; Thread outputRelay=null, errorRelay=null;
    Exception relayFailure=null; bool retain=false; string outputMarker=null, errorMarker=null;
    try {
      Trace("before-json-record");
      var data=(System.Collections.Generic.Dictionary<string,object>)new JavaScriptSerializer().DeserializeObject(ReadSpec());
      Trace("after-json-record");
      stopPath=(string)data["stopFile"]; readyPath=(string)data["readyFile"]; successPath=(string)data["successFile"];
      retain=data.ContainsKey("retainDescendantsOnSuccess") && Convert.ToBoolean(data["retainDescendantsOnSuccess"]);
      outputMarker=(string)data["stdoutMarker"]; errorMarker=(string)data["stderrMarker"];
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
      var si=new STARTUPINFOEX(); si.StartupInfo.cb=Marshal.SizeOf(typeof(STARTUPINFO)); si.StartupInfo.dwFlags=0x100; si.StartupInfo.hStdInput=GetStdHandle(-10); si.StartupInfo.hStdOutput=GetStdHandle(-11); si.StartupInfo.hStdError=GetStdHandle(-12);
      if(retain) {
        outputPipe=new AnonymousPipeServerStream(PipeDirection.In,HandleInheritability.Inheritable);
        errorPipe=new AnonymousPipeServerStream(PipeDirection.In,HandleInheritability.Inheritable);
        si.StartupInfo.hStdOutput=outputPipe.ClientSafePipeHandle.DangerousGetHandle();
        si.StartupInfo.hStdError=errorPipe.ClientSafePipeHandle.DangerousGetHandle();
        si.StartupInfo.cb=Marshal.SizeOf(typeof(STARTUPINFOEX));
        IntPtr attrSize=IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attrSize);
        attrList=Marshal.AllocHGlobal(attrSize);
        Check(InitializeProcThreadAttributeList(attrList,1,0,ref attrSize)); attrInitialized=true;
        handleList=Marshal.AllocHGlobal(IntPtr.Size*3);
        Marshal.WriteIntPtr(handleList,0,si.StartupInfo.hStdInput);
        Marshal.WriteIntPtr(handleList,IntPtr.Size,si.StartupInfo.hStdOutput);
        Marshal.WriteIntPtr(handleList,IntPtr.Size*2,si.StartupInfo.hStdError);
        Check(UpdateProcThreadAttribute(attrList,0,(IntPtr)0x20002,handleList,(IntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
        si.lpAttributeList=attrList;
      }
      var vars=data["env"] as System.Collections.Generic.Dictionary<string,object>;
      if(vars!=null) { var eb=new StringBuilder(); var keys=new System.Collections.Generic.List<string>(vars.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase); foreach(string key in keys) if(vars[key]!=null) eb.Append(key).Append('=').Append(Convert.ToString(vars[key])).Append('\0'); eb.Append('\0'); env=Marshal.StringToHGlobalUni(eb.ToString()); }
      Trace("before-suspended-root-creation");
      Check(CreateProcess(bin,cmd,IntPtr.Zero,IntPtr.Zero,true,(uint)(0x4|0x400|0x08000000|(retain?0x80000:0)),env,data.ContainsKey("cwd")?(string)data["cwd"]:null,ref si,out pi));
      if(retain) { outputPipe.DisposeLocalCopyOfClientHandle(); errorPipe.DisposeLocalCopyOfClientHandle();
        outputRelay=new Thread(()=>{try { var target=Console.OpenStandardOutput(); outputPipe.CopyTo(target); target.Flush(); } catch(Exception e) { relayFailure=e; }});
        errorRelay=new Thread(()=>{try { var target=Console.OpenStandardError(); errorPipe.CopyTo(target); target.Flush(); } catch(Exception e) { relayFailure=e; }});
        outputRelay.IsBackground=true; errorRelay.IsBackground=true; outputRelay.Start(); errorRelay.Start(); }
      Trace("after-suspended-root-creation",pi.dwProcessId);
      if(env!=IntPtr.Zero) { Marshal.FreeHGlobal(env); env=IntPtr.Zero; }
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
      if(!stopped && !File.Exists((string)data["stopFile"]) && code==0 && retain) {
        while(outputRelay.IsAlive || errorRelay.IsAlive) {
          if(WaitForSingleObject(parent,0)==0 || File.Exists((string)data["stopFile"])) { stopped=true; Check(TerminateJobObject(job,1)); break; }
          if(relayFailure!=null) throw new Exception("background output relay failed",relayFailure);
          Thread.Sleep(20);
        }
        if(stopped) { outputPipe.Dispose(); errorPipe.Dispose(); outputRelay.Join(); errorRelay.Join(); }
        else {
          outputRelay.Join(); errorRelay.Join();
          if(relayFailure!=null) throw new Exception("background output relay failed",relayFailure);
          var stdout=Console.OpenStandardOutput(); var stderr=Console.OpenStandardError();
          var outBytes=Encoding.UTF8.GetBytes(outputMarker); stdout.Write(outBytes,0,outBytes.Length); stdout.Flush();
          var errBytes=Encoding.UTF8.GetBytes(errorMarker); stderr.Write(errBytes,0,errBytes.Length); stderr.Flush();
          Console.SetOut(TextWriter.Null); Console.SetError(TextWriter.Null);
          File.WriteAllText((string)data["readyFile"],"1");
          while(true) {
            if(WaitForSingleObject(parent,0)==0 || File.Exists((string)data["stopFile"])) { stopped=true; break; }
            if(File.Exists((string)data["successFile"])) break;
            Thread.Sleep(20);
          }
        }
        if(!stopped && !File.Exists((string)data["stopFile"]) && WaitForSingleObject(parent,0)!=0) {
          limits.BasicLimitInformation.LimitFlags=0;
          Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))));
          safelyFinished=true; Trace("successful-detach",pi.dwProcessId); Trace("helper-return",pi.dwProcessId,"0"); return 0;
        }
      }
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
    finally { if(!safelyFinished) { if(job!=IntPtr.Zero) { TerminateJobObject(job,1); while(true) { JOBOBJECT_BASIC_ACCOUNTING_INFORMATION drain; if(!QueryInformationJobObject(job,1,out drain,(uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),IntPtr.Zero) || drain.ActiveProcesses==0) break; Thread.Sleep(25); } } if(pi.hProcess!=IntPtr.Zero) TerminateProcess(pi.hProcess,1); } try { if(outputPipe!=null) outputPipe.Dispose(); if(errorPipe!=null) errorPipe.Dispose(); if(outputRelay!=null && outputRelay.IsAlive) outputRelay.Join(2000); if(errorRelay!=null && errorRelay.IsAlive) errorRelay.Join(2000); } catch {} if(pi.hThread!=IntPtr.Zero) CloseHandle(pi.hThread); if(pi.hProcess!=IntPtr.Zero) CloseHandle(pi.hProcess); if(job!=IntPtr.Zero) CloseHandle(job); if(parent!=IntPtr.Zero) CloseHandle(parent); if(attrInitialized) DeleteProcThreadAttributeList(attrList); if(attrList!=IntPtr.Zero) Marshal.FreeHGlobal(attrList); if(handleList!=IntPtr.Zero) Marshal.FreeHGlobal(handleList); if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env); try { if(stopPath!=null) File.Delete(stopPath); if(readyPath!=null) File.Delete(readyPath); if(successPath!=null) File.Delete(successPath); } catch {} }
  }
}
'@
if ($env:HOLI_OWNED_PROCESS_TRACE -eq '1') { [Console]::Error.WriteLine('[holi-owned-process] phase=before-add-type helperPid=' + $PID + ' rootPid=-1 state=-'); [Console]::Error.Flush() }
Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.Web.Extensions','System.Core')
if ($env:HOLI_OWNED_PROCESS_TRACE -eq '1') { [Console]::Error.WriteLine('[holi-owned-process] phase=after-add-type helperPid=' + $PID + ' rootPid=-1 state=-'); [Console]::Error.Flush() }
exit [HoliOwnedProcess]::Run()
`
