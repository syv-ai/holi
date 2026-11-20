$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($loadWin32) {
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class ControlFixture {
  const int ProcessHandleInformation = 51, ObjectNameInformation = 1, ObjectTypeInformation = 2;
  const int LengthMismatch = unchecked((int)0xc0000004), BufferTooSmall = unchecked((int)0xc0000023), BufferOverflow = unchecked((int)0x80000005);
  const int FileNotFound = 2, BrokenPipe = 109, PipeBusy = 231, PipeClosing = 232, PipeNotConnected = 233;
  const uint WaitTimeout = 258, FileTypePipe = 3;
  const string Prefix = @"\\.\pipe\", Device = @"\Device\NamedPipe\";

  [StructLayout(LayoutKind.Sequential)] struct HandleEntry {
    public IntPtr HandleValue, HandleCount, PointerCount;
    public uint GrantedAccess, ObjectTypeIndex, HandleAttributes, Reserved;
  }
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString {
    public ushort Length, MaximumLength;
    public IntPtr Buffer;
  }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(SafeWaitHandle process, int cls, IntPtr data, uint length, out uint used);
  [DllImport("ntdll.dll")] static extern int NtQueryObject(IntPtr handle, int cls, IntPtr data, uint length, out uint used);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll", SetLastError=true)] static extern SafeWaitHandle OpenProcess(uint rights, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(SafeWaitHandle process, out long birth, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(SafeWaitHandle process, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(SafeWaitHandle process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(SafeWaitHandle process, IntPtr source, IntPtr self, out IntPtr duplicate, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(IntPtr file);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr attrs, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool PeekNamedPipe(SafeFileHandle pipe, IntPtr buffer, uint bytes, IntPtr read, out uint available, IntPtr left);

  static void Require(bool ok, string reason) { if (!ok) throw new InvalidOperationException(reason); }
  static string Target(string leaf) {
    Require(Regex.IsMatch(leaf, "^holi-owned-[a-f0-9-]{36}$"), "invalid-target");
    return leaf;
  }

  public sealed class PeerResult {
    public uint clientPid { get; set; }
    public bool connected { get; set; }
    public int openError { get; set; }
    public int peerCloseError { get; set; }
    public uint greetingBytes { get; set; }
  }
  public static PeerResult Compete(string leaf, bool first) {
    string path=Prefix+Target(leaf);
    var watch=Stopwatch.StartNew();
    do {
      using (var pipe=CreateFileW(path,0xc0000000,0,IntPtr.Zero,3,0x40000000,IntPtr.Zero)) {
        int error=Marshal.GetLastWin32Error();
        if (pipe.IsInvalid) {
          if (!first || (error!=FileNotFound && error!=PipeBusy)) return new PeerResult{clientPid=GetCurrentProcessId(),openError=error};
        } else {
          var result=new PeerResult{clientPid=GetCurrentProcessId(),connected=true};
          if (!first) return result;
          var deadline=watch.ElapsedMilliseconds+4000;
          do {
            uint available;
            if (!PeekNamedPipe(pipe,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero)) {
              result.peerCloseError=Marshal.GetLastWin32Error();
              Require(result.peerCloseError==BrokenPipe || result.peerCloseError==PipeClosing || result.peerCloseError==PipeNotConnected,"peek-pipe-failed");
              return result;
            }
            if (available!=0) { result.greetingBytes=available; return result; }
            Thread.Sleep(15);
          } while (watch.ElapsedMilliseconds<deadline);
          throw new InvalidOperationException("peer-close-timeout");
        }
      }
      Thread.Sleep(20);
    } while (watch.ElapsedMilliseconds<15000);
    throw new InvalidOperationException("pipe-connect-timeout");
  }

  delegate int Query(IntPtr data, uint capacity, out uint used);
  static T InspectBuffer<T>(Query query, Func<IntPtr,uint,T> inspect, string reason) {
    for (uint size=4096; size<=16777216;) {
      IntPtr data=Marshal.AllocHGlobal((int)size);
      try {
        uint used;
        int status=query(data,size,out used);
        if (status==0) {
          Require(used>0 && used<=size,reason+"-size");
          return inspect(data,used);
        }
        Require(status==LengthMismatch || status==BufferTooSmall || status==BufferOverflow,reason);
        size=Math.Max(size*2,used);
      } finally { Marshal.FreeHGlobal(data); }
    }
    throw new InvalidOperationException(reason+"-limit");
  }
  static string ObjectText(IntPtr handle, int cls, string reason) {
    return InspectBuffer<string>(
      delegate(IntPtr data,uint size,out uint used) { return NtQueryObject(handle,cls,data,size,out used); },
      delegate(IntPtr data,uint used) {
        int header=Marshal.SizeOf(typeof(UnicodeString));
        Require(used>=header,reason+"-header");
        var text=(UnicodeString)Marshal.PtrToStructure(data,typeof(UnicodeString));
        long offset=text.Buffer.ToInt64()-data.ToInt64();
        Require(text.Length>0 && text.Length%2==0 && offset>=header && offset+text.Length<=used,reason+"-text");
        return Marshal.PtrToStringUni(text.Buffer,text.Length/2);
      },reason);
  }

  public sealed class HandleResult {
    public int handles { get; set; }
    public int inspected { get; set; }
    public int namedPipes { get; set; }
    public int positivePipeMatches { get; set; }
    public int controlPipeMatches { get; set; }
    public int jobHandles { get; set; }
    public bool jobMember { get; set; }
  }
  static string BirthOf(SafeWaitHandle process) {
    long created,exit,kernel,user;
    Require(GetProcessTimes(process,out created,out exit,out kernel,out user),"creation-time");
    return created.ToString(CultureInfo.InvariantCulture);
  }
  public static HandleResult Inspect(int rootPid, string birth, string target, string positive) {
    string wanted=Device+Target(target);
    Require(Regex.IsMatch(positive,"^holi-test-probe-[a-f0-9]{32}$"),"invalid-positive-control");
    string known=Device+positive;
    // QUERY_INFORMATION | DUP_HANDLE | SYNCHRONIZE, never PROCESS_TERMINATE here.
    using (var root=OpenProcess(0x100440,false,rootPid)) {
      Require(!root.IsInvalid,"open-root");
      Require(BirthOf(root)==birth,"root-identity");
      Require(WaitForSingleObject(root,0)==WaitTimeout,"root-not-live");
      bool member;
      Require(IsProcessInJob(root,IntPtr.Zero,out member),"job-membership-query");
      var result=InspectBuffer<HandleResult>(
        delegate(IntPtr data,uint size,out uint used) { return NtQueryInformationProcess(root,ProcessHandleInformation,data,size,out used); },
        delegate(IntPtr data,uint used) {
          int header=2*IntPtr.Size, stride=Marshal.SizeOf(typeof(HandleEntry));
          Require(used>=header,"handle-table-header");
          long count=Marshal.ReadIntPtr(data).ToInt64();
          Require(count>0 && count<=(used-header)/stride,"handle-table-count");
          var counts=new HandleResult{handles=(int)count,jobMember=member};
          for (int i=0;i<count;i++) {
            var entry=(HandleEntry)Marshal.PtrToStructure(IntPtr.Add(data,header+i*stride),typeof(HandleEntry));
            IntPtr copy;
            Require(DuplicateHandle(root,entry.HandleValue,GetCurrentProcess(),out copy,0,false,2),"duplicate-root-handle");
            try {
              string type=ObjectText(copy,ObjectTypeInformation,"query-handle-type");
              if (type=="Job") counts.jobHandles++;
              if (type=="File") {
                uint fileType=GetFileType(copy);
                Require(fileType!=0,"query-file-type");
                if (fileType==FileTypePipe) {
                  string name=ObjectText(copy,ObjectNameInformation,"query-pipe-name");
                  Require(name.StartsWith(Device,StringComparison.OrdinalIgnoreCase),"unknown-pipe-device");
                  counts.namedPipes++;
                  if (String.Equals(name,wanted,StringComparison.OrdinalIgnoreCase)) counts.controlPipeMatches++;
                  if (String.Equals(name,known,StringComparison.OrdinalIgnoreCase)) counts.positivePipeMatches++;
                }
              }
              counts.inspected++;
            } finally { Require(CloseHandle(copy),"close-duplicate"); }
          }
          return counts;
        },"query-handle-table");
      Require(WaitForSingleObject(root,0)==WaitTimeout,"root-exited-during-query");
      return result;
    }
  }
}
'@
}

