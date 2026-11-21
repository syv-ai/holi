export const producerSource = String.raw`
public static partial class HoliOwnedProcess {
  static bool authenticated, retained, ready, acknowledged, stopRequested;
  static string testFault;

  static string Arg(string s) {
    if (s.Length > 0 && s.IndexOfAny(new char[]{' ', '\t', '\n', '\v', '"'}) < 0) return s;
    var b = new StringBuilder("\""); int slashes=0;
    foreach (char c in s) { if (c=='\\') { slashes++; continue; } if(c=='"') { b.Append('\\', slashes*2+1).Append('"'); slashes=0; } else { b.Append('\\',slashes).Append(c); slashes=0; } }
    b.Append('\\',slashes*2).Append('"'); return b.ToString();
  }
  static void Trace(string phase, uint rootPid=0, string state="-",bool essential=false) {
    // Optional diagnostics are authenticated, bounded, and never use provider stderr.
    if(!authenticated || (!essential && !tracing)) return;
    Send(Json.Serialize(new Record{{"type","phase"},{"phase",phase},{"rootPid",rootPid>0?(object)rootPid:null},{"state",state}}),Clock.ElapsedMilliseconds+PollMs*5);
  }
  static bool tracing;
  static void CloseRelay(AnonymousPipeServerStream pipe) {
    if(pipe==null) return;
    try { pipe.DisposeLocalCopyOfClientHandle(); } finally { pipe.Dispose(); }
  }
  static void WriteOutput(Stream output,string text) {
    byte[] bytes=Utf8.GetBytes(text);
    output.Write(bytes,0,bytes.Length);
    output.Flush();
  }
  static Thread Background(ThreadStart run) {
    var thread=new Thread(run); thread.IsBackground=true; thread.Start(); return thread;
  }
  static void ReportCreateProcessFailure(int error) {
    // Command output only. The control transcript and native cleanup have
    // already closed; give the background writer a short delivery window,
    // but don't hold up helper exit for a broken or backpressured stderr.
    try {
      Background(()=>{
        try {
          string message=new System.ComponentModel.Win32Exception(error).Message;
          message=Regex.Replace(message,@"[\p{Cc}\p{Zl}\p{Zp}]+"," ").Trim();
          if(message.Length>256) message=message.Substring(0,char.IsHighSurrogate(message[255])?255:256);
          WriteOutput(Console.OpenStandardError(),"CreateProcess failed (Win32 error "+error.ToString(CultureInfo.InvariantCulture)+"): "+message+"\n");
        } catch {}
      }).Join(500);
    } catch {}
  }
  static uint RootExitCode(IntPtr root,long deadline) {
    // The held root must be signalled first: 259 can be an actual exit code, not STILL_ACTIVE.
    while(true) {
      uint wait=WaitForSingleObject(root,0);
      if(wait==0) break;
      if(wait!=WaitTimeout || Clock.ElapsedMilliseconds>=deadline) throw Fail("helperFailure");
      PollCommands();
      Thread.Sleep(PollMs);
    }
    uint code; Check(GetExitCodeProcess(root,out code)); return code;
  }
  static uint PublishRootExit(PROCESS_INFORMATION pi,long deadline) {
    uint code=RootExitCode(pi.hProcess,deadline);
    Send(Json.Serialize(new Record{{"type","root-exit"},{"rootPid",pi.dwProcessId},{"rootExitCode",code}}),deadline);
    return code;
  }
  static void PublishEmpty(uint result,string reason,bool outputFailed,uint? rootPid,uint? rootExit,long deadline) {
    Send(Json.Serialize(new Record{{"type","empty"},{"exitCode",result},{"reason",reason},
      {"outputFailed",outputFailed},{"rootPid",rootPid},{"rootExitCode",rootExit}}),deadline);
  }
  static bool TryHandoff(IntPtr job,IntPtr launchGuard,uint rootPid,
    Thread output,Thread error,string outputMarker,string errorMarker,Func<Exception> relayError,Action<Exception> reportRelayError,ref bool detachAuthorized) {
    // Relays (including marker writes) are background only. Blocked stdout/stderr
    // never prevent the main thread from seeing parent death or a STOP.
    while(output.IsAlive || error.IsAlive) {
      PollCommands();
      if(stopRequested) return false;
      if(relayError()!=null) return false;
      Thread.Sleep(PollMs);
    }
    var markers=Background(()=>{
      // Publish markers only once both streams drained successfully.
      if(relayError()!=null) return;
      try {
        WriteOutput(Console.OpenStandardOutput(),outputMarker);
        WriteOutput(Console.OpenStandardError(),errorMarker);
      } catch(Exception e) { reportRelayError(e); }
    });
    while(markers.IsAlive) {
      PollCommands();
      if(stopRequested) { reportRelayError(new IOException("relay marker abandoned on stop")); return false; }
      Thread.Sleep(PollMs);
    }
    if(relayError()!=null) return false;
    Console.SetOut(TextWriter.Null); Console.SetError(TextWriter.Null);
    CommandBoundary(Clock.ElapsedMilliseconds+PartialMs);
    if(stopRequested) return false;
    Send("{\"type\":\"ready\"}",Clock.ElapsedMilliseconds+CleanupMs);
    ready=true;
    while(!acknowledged && !stopRequested) { PollCommands(); Thread.Sleep(PollMs); }
    CommandBoundary(Clock.ElapsedMilliseconds+PartialMs);
    if(stopRequested) return false;
    long deadline=Clock.ElapsedMilliseconds+CleanupMs;
    // Keep the sole-handle launch guard armed until the primary is cleared. The
    // separate commit guard is untouched: HANDOFF escrows, it does not commit.
    InjectHelperDeath("before-clear");
    SetKillOnClose(job,false);
    CommandBoundary(deadline);
    if(stopRequested) return false;
    SetKillOnClose(launchGuard,false);
    detachAuthorized=true;
    InjectHelperDeath("after-clear");
    CommandBoundary(deadline);
    if(stopRequested) { detachAuthorized=false; return false; }
    Send("{\"type\":\"handoff\",\"exitCode\":0,\"rootExitCode\":0,\"rootPid\":"+rootPid+"}",deadline);
    return true;
  }
  static void InjectHelperDeath(string point) {
    if(testFault!=point) return;
    // Fixture-only hard exit: bypass finally and rely on the actual kernel handle rules.
    Check(TerminateProcess(GetCurrentProcess(),125));
    throw Fail("helperFailure");
  }
  public static int Run() {
    IntPtr job=IntPtr.Zero, launchGuard=IntPtr.Zero, commitGuard=IntPtr.Zero, env=IntPtr.Zero, attrList=IntPtr.Zero, handleList=IntPtr.Zero, jobList=IntPtr.Zero;
    IntPtr stdin=IntPtr.Zero, stdout=IntPtr.Zero, stderr=IntPtr.Zero;
    PROCESS_INFORMATION pi=new PROCESS_INFORMATION();
    bool attrInitialized=false, detachAuthorized=false, emptyProven=false, launchFailed=false;
    int? createError=null;
    int createProcessCalls=0; // Read only by the private registration audit.
    AnonymousPipeServerStream outputPipe=null, errorPipe=null;
    Thread outputRelay=null, errorRelay=null;
    Exception relayFailure=null;
    try {
      var data=(Record)Json.DeserializeObject(ReadSpec());
      launchId=(string)data["launchId"]; secret=DecodeBase64((string)data["secret"]);
      if(data.ContainsKey("testFault")) testFault=(string)data["testFault"];
      if(secret.Length!=32) throw new Exception("invalid launch credential");
      retained=data.ContainsKey("retainDescendantsOnSuccess") && Convert.ToBoolean(data["retainDescendantsOnSuccess"]);
      bool retain=retained;
      tracing=data.ContainsKey("traceEnabled") && Convert.ToBoolean(data["traceEnabled"]);
      string outputMarker=(string)data["stdoutMarker"], errorMarker=(string)data["stderrMarker"];
      int parentPid=(int)data["parentPid"];
      if(parentPid<=0) throw Fail("parentUnavailable");
      parent=OpenProcess(0x00101000 | (retain ? 0x40u : 0), false, parentPid);
      if(parent==IntPtr.Zero || !ParentAlive()) throw Fail("parentUnavailable");
      long parentCreated, selfCreated, ignored;
      Check(GetProcessTimes(parent,out parentCreated,out ignored,out ignored,out ignored));
      using(var self=Process.GetCurrentProcess()) Check(GetProcessTimes(self.Handle,out selfCreated,out ignored,out ignored,out ignored));
      if(parentCreated>selfCreated) throw Fail("parentUnavailable");
      long setupDeadline=Clock.ElapsedMilliseconds+SetupMs;
      if(data.ContainsKey("testParentReady")) {
        // Raw fixture barrier before connecting; never emitted for a provider launch.
        byte[] opened=Utf8.GetBytes("test-parent-handle-held\n");
        AwaitIo(Task.Run(()=>Console.OpenStandardOutput().Write(opened,0,opened.Length)),setupDeadline);
      }

      string jobId=retain ? Guid.ParseExact((string)data["jobId"],"D").ToString("D") : Guid.NewGuid().ToString("D");
      string commitGuardId=retain ? Guid.ParseExact((string)data["commitGuardId"],"D").ToString("D") : null;
      if(jobId==commitGuardId) throw Fail("protocolFailure");
      job=NewJob(retain ? JobName(jobId) : null);
      if(retain) {
        launchGuard=NewJob();
        commitGuard=NewJob(JobName(commitGuardId));
      }
      // HELLO vouches that both prepared names are fresh and binds the held parent epoch.
      using(var self=Process.GetCurrentProcess()) Authenticate((string)data["controlPipe"],self.Id,parentPid,selfCreated,parentCreated,setupDeadline);
      string registeredHandle=null, registeredGuard=null;
      if(retain) {
        IntPtr parentJob, parentGuard;
        // Ownership of a remote slot starts at duplication, not REGISTERED. Even
        // on partial failure, only the parent lease may consume a remote copy.
        InjectHelperDeath("before-first-dup");
        Check(DuplicateHandle(GetCurrentProcess(),job,parent,out parentJob,0,false,2));
        InjectHelperDeath("after-first-dup");
        Check(DuplicateHandle(GetCurrentProcess(),commitGuard,parent,out parentGuard,0,false,2));
        InjectHelperDeath("after-both-dups");
        registeredHandle=RemoteHandleToken(parentJob);
        registeredGuard=RemoteHandleToken(parentGuard);
      }
      Send(Json.Serialize(new Record{{"type","setup"},{"mode",retain?"retained":"ordinary"},
        {"parentBirth",parentCreated.ToString(CultureInfo.InvariantCulture)},{"jobId",jobId},
        {"jobHandle",registeredHandle},{"commitGuardId",commitGuardId},{"commitGuardHandle",registeredGuard}}),setupDeadline);
      string registrationStop=ReadRegistration(setupDeadline,jobId,registeredHandle,commitGuardId,registeredGuard);
      IntPtr queryHandle=testFault=="query"?new IntPtr(-1):job;
      if(registrationStop!=null) {
        // This is a decision not to admit a Root, not a request to drain one.
        // Still require a successful native query before certifying EMPTY.
        long deadline=Clock.ElapsedMilliseconds+CleanupMs;
        uint active=ActiveProcesses(queryHandle);
        if(active!=0) throw Fail("nativeQueryFailure");
        emptyProven=true;
        CommandBoundary(deadline);
        if(testFault=="registration-stop-audit")
          Trace("registration-stopped",0,"create-calls="+createProcessCalls+".active="+active+".stop="+registrationStop,true);
        PublishEmpty(1,"stopped",false,null,null,deadline);
        return 1;
      }
      Trace("before-suspended-root-creation");
      PollCommands();
      string bin=(string)data["bin"]; var argv=(object[])data["args"];
      bool verbatim=data.ContainsKey("verbatim") && Convert.ToBoolean(data["verbatim"]);
      var cmd=new StringBuilder(Arg(bin));
      foreach(object a in argv) cmd.Append(' ').Append(verbatim?Convert.ToString(a):Arg(Convert.ToString(a)));
      var si=new STARTUPINFOEX();
      si.StartupInfo.cb=Marshal.SizeOf(typeof(STARTUPINFOEX));
      si.StartupInfo.dwFlags=0x100; // STARTF_USESTDHANDLES
      if(retain) {
        outputPipe=new AnonymousPipeServerStream(PipeDirection.In,HandleInheritability.Inheritable);
        errorPipe=new AnonymousPipeServerStream(PipeDirection.In,HandleInheritability.Inheritable);
      }
      stdin=InheritableCopy(GetStdHandle(-10));
      stdout=InheritableCopy(retain ? outputPipe.ClientSafePipeHandle.DangerousGetHandle() : GetStdHandle(-11));
      stderr=InheritableCopy(retain ? errorPipe.ClientSafePipeHandle.DangerousGetHandle() : GetStdHandle(-12));
      si.StartupInfo.hStdInput=stdin; si.StartupInfo.hStdOutput=stdout; si.StartupInfo.hStdError=stderr;
      // Handle inheritance is exactly the three standard streams. The separate JOB_LIST
      // assigns ownership at creation, even if the helper is killed before it can resume the root.
      IntPtr attrSize=IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref attrSize);
      attrList=Marshal.AllocHGlobal(attrSize);
      Check(InitializeProcThreadAttributeList(attrList,2,0,ref attrSize)); attrInitialized=true;
      handleList=Marshal.AllocHGlobal(IntPtr.Size*3);
      Marshal.WriteIntPtr(handleList,0,stdin);
      Marshal.WriteIntPtr(handleList,IntPtr.Size,stdout);
      Marshal.WriteIntPtr(handleList,IntPtr.Size*2,stderr);
      Check(UpdateProcThreadAttribute(attrList,0,(IntPtr)HandleListAttribute,handleList,(IntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
      int jobs=retain?3:1;
      jobList=Marshal.AllocHGlobal(IntPtr.Size*jobs);
      if(retain) {
        Marshal.WriteIntPtr(jobList,launchGuard);
        Marshal.WriteIntPtr(jobList,IntPtr.Size,commitGuard);
      }
      Marshal.WriteIntPtr(jobList,IntPtr.Size*(jobs-1),job);
      Check(UpdateProcThreadAttribute(attrList,0,(IntPtr)JobListAttribute,jobList,(IntPtr)(IntPtr.Size*jobs),IntPtr.Zero,IntPtr.Zero));
      si.lpAttributeList=attrList;
      var vars=data["env"] as System.Collections.Generic.Dictionary<string,object>;
      if(vars!=null) { var eb=new StringBuilder(); var keys=new System.Collections.Generic.List<string>(vars.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase); foreach(string key in keys) if(vars[key]!=null) eb.Append(key).Append('=').Append(Convert.ToString(vars[key])).Append('\0'); eb.Append('\0'); env=Marshal.StringToHGlobalUni(eb.ToString()); }
      PollCommands();
      if(!stopRequested) {
        const uint CreateFlags=0x4|0x400|0x08000000|ExtendedStartupInfoPresent; // suspended, Unicode env, no window, extended startup info
        createProcessCalls++;
        launchFailed=!CreateProcess(bin,cmd,IntPtr.Zero,IntPtr.Zero,true,CreateFlags,env,(string)data["cwd"],ref si,out pi);
        if(launchFailed) {
          createError=Marshal.GetLastWin32Error(); // Capture before any handle or control work.
          pi=new PROCESS_INFORMATION();
        } else Send(Json.Serialize(new Record{{"type","root-created"},{"rootPid",pi.dwProcessId}}),Clock.ElapsedMilliseconds+PollMs*5);
        Close(stdin); stdin=IntPtr.Zero;
        Close(stdout); stdout=IntPtr.Zero;
        Close(stderr); stderr=IntPtr.Zero;
        if(retain && !launchFailed) {
          outputPipe.DisposeLocalCopyOfClientHandle(); errorPipe.DisposeLocalCopyOfClientHandle();
          outputRelay=Background(()=>{try { var target=Console.OpenStandardOutput(); outputPipe.CopyTo(target); target.Flush(); } catch(Exception e) { Interlocked.CompareExchange(ref relayFailure,e,null); }});
          errorRelay=Background(()=>{try { var target=Console.OpenStandardError(); errorPipe.CopyTo(target); target.Flush(); } catch(Exception e) { Interlocked.CompareExchange(ref relayFailure,e,null); }});
        }
        Free(env); env=IntPtr.Zero;
        PollCommands();
        if(!stopRequested && !launchFailed) {
          Trace("before-root-resume",pi.dwProcessId);
          if(ResumeThread(pi.hThread)==0xffffffff) Check(false);
          Trace("after-root-resume",pi.dwProcessId,"running",true);
        }
      }
      while(!stopRequested && !launchFailed) {
        PollCommands();
        if(stopRequested) break;
        uint wait=WaitForSingleObject(pi.hProcess,PollMs);
        if(wait==0) break;
        if(wait!=WaitTimeout) Check(false);
      }
      uint? rootExit=null;
      if(!stopRequested && !launchFailed) {
        long exitDeadline=Clock.ElapsedMilliseconds+CleanupMs;
        rootExit=PublishRootExit(pi,exitDeadline);
        if(rootExit==0 && retain && TryHandoff(job,launchGuard,pi.dwProcessId,
           outputRelay,errorRelay,outputMarker,errorMarker,()=>Volatile.Read(ref relayFailure),e=>Interlocked.CompareExchange(ref relayFailure,e,null),ref detachAuthorized)) {
          return 0;
        }
      }
      long drainDeadline=Clock.ElapsedMilliseconds+CleanupMs;
      DrainJob(job,queryHandle,drainDeadline);
      emptyProven=true;
      if(pi.hProcess!=IntPtr.Zero && !rootExit.HasValue) rootExit=PublishRootExit(pi,drainDeadline);
      uint code=rootExit.GetValueOrDefault();
      // Relay settlement is output, not ownership. Leave enough of the cleanup
      // budget to publish zero even if a provider stream never settles.
      long relayDeadline=Math.Min(drainDeadline-PollMs*5,Clock.ElapsedMilliseconds+1000);
      while(outputRelay!=null && (outputRelay.IsAlive || errorRelay.IsAlive) && Clock.ElapsedMilliseconds<relayDeadline) {
        PollCommands(); Thread.Sleep(PollMs);
      }
      bool outputFailed=Volatile.Read(ref relayFailure)!=null || (outputRelay!=null && (outputRelay.IsAlive || errorRelay.IsAlive));
      CommandBoundary(drainDeadline);
      uint result=stopRequested ? 1u : launchFailed ? 125u : code;
      string reason=stopRequested ? "stopped" : launchFailed ? "launch-failed" : "natural";
      PublishEmpty(result,reason,outputFailed,pi.hProcess==IntPtr.Zero?(uint?)null:pi.dwProcessId,rootExit,drainDeadline);
      return unchecked((int)result);
    } catch {
      if(failure==null) failure="helperFailure";
      // Before handoff, kill-on-close covers hard helper death. After the launch
      // guard clears, the parent still holds the armed commit guard and primary Job.
      if(job!=IntPtr.Zero && (!detachAuthorized || stopRequested) && !emptyProven) TerminateJobObject(job,1);
      Close(launchGuard); launchGuard=IntPtr.Zero;
      Close(job); job=IntPtr.Zero;
      try {
        if(authenticated && control.IsConnected)
          Send("{\"type\":\"error\",\"code\":\""+failure+"\"}",Clock.ElapsedMilliseconds+PollMs*5);
      } catch {}
      return 125;
    } finally {
      if(job!=IntPtr.Zero && (!detachAuthorized || stopRequested) && !emptyProven) TerminateJobObject(job,1);
      Close(launchGuard);
      Close(commitGuard);
      Close(job);
      try { CloseControl(); } catch {}
      try { CloseRelay(outputPipe); } catch {}
      try { CloseRelay(errorPipe); } catch {}
      Close(stdin); Close(stdout); Close(stderr);
      Close(pi.hThread); Close(pi.hProcess); Close(parent);
      if(attrInitialized) DeleteProcThreadAttributeList(attrList);
      Free(attrList); Free(handleList); Free(jobList); Free(env);
      if(createError.HasValue) ReportCreateProcessFailure(createError.Value);
    }
  }
}
`
