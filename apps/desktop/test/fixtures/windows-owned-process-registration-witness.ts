// Independent of the producer/broker implementation. This fragment runs only in
// the registration witness, under its existing admission gate and cleanup owner.
export const registrationInspectorSource = String.raw`
public static partial class HoliWitness {
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessId(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", ExactSpelling=true)] static extern void SetLastError(uint error);
  [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)] static extern bool CompareObjectHandles(IntPtr a, IntPtr b);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr from, IntPtr slot, IntPtr to, out IntPtr copy, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern IntPtr CreateEventW(IntPtr security, bool manual, bool initial, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out Accounting result, uint bytes, IntPtr written);
  [DllImport("ntdll.dll", ExactSpelling=true)] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buffer, uint len, out uint used);

  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long TotalUser, TotalKernel, PeriodUser, PeriodKernel;
    public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential)] struct SnapshotEntry {
    public IntPtr Slot;
    public UIntPtr Handles, Pointers;
    public uint Access, Type, Attributes, Reserved;
  }
  public sealed class JobObservation {
    public int Matches;
    public uint? Active, Total;
    public int? OpenError;
  }
  public sealed class JobSnapshot {
    public JobObservation Main, Guard;
    public bool? KnownSlotsMatch;
  }

  static IntPtr inspectionParent, inspectMain, inspectGuard, fixtureEvent, reusedSlot;
  static readonly List<IntPtr> eventSlots=new List<IntPtr>();
  static readonly List<IntPtr> originalMain=new List<IntPtr>(), originalGuard=new List<IntPtr>();
  static bool surveyed;
  static int? mainOpenError, guardOpenError;

  static void Need(bool ok, string stage) { if(!ok) throw Error(stage); }
  static void CloseInspection(IntPtr h) { if(h!=IntPtr.Zero) Need(CloseHandle(h),"inspection-close"); }
  static bool SameObject(IntPtr a, IntPtr b) {
    SetLastError(0);
    if(CompareObjectHandles(a,b)) return true;
    int error=Marshal.GetLastWin32Error();
    if(error==0 || error==1656) return false;
    throw Error("inspection-compare");
  }
  static bool InspectionParentAlive() {
    uint wait=WaitForSingleObject(inspectionParent,0);
    if(wait==TIMEOUT) return true;
    Need(wait==SIGNALED,"inspection-parent-wait"); return false;
  }
  public static void PinInspectionParent(string birth) {
    lock(gate) {
      Admit(); Need(inspectionParent==IntPtr.Zero,"inspection-parent-already-held");
      // Only the client, at the FILETIME authenticated by the actual producer.
      inspectionParent=OpenProcess(0x00100440,false,clientPid);
      Need(inspectionParent!=IntPtr.Zero,"inspection-parent-open");
      Need(GetProcessId(inspectionParent)==(uint)clientPid && Birth(inspectionParent)==birth && InspectionParentAlive(),"inspection-parent-identity");
    }
  }
  public static int ExitedHelperPid(string id) {
    lock(gate) { Admit(); Entry helper=owned[id]; Need(Exited(helper,0),"helper-still-alive"); return helper.Pid; }
  }
  static IntPtr OpenInspectionJob(string id, out int? openError) {
    var h=OpenJobObjectW(4,false,@"Local\holi-owned-job-"+Guid.ParseExact(id,"D").ToString("D"));
    int error=Marshal.GetLastWin32Error();
    openError=null;
    if(h==IntPtr.Zero) { Need(error==2,"inspection-job-open"); openError=error; }
    return h;
  }
  static JobObservation QueryJob(IntPtr reference,int matches,int? openError) {
    var result=new JobObservation { Matches=matches, OpenError=openError };
    if(reference!=IntPtr.Zero) {
      Accounting accounting;
      Need(QueryInformationJobObject(reference,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"inspection-job-accounting");
      result.Active=accounting.Active; result.Total=accounting.Total;
    }
    return result;
  }
  static IntPtr CopyParentSlot(IntPtr slot) {
    IntPtr copy;
    if(DuplicateHandle(inspectionParent,slot,GetCurrentProcess(),out copy,0,false,2)) return copy;
    if(Marshal.GetLastWin32Error()==6) return IntPtr.Zero;
    throw Error("inspection-slot-copy");
  }
  static void InspectTable(List<IntPtr> main, List<IntPtr> guard) {
    int header=2*IntPtr.Size, stride=Marshal.SizeOf(typeof(SnapshotEntry));
    var clock=Stopwatch.StartNew();
    for(uint size=4096;size<=16*1024*1024;) {
      Need(InspectionParentAlive() && clock.ElapsedMilliseconds<DrainMs,"inspection-table-budget");
      IntPtr memory=Marshal.AllocHGlobal((int)size);
      try {
        uint used;
        int status=NtQueryInformationProcess(inspectionParent,51,memory,size,out used);
        if(status==unchecked((int)0xc0000004) || status==unchecked((int)0xc0000023) || status==unchecked((int)0x80000005)) {
          size=Math.Max(size*2,used); continue;
        }
        Need(status==0 && used>=header && used<=size,"inspection-table-query");
        long count=Marshal.ReadIntPtr(memory).ToInt64();
        Need(count>=0 && count<=(used-header)/stride,"inspection-table-layout");
        for(int i=0;i<count;i++) {
          Need(clock.ElapsedMilliseconds<DrainMs,"inspection-slot-budget");
          IntPtr slot=Marshal.ReadIntPtr(memory,header+i*stride);
          Need(slot.ToInt64()>0,"inspection-slot-layout");
          IntPtr copy=CopyParentSlot(slot);
          if(copy==IntPtr.Zero) continue; // Transient unrelated handles may disappear.
          try {
            if(inspectMain!=IntPtr.Zero && SameObject(copy,inspectMain)) main.Add(slot);
            if(inspectGuard!=IntPtr.Zero && SameObject(copy,inspectGuard)) guard.Add(slot);
          } finally { CloseInspection(copy); }
        }
        Need(InspectionParentAlive(),"inspection-parent-exited"); return;
      } finally { Marshal.FreeHGlobal(memory); }
    }
    throw Error("inspection-table-limit");
  }
  static IntPtr Token(string value) { return new IntPtr(unchecked((int)Convert.ToUInt32(value,16))); }
  public static JobSnapshot SurveyRegistration(string helper,string mainId,string guardId,string mainToken,string guardToken) {
    lock(gate) {
      Admit(); Need(!surveyed && inspectionParent!=IntPtr.Zero,"inspection-survey-order");
      // In particular, do not keep the unduplicated guard alive across a hard exit.
      ExitedHelperPid(helper);
      inspectMain=OpenInspectionJob(mainId,out mainOpenError);
      inspectGuard=OpenInspectionJob(guardId,out guardOpenError);
      InspectTable(originalMain,originalGuard);
      surveyed=true;
      var result=Summarize(originalMain.Count,originalGuard.Count);
      if(!String.IsNullOrEmpty(mainToken) || !String.IsNullOrEmpty(guardToken)) {
        result.KnownSlotsMatch=originalMain.Count==1 && originalGuard.Count==1 &&
          originalMain[0]==Token(mainToken) && originalGuard[0]==Token(guardToken) && originalMain[0]!=originalGuard[0];
      }
      return result;
    }
  }
  static JobSnapshot Summarize(int main,int guard) {
    return new JobSnapshot { Main=QueryJob(inspectMain,main,mainOpenError), Guard=QueryJob(inspectGuard,guard,guardOpenError) };
  }
  public static JobSnapshot ResurveyRegistration() {
    lock(gate) {
      Admit(); Need(surveyed,"inspection-survey-missing");
      var main=new List<IntPtr>(); var guard=new List<IntPtr>();
      InspectTable(main,guard); return Summarize(main.Count,guard.Count);
    }
  }
  public static bool[] ReuseRegistrationSlot() {
    lock(gate) {
      Admit(); Need(surveyed && fixtureEvent==IntPtr.Zero && originalMain.Count==1 && originalGuard.Count==1 && InspectionParentAlive(),"replacement-order");
      fixtureEvent=CreateEventW(IntPtr.Zero,false,false,null);
      Need(fixtureEvent!=IntPtr.Zero,"replacement-event-create");
      var clock=Stopwatch.StartNew();
      // Keep allocations until finally/cleanup; otherwise the allocator could
      // hand back the same non-target slot each time.
      for(int i=0;i<4096 && clock.ElapsedMilliseconds<2000;i++) {
        IntPtr slot; var self=GetCurrentProcess();
        Need(DuplicateHandle(self,fixtureEvent,inspectionParent,out slot,0,false,2),"replacement-allocate");
        eventSlots.Add(slot);
        if(slot!=originalMain[0] && slot!=originalGuard[0]) continue;
        reusedSlot=slot;
        IntPtr copy=CopyParentSlot(slot);
        Need(copy!=IntPtr.Zero,"replacement-copy-missing");
        try {
          return new bool[] { true,!SameObject(copy,inspectMain) && !SameObject(copy,inspectGuard),SameObject(copy,fixtureEvent) };
        } finally { CloseInspection(copy); }
      }
      throw Error("replacement-reuse-bound");
    }
  }
  public static bool ReplacementOpen() {
    lock(gate) {
      Admit(); Need(reusedSlot!=IntPtr.Zero && InspectionParentAlive(),"replacement-slot-missing");
      IntPtr copy=CopyParentSlot(reusedSlot);
      if(copy==IntPtr.Zero) return false;
      try { return SameObject(copy,fixtureEvent); } finally { CloseInspection(copy); }
    }
  }
  // Called only by the joined witness cleanup owner, after closing admission.
  // The inspector does not close or terminate either original Parent Job slot.
  static void CleanupInspection(List<string> failures) {
    foreach(IntPtr slot in eventSlots) {
      try {
        if(!InspectionParentAlive()) continue; // The kernel closed the parent's table.
        IntPtr copy=CopyParentSlot(slot);
        Need(copy!=IntPtr.Zero,"replacement-lost-before-cleanup");
        try { Need(SameObject(copy,fixtureEvent),"replacement-changed-before-cleanup"); }
        finally { CloseInspection(copy); }
        IntPtr consumed;
        // CLOSE_SOURCE is one-shot, even on FALSE.
        Need(DuplicateHandle(inspectionParent,slot,GetCurrentProcess(),out consumed,0,false,3),"replacement-source-close");
        CloseInspection(consumed);
      } catch(Exception ex) { failures.Add(ex.Message); }
    }
    foreach(IntPtr h in new IntPtr[]{fixtureEvent,inspectGuard,inspectMain,inspectionParent}) {
      try { CloseInspection(h); } catch(Exception ex) { failures.Add(ex.Message); }
    }
  }
}
`
