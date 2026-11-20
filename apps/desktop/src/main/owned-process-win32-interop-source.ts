export const interopSource = String.raw`
public static partial class HoliOwnedProcess {
  const uint WaitTimeout=0x102, KillOnJobClose=0x2000;
  const uint ExtendedStartupInfoPresent=0x80000;
  const int HandleListAttribute=0x20002, JobListAttribute=0x2000d;
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    public int bInheritHandle;
  }
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,uint revision,out IntPtr descriptor,IntPtr size);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
  static extern SafePipeHandle CreateNamedPipeW(string name,uint openMode,uint pipeMode,uint instances,uint outputBytes,uint inputBytes,uint timeout,ref SECURITY_ATTRIBUTES attrs);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe,out uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CancelIoEx(SafePipeHandle handle,IntPtr overlapped);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
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
  [DllImport("kernel32.dll", ExactSpelling=true)] static extern void SetLastError(uint error);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attrs,string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access,bool inherit,string name);
  [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)] static extern bool CompareObjectHandles(IntPtr left,IntPtr right);
  [DllImport("ntdll.dll", ExactSpelling=true)] static extern int NtQueryInformationProcess(IntPtr process,int cls,IntPtr data,uint size,out uint used);
  [StructLayout(LayoutKind.Sequential)] struct HandleSnapshotEntry {
    public IntPtr HandleValue;
    public UIntPtr HandleCount, PointerCount;
    public uint GrantedAccess, ObjectTypeIndex, HandleAttributes, Reserved;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint len);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint len, IntPtr ret);
  [DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject",SetLastError=true)]
  static extern bool QueryLimits(IntPtr job,int cls,out JOBOBJECT_EXTENDED_LIMIT_INFORMATION info,uint len,IntPtr ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr handle,[Out] byte[] bytes,int count,out int read,IntPtr overlapped);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr handle,byte[] bytes,int count,out int written,IntPtr overlapped);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static Exception NativeQueryFailure(int code) {
    Fail("nativeQueryFailure");
    return new System.ComponentModel.Win32Exception(code);
  }
  static string JobName(string id) { return @"Local\holi-owned-job-"+id; }
  static IntPtr NewJob(string name=null) {
    SetLastError(0);
    var job=CreateJobObjectW(IntPtr.Zero,name); // NULL security attributes: not inheritable.
    int error=Marshal.GetLastWin32Error();
    if(job==IntPtr.Zero) throw new System.ComponentModel.Win32Exception(error);
    try {
      if(error==183) throw Fail("helperFailure"); // ERROR_ALREADY_EXISTS: never arm a foreign Job.
      SetKillOnClose(job,true);
      return job;
    }
    catch { Close(job); throw; }
  }
  static void SetKillOnClose(IntPtr job,bool armed) {
    var limits=new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    uint size=(uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    limits.BasicLimitInformation.LimitFlags=armed?KillOnJobClose:0;
    Check(SetInformationJobObject(job,9,ref limits,size));
    if(KillOnCloseArmed(job)!=armed) throw Fail("nativeQueryFailure");
  }
  static bool KillOnCloseArmed(IntPtr job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    if(!QueryLimits(job,9,out limits,(uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)),IntPtr.Zero))
      throw NativeQueryFailure(Marshal.GetLastWin32Error());
    return (limits.BasicLimitInformation.LimitFlags&KillOnJobClose)!=0;
  }
  static string RemoteHandleToken(IntPtr handle) {
    // Win32 handles shared across architectures have 32 significant bits.
    return unchecked((uint)handle.ToInt64()).ToString("x",CultureInfo.InvariantCulture);
  }
  static IntPtr RemoteHandle(string token) {
    return new IntPtr(unchecked((int)Convert.ToUInt32(token,16)));
  }
  static void CloseSource(IntPtr source) {
    IntPtr temporary;
    // DUPLICATE_CLOSE_SOURCE closes even on failure. Never try the same slot twice.
    try { Check(DuplicateHandle(parent,source,GetCurrentProcess(),out temporary,0,false,3)); }
    catch(Exception e) { RememberBrokerFailure(e); throw; }
    Close(temporary);
  }
  static void Free(IntPtr ptr) { if(ptr!=IntPtr.Zero) Marshal.FreeHGlobal(ptr); }
  static void Close(IntPtr handle) { if(handle!=IntPtr.Zero) CloseHandle(handle); }
  static IntPtr InheritableCopy(IntPtr source) {
    IntPtr copy, self=GetCurrentProcess();
    Check(DuplicateHandle(self,source,self,out copy,0,true,2));
    return copy;
  }
  static uint ActiveProcesses(IntPtr job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION counts;
    if(!QueryInformationJobObject(job,1,out counts,(uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),IntPtr.Zero))
      throw NativeQueryFailure(Marshal.GetLastWin32Error());
    return counts.ActiveProcesses;
  }
  static uint DrainJob(IntPtr job,IntPtr queryHandle,long deadline) {
    Check(TerminateJobObject(job,1));
    while(true) {
      if(Clock.ElapsedMilliseconds>=deadline) throw Fail("nativeQueryFailure");
      uint active=ActiveProcesses(queryHandle);
      if(active==0) return active;
      Thread.Sleep(PollMs);
    }
  }
}
`