function Find-Root([string]$image, [string]$nonce, [int]$helper) {
  if (![IO.Path]::IsPathRooted($image) -or $nonce -cnotmatch '^[0-9a-f]{32}$' -or $helper -le 0) { throw 'invalid-root-query' }
  $name = [IO.Path]::GetFileName($image).Replace("'", "\'")
  $path = $image.Replace('\', '\\').Replace("'", "\'")
  # Project only PIDs. Missing metadata on a possible child of this helper is not absence.
  $base = "SELECT ProcessId FROM Win32_Process WHERE Name = '$name'"
  $unknown = "$base AND ParentProcessId = $helper AND (ExecutablePath IS NULL OR (ExecutablePath = '$path' AND CommandLine IS NULL))"
  if (@(Get-CimInstance -Query $unknown -ErrorAction Stop).Count -gt 0) { throw 'unknown-root-query' }
  $query = "$base AND ExecutablePath = '$path' AND CommandLine LIKE '%$nonce%'"
  $pids = @(Get-CimInstance -Query $query -ErrorAction Stop | ForEach-Object {
    if ($null -eq $_.ProcessId -or $_.ProcessId -le 0) { throw 'unknown-root-query' }
    $_.ProcessId
  })
  return @{pids=$pids}
}

[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::Out.WriteLine('ready')
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $request = ConvertFrom-Json -InputObject $line
    $result = switch ($request.op) {
      'snapshot' { Find-Root ([string]$request.image) ([string]$request.nonce) ([int]$request.helperPid) }
      'first' { [ControlFixture]::Compete([string]$request.target, $true) }
      'second' { [ControlFixture]::Compete([string]$request.target, $false) }
      'inspect' { [ControlFixture]::Inspect([int]$request.pid, [string]$request.birth, [string]$request.target, [string]$request.positive) }
      default { throw 'invalid-op' }
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
  } catch {
    $code = $_.Exception.GetBaseException().Message
    if ($code -notmatch '^[a-z][a-z0-9-]{2,40}$') { $code = 'native-fixture-failed' }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{error=$code} -Compress))
    exit 1
  }
}
