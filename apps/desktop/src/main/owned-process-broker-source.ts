export const brokerSource = String.raw`
public static partial class HoliOwnedProcess {
  static string brokerPhase="open-pipes", brokerFailurePhase;
  static uint brokerFailureCode;
  static void RememberBrokerFailure(Exception error) {
    if(brokerFailurePhase!=null) return;
    brokerFailurePhase=brokerPhase;
    var native=error as System.ComponentModel.Win32Exception;
    if(native!=null) brokerFailureCode=unchecked((uint)native.NativeErrorCode);
  }
  static IntPtr BrokerPipe(int which) {
    var pipe=GetStdHandle(which);
    if(pipe==new IntPtr(-1)) Check(false);
    if(pipe==IntPtr.Zero) throw Fail("controlFailure");
    uint type=GetFileType(pipe);
    if(type==0) Check(false);
    if(type!=3) throw Fail("controlFailure"); // FILE_TYPE_PIPE only.
    return pipe;
  }
  static int BrokerReadBytes(IntPtr pipe,byte[] bytes) {
    int read;
    if(ReadFile(pipe,bytes,bytes.Length,out read,IntPtr.Zero)) return read;
    int error=Marshal.GetLastWin32Error();
    if(error==109 || error==232) return 0; // EOF on the synchronous pipe.
    throw new System.ComponentModel.Win32Exception(error);
  }
  static void BrokerWriteBytes(IntPtr pipe,byte[] bytes) {
    int written;
    Check(WriteFile(pipe,bytes,bytes.Length,out written,IntPtr.Zero));
    if(written!=bytes.Length) throw new IOException("short broker write");
  }
  static void ReportBrokerFailure() {
    // Never forward PowerShell output, exception text, or transcript bytes.
    // This is a bounded diagnostic, not an authenticated ownership receipt.
    var bytes=Utf8.GetBytes("HOLI_BROKER_FAILURE "+brokerFailurePhase+" "+brokerFailureCode.ToString(CultureInfo.InvariantCulture)+"\n");
    try { Task.Run(()=>BrokerWriteBytes(BrokerPipe(-12),bytes)).Wait(PollMs*5); } catch {}
  }
  static Record BrokerRead(IntPtr input,long deadline) {
    return ReadAvailable(deadline,()=>Task.Run(()=>BrokerReadBytes(input,readBuffer)));
  }
  static void BrokerSend(IntPtr output,string json,long deadline) {
    byte[] bytes=Encode(json);
    try {
      AwaitIo(Task.Run(()=>BrokerWriteBytes(output,bytes)),deadline);
      sendSeq++;
    } catch(Exception e) { RememberBrokerFailure(e); throw Fail("controlFailure"); }
  }
  static uint DrainBrokerJob(IntPtr job,long deadline) {
    // With the producer joined there is no new admission. A successful native
    // zero query makes terminating an already terminated Job unnecessary.
    if(Clock.ElapsedMilliseconds>=deadline) throw Fail("nativeQueryFailure");
    return ActiveProcesses(job)==0 ? 0 : DrainJob(job,job,deadline);
  }
  static void DrainWithGuard(IntPtr job,IntPtr guard) {
    // Try BOTH operations, even when one fails. The drain has its own budget
    // and does not depend on a live parent, a working pipe or source slots.
    for(;;) {
      bool armed=false;
      try { SetKillOnClose(guard,true); armed=true; } catch {}
      try {
        DrainBrokerJob(job,Clock.ElapsedMilliseconds+CleanupMs);
        return;
      } catch {
        // No zero receipt. The verified guard still protects the tree on
        // last close. If neither operation proved safety, retain both handles
        // and retry; exiting would abandon an unguarded Job.
        if(armed) throw;
        Thread.Sleep(PollMs);
      }
    }
  }
  static void ObserveCommit(IntPtr input,IntPtr output,string binding,IntPtr job,IntPtr guard,long deadline) {
    try {
      brokerPhase="clear-guard";
      if(!ParentAlive()) throw Fail("parentUnavailable");
      if(!KillOnCloseArmed(guard)) throw Fail("nativeQueryFailure");
      SetKillOnClose(guard,false);
      brokerPhase="send-committed";
      BrokerSend(output,"{\"type\":\"committed\""+binding,deadline);
      brokerPhase="read-observed";
      var observed=BrokerRead(input,deadline);
      // OBSERVED uses the acknowledge record on this one broker transcript.
      // Its MAC binds direction, sequence and the fresh launch/Job/guard IDs.
      if(!Exact(observed,"type") || !Object.Equals(observed["type"],"acknowledge")) throw Fail("protocolFailure");
      if(Clock.ElapsedMilliseconds>=deadline) throw Fail("controlFailure");
      if(!ParentAlive()) throw Fail("parentUnavailable");
      // Native decision: the held parent was alive with authenticated evidence
      // of the guard clear, and had a provider owner before granting release.
    } catch(Exception e) {
      RememberBrokerFailure(e);
      if(failure==null) failure="helperFailure";
      try { DrainWithGuard(job,guard); } catch {} // Preserve the first failure, not an EMPTY receipt.
      throw;
    }
  }
  static IntPtr OpenRecoveryJob(string id) {
    const uint QueryAndTerminate=0x4|0x8;
    IntPtr job=OpenJobObjectW(QueryAndTerminate,false,JobName(id));
    if(job!=IntPtr.Zero) return job;
    int error=Marshal.GetLastWin32Error();
    if(error==2) return IntPtr.Zero; // ERROR_FILE_NOT_FOUND alone proves absence.
    throw NativeQueryFailure(error);
  }
  sealed class JobMatches {
    public IntPtr JobSlot, GuardSlot;
    public int JobCount, GuardCount;
  }
  static void ScanBudget(long deadline) {
    if(!ParentAlive()) throw Fail("parentUnavailable");
    if(Clock.ElapsedMilliseconds>=deadline) throw Fail("nativeQueryFailure");
  }
  static bool SameKernelObject(IntPtr left,IntPtr right) {
    // .NET Framework does not clear last error before a SetLastError P/Invoke.
    SetLastError(0);
    if(CompareObjectHandles(left,right)) return true;
    int error=Marshal.GetLastWin32Error();
    if(error==0 || error==1656) return false; // Definite mismatch / ERROR_NOT_SAME_OBJECT.
    throw NativeQueryFailure(error);
  }
  static void VisitBrokerHandleTable(IntPtr process,long deadline,Action<HandleSnapshotEntry> visit) {
    const int ProcessHandleInformation=51;
    const int LengthMismatch=unchecked((int)0xc0000004), BufferTooSmall=unchecked((int)0xc0000023), BufferOverflow=unchecked((int)0x80000005);
    const uint MaxBytes=16*1024*1024;
    // PROCESS_HANDLE_SNAPSHOT_INFORMATION: two ULONG_PTRs, then entries (40 bytes on x64).
    int header=2*IntPtr.Size, stride=Marshal.SizeOf(typeof(HandleSnapshotEntry));
    for(uint size=4096;size<=MaxBytes;) {
      ScanBudget(deadline);
      var buffer=Marshal.AllocHGlobal((int)size);
      try {
        uint used;
        int status=NtQueryInformationProcess(process,ProcessHandleInformation,buffer,size,out used);
        if(status!=0) {
          if(status!=LengthMismatch && status!=BufferTooSmall && status!=BufferOverflow)
            throw NativeQueryFailure(status);
          size=Math.Max(size*2,used);
          continue;
        }
        if(used<header || used>size) throw Fail("nativeQueryFailure");
        long count=Marshal.ReadIntPtr(buffer).ToInt64();
        if(count<0 || count>(used-header)/stride) throw Fail("nativeQueryFailure");
        for(int i=0;i<count;i++) {
          ScanBudget(deadline);
          var entry=Marshal.PtrToStructure<HandleSnapshotEntry>(IntPtr.Add(buffer,header+i*stride));
          if(entry.HandleValue.ToInt64()<=0 || entry.ObjectTypeIndex==0) throw Fail("nativeQueryFailure");
          visit(entry);
        }
        ScanBudget(deadline);
        return;
      } finally { Free(buffer); }
    }
    throw Fail("nativeQueryFailure");
  }
  static uint BrokerJobType(IntPtr self,IntPtr job,IntPtr guard,long deadline) {
    if(job==IntPtr.Zero && guard==IntPtr.Zero) return 0; // Neither named Job was opened.
    uint jobType=0, guardType=0;
    // These local slots are held throughout recovery. Get both indices from
    // the same native snapshot, never from an assumed kernel type number.
    VisitBrokerHandleTable(self,deadline,entry=> {
      if(entry.HandleValue==job) {
        if(jobType!=0) throw Fail("nativeQueryFailure");
        jobType=entry.ObjectTypeIndex;
      }
      if(entry.HandleValue==guard) {
        if(guardType!=0) throw Fail("nativeQueryFailure");
        guardType=entry.ObjectTypeIndex;
      }
    });
    if((job!=IntPtr.Zero && jobType==0) || (guard!=IntPtr.Zero && guardType==0) ||
       (jobType!=0 && guardType!=0 && jobType!=guardType)) throw Fail("nativeQueryFailure");
    return jobType!=0 ? jobType : guardType;
  }
  static JobMatches ScanParentJobs(IntPtr job,IntPtr guard,long deadline) {
    var self=GetCurrentProcess();
    uint jobType=BrokerJobType(self,job,guard,deadline);
    var result=new JobMatches();
    VisitBrokerHandleTable(parent,deadline,entry=> {
      // Non-Job objects may not be duplicable. The type only selects
      // candidates; exact identity still requires comparing local copies.
      if(entry.ObjectTypeIndex!=jobType) return;
      var slot=entry.HandleValue;
      IntPtr copy;
      if(!DuplicateHandle(parent,slot,self,out copy,0,false,2))
        throw NativeQueryFailure(Marshal.GetLastWin32Error());
      try {
        if(job!=IntPtr.Zero && SameKernelObject(copy,job)) {
          result.JobSlot=slot; result.JobCount++;
        }
        if(guard!=IntPtr.Zero && SameKernelObject(copy,guard)) {
          result.GuardSlot=slot; result.GuardCount++;
        }
      } finally { Close(copy); }
    });
    return result;
  }
  static void RecoveryEvidence(Record receipt,string prefix,IntPtr reference,int before,int after,uint? activeBefore,uint? activeAfter) {
    bool absent=reference==IntPtr.Zero;
    receipt[prefix+"State"]=absent ? "absent" : "closed-zero";
    receipt[prefix+"Before"]=absent ? null : (object)before;
    receipt[prefix+"After"]=absent ? null : (object)after;
    receipt[prefix+"ActiveBefore"]=activeBefore;
    receipt[prefix+"ActiveAfter"]=activeAfter;
  }
  static void RecoverPending(IntPtr output,string jobId,string guardId,int pid,string birth,long deadline) {
    IntPtr job=IntPtr.Zero, guard=IntPtr.Zero;
    try {
      // Node has frozen adoption and joined the producer's physical exit. A
      // missing named object now means no reference survived, not a zero query.
      brokerPhase="open-jobs";
      job=OpenRecoveryJob(jobId);
      guard=OpenRecoveryJob(guardId);
      brokerPhase="scan-objects";
      var before=ScanParentJobs(job,guard,deadline);
      if(before.JobCount!=(job==IntPtr.Zero ? 0 : 1) || before.GuardCount!=(guard==IntPtr.Zero ? 0 : 1) ||
         (job!=IntPtr.Zero && before.JobSlot==before.GuardSlot)) throw Fail("nativeQueryFailure");
      brokerPhase="drain-jobs";
      uint? jobActive=job==IntPtr.Zero ? (uint?)null : ActiveProcesses(job);
      uint? guardActive=guard==IntPtr.Zero ? (uint?)null : ActiveProcesses(guard);
      uint? jobZero=job==IntPtr.Zero ? (uint?)null : DrainBrokerJob(job,deadline);
      uint? guardZero=guard==IntPtr.Zero ? (uint?)null : DrainBrokerJob(guard,deadline);
      ScanBudget(deadline);
      // Only this frozen lease can close these matched slots; the producer is
      // gone and the held parent cannot change epoch. Other slots can churn.
      // CLOSE_SOURCE can consume on FALSE. Never retry (even after lost proof).
      brokerPhase="close-sources";
      try { if(job!=IntPtr.Zero) CloseSource(before.JobSlot); }
      finally { if(guard!=IntPtr.Zero) CloseSource(before.GuardSlot); }
      brokerPhase="rescan-objects";
      var after=ScanParentJobs(job,guard,deadline);
      if(after.JobCount!=0 || after.GuardCount!=0) throw Fail("nativeQueryFailure");
      var receipt=new Record{{"type","recovered"},{"action","recover"},{"jobId",jobId},{"commitGuardId",guardId},
        {"parentPid",pid},{"parentBirth",birth}};
      RecoveryEvidence(receipt,"job",job,before.JobCount,after.JobCount,jobActive,jobZero);
      RecoveryEvidence(receipt,"guard",guard,before.GuardCount,after.GuardCount,guardActive,guardZero);
      brokerPhase="send-terminal";
      BrokerSend(output,Json.Serialize(receipt),deadline);
    } finally { Close(guard); Close(job); }
  }
  public static int RunBroker() {
    IntPtr job=IntPtr.Zero, guard=IntPtr.Zero, output=IntPtr.Zero;
    bool canSendError=false;
    try {
      // libuv gives the detached broker synchronous byte pipes. Use the handles
      // directly: .NET console wrappers may substitute Stream.Null or silently
      // report success on a broken pipe, neither of which proves a frame write.
      var input=BrokerPipe(-10);
      output=BrokerPipe(-11);
      brokerPhase="read-spec";
      var one=new byte[1]; // No read-ahead across the spec/frame boundary.
      var data=(Record)Json.DeserializeObject(ReadSpec(()=>BrokerReadBytes(input,one)==0 ? -1 : one[0]));
      launchId=(string)data["launchId"]; secret=DecodeBase64((string)data["secret"]);
      string jobId=Guid.ParseExact((string)data["jobId"],"D").ToString("D");
      string guardId=Guid.ParseExact((string)data["commitGuardId"],"D").ToString("D");
      string action=(string)data["action"];
      bool pending=action=="recover";
      if(jobId==guardId || (!pending && action!="release" && action!="revoke")) throw Fail("protocolFailure");
      string binding=",\"jobId\":\""+jobId+"\",\"commitGuardId\":\""+guardId+"\"}";
      int pid=(int)data["parentPid"];
      string expectedBirth=(string)data["parentBirth"];
      // SYNCHRONIZE | DUP_HANDLE | (QUERY_INFORMATION for class 51; otherwise LIMITED_INFORMATION).
      brokerPhase="open-parent";
      if(secret.Length!=32 || pid<=0) throw Fail("protocolFailure");
      parent=OpenProcess(pending ? 0x00100440u : 0x00101040u,false,pid);
      if(parent==IntPtr.Zero) Check(false);
      brokerPhase="validate-parent";
      long birth, ignored;
      if(!ParentAlive()) throw Fail("parentUnavailable");
      uint heldPid=GetProcessId(parent);
      if(heldPid==0) Check(false);
      Check(GetProcessTimes(parent,out birth,out ignored,out ignored,out ignored));
      if(heldPid!=(uint)pid || birth.ToString(CultureInfo.InvariantCulture)!=expectedBirth)
        throw Fail("parentUnavailable");
      canSendError=true;
      brokerPhase="open-jobs";
      IntPtr source=IntPtr.Zero, guardSource=IntPtr.Zero;
      if(pending) {
        if(data.ContainsKey("jobHandle") || data.ContainsKey("commitGuardHandle")) throw Fail("protocolFailure");
      } else {
        source=RemoteHandle((string)data["jobHandle"]);
        guardSource=RemoteHandle((string)data["commitGuardHandle"]);
        if(source==guardSource || source==IntPtr.Zero || guardSource==IntPtr.Zero) throw Fail("protocolFailure");
        var self=GetCurrentProcess();
        Check(DuplicateHandle(parent,source,self,out job,0,false,2));
        Check(DuplicateHandle(parent,guardSource,self,out guard,0,false,2));
      }
      long setup=Clock.ElapsedMilliseconds+SetupMs;
      brokerPhase="send-ready";
      BrokerSend(output,"{\"type\":\"brokerReady\""+binding,setup);
      brokerPhase="read-grant";
      var grant=BrokerRead(input,setup);
      if(!Exact(grant,"type","action","jobId","commitGuardId") || !Object.Equals(grant["type"],"grant") ||
         !Object.Equals(grant["jobId"],jobId) || !Object.Equals(grant["commitGuardId"],guardId) ||
         !Object.Equals(grant["action"],action)) throw Fail("protocolFailure");
      long deadline=Clock.ElapsedMilliseconds+CleanupMs;
      if(pending) {
        RecoverPending(output,jobId,guardId,pid,expectedBirth,deadline);
        return 0;
      }
      if(action=="release") {
        ObserveCommit(input,output,binding,job,guard,deadline);
        // Past the decision, loss of the parent no longer revokes the provider.
        // Keep its original slots intact until it learns the decision and then
        // explicitly authorizes close. This is housekeeping, not another vote.
        brokerPhase="send-decision";
        BrokerSend(output,"{\"type\":\"phase\",\"phase\":\"commit-observed\",\"rootPid\":null,\"state\":\"clear\"}",deadline);
        brokerPhase="read-close";
        var close=BrokerRead(input,deadline);
        if(!Exact(close,"type","jobId","commitGuardId") || !Object.Equals(close["type"],"closeSources") ||
           !Object.Equals(close["jobId"],jobId) || !Object.Equals(close["commitGuardId"],guardId)) throw Fail("protocolFailure");
      } else if(action=="revoke") {
        brokerPhase="drain-jobs";
        DrainWithGuard(job,guard);
      } else throw Fail("protocolFailure");
      // Even if the first close fails, attempt the other original slot once.
      brokerPhase="close-sources";
      try { CloseSource(source); } finally { CloseSource(guardSource); }
      Close(guard); guard=IntPtr.Zero;
      Close(job); job=IntPtr.Zero;
      brokerPhase="send-terminal";
      BrokerSend(output,"{\"type\":\""+(action=="revoke"?"drained":"released")+"\""+binding,deadline);
      return 0;
    } catch(Exception e) {
      RememberBrokerFailure(e);
      ReportBrokerFailure();
      if(canSendError) {
        try { BrokerSend(output,"{\"type\":\"error\",\"code\":\""+(failure??"helperFailure")+"\"}",Clock.ElapsedMilliseconds+PollMs*5); }
        catch {}
      }
      return 125;
    } finally { Close(guard); Close(job); Close(parent); }
  }
}
`
