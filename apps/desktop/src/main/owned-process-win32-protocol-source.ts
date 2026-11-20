export const protocolSource = String.raw`
public static partial class HoliOwnedProcess {
  const int SetupMs=15000, CleanupMs=5000, PollMs=20, PartialMs=5000, FrameBytes=4096, TranscriptBytes=32768;
  static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
  static readonly Stopwatch Clock=Stopwatch.StartNew();
  static readonly byte[] readBuffer=new byte[FrameBytes], frameBuffer=new byte[FrameBytes];
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
  // Control messages are flat objects containing only strings, unsigned integers, and null.
  // JavaScriptSerializer alone also accepts unquoted/single-quoted names and duplicate keys.
  const string Space=@"[ \t\r\n]*", StringToken=@"""(?:[^""\\\x00-\x1f]|\\(?:[""\\/bfnrt]|u[0-9a-fA-F]{4}))*""";
  static readonly Regex Member=new Regex(@"\G"+Space+"("+StringToken+")"+Space+":"+Space+"("+StringToken+"|0|[1-9][0-9]*|null)"+Space+"([,}])");
  static readonly Regex EndObject=new Regex(@"\G"+Space+@"\z");
  static NamedPipeServerStream control;
  static IntPtr parent;
  static Task<int> pendingRead;
  static string launchId, failure;
  static byte[] secret;
  static int sendSeq, recvSeq, totalBytes, frameLength, readOffset, readLength;
  static long partialUntil;
  static Exception Fail(string code) {
    if(failure==null) failure=code;
    return new IOException(failure);
  }
  static bool ParentAlive() {
    if(WaitForSingleObject(parent,0)==WaitTimeout) return true;
    Fail("parentUnavailable");
    return false;
  }
  static void AwaitIo(Task task,long deadline) {
    while(true) {
      if(!ParentAlive()) throw Fail("parentUnavailable");
      long remaining=deadline-Clock.ElapsedMilliseconds;
      if(remaining<=0) throw Fail("controlFailure");
      if(task.IsCompleted) { task.GetAwaiter().GetResult(); return; }
      WaitForSingleObject(parent,(uint)Math.Min(remaining,PollMs));
    }
  }
  static void Account(int length) {
    if(length>TranscriptBytes-totalBytes) { totalBytes=TranscriptBytes; throw Fail("protocolFailure"); }
    totalBytes+=length;
  }
  static Record ParseObject(string text) {
    int at=0;
    while(at<text.Length && " \t\r\n".IndexOf(text[at])>=0) at++;
    if(at==text.Length || text[at++]!='{') throw Fail("protocolFailure");
    var record=new Record(StringComparer.Ordinal);
    while(true) {
      Match m=Member.Match(text,at);
      if(!m.Success) throw Fail("protocolFailure");
      string key=Json.Deserialize<string>(m.Groups[1].Value), value=m.Groups[2].Value;
      record.Add(key,value[0]=='"' ? (object)Json.Deserialize<string>(value) : value=="null" ? null : (object)UInt32.Parse(value,CultureInfo.InvariantCulture));
      at+=m.Length;
      if(m.Groups[3].Value=="}") {
        if(!EndObject.IsMatch(text,at)) throw Fail("protocolFailure");
        return record;
      }
    }
  }
  static bool Exact(Record d,params string[] keys) {
    if(d.Count!=keys.Length) return false;
    foreach(string k in keys) if(!d.ContainsKey(k)) return false;
    return true;
  }
  static byte[] DecodeBase64(string text) {
    byte[] bytes=Convert.FromBase64String(text);
    if(Convert.ToBase64String(bytes)!=text) throw Fail("protocolFailure");
    return bytes;
  }
  static byte[] Mac(string direction,int seq,string payload) {
    using(var h=new HMACSHA256(secret)) return h.ComputeHash(Utf8.GetBytes("1\n"+launchId+"\n"+direction+"\n"+seq.ToString(CultureInfo.InvariantCulture)+"\n"+payload));
  }
  static bool Fixed(byte[] a,byte[] b) {
    if(a.Length!=b.Length) return false;
    int d=0; for(int i=0;i<a.Length;i++) d|=a[i]^b[i]; return d==0;
  }
  static byte[] Encode(string json) {
    string payload=Convert.ToBase64String(Utf8.GetBytes(json));
    string frame=Json.Serialize(new Record{{"version",1},{"launchId",launchId},{"direction","helper"},{"seq",sendSeq},{"payloadBase64",payload},{"macBase64",Convert.ToBase64String(Mac("helper",sendSeq,payload))}})+"\n";
    byte[] bytes=Utf8.GetBytes(frame);
    if(bytes.Length>FrameBytes) throw Fail("protocolFailure");
    Account(bytes.Length);
    return bytes;
  }
  static void Send(string json,long deadline) {
    byte[] bytes=Encode(json);
    try {
      AwaitIo(Task.Factory.FromAsync(control.BeginWrite,control.EndWrite,bytes,0,bytes.Length,null),deadline);
      sendSeq++;
    } catch { throw Fail("controlFailure"); }
  }
  // One overlapped read is outstanding. The main thread alone applies complete commands,
  // including coalesced STOP/ACK frames, before deciding whether a terminal can be sent.
  static Record Decode() {
    try {
      var e=ParseObject(Utf8.GetString(frameBuffer,0,frameLength));
      frameLength=0;
      partialUntil=0;
      if(!Exact(e,"version","launchId","direction","seq","payloadBase64","macBase64") ||
         !Object.Equals(e["version"],1u) || !Object.Equals(e["seq"],(uint)recvSeq) ||
         (string)e["launchId"]!=launchId || (string)e["direction"]!="parent") throw Fail("protocolFailure");
      string payload=(string)e["payloadBase64"];
      if(!Fixed(DecodeBase64((string)e["macBase64"]),Mac("parent",recvSeq,payload))) throw Fail("protocolFailure");
      var message=ParseObject(Utf8.GetString(DecodeBase64(payload)));
      recvSeq++;
      return message;
    } catch { throw Fail("protocolFailure"); }
  }
  static Record ReadAvailable(long deadline=0,Stream input=null) {
    if(input==null) input=control;
    while(true) {
      if(partialUntil!=0 && Clock.ElapsedMilliseconds>=partialUntil) throw Fail("protocolFailure");
      if(readOffset==readLength) {
        try {
          if(pendingRead==null)
            pendingRead=Task<int>.Factory.FromAsync(input.BeginRead,input.EndRead,readBuffer,0,readBuffer.Length,null);
          if(deadline!=0) AwaitIo(pendingRead,partialUntil==0 ? deadline : Math.Min(deadline,partialUntil));
          if(!pendingRead.IsCompleted) return null;
          readLength=pendingRead.GetAwaiter().GetResult();
          pendingRead=null;
          readOffset=0;
        } catch { throw Fail("controlFailure"); }
        if(readLength==0) throw Fail(frameLength==0 ? "controlFailure" : "protocolFailure");
        Account(readLength);
      }
      byte b=readBuffer[readOffset++];
      if(b==10) return Decode();
      if(frameLength==0) partialUntil=Clock.ElapsedMilliseconds+PartialMs;
      if(frameLength==FrameBytes-1) throw Fail("protocolFailure");
      frameBuffer[frameLength++]=b;
    }
  }
  static void CommandBoundary(long deadline) {
    do {
      PollCommands();
      if(frameLength==0) return;
      if(Clock.ElapsedMilliseconds>=deadline) throw Fail("protocolFailure");
      Thread.Sleep(PollMs);
    } while(true);
  }
  static readonly string[] Signals={"SIGTERM","SIGKILL","SIGINT","SIGHUP","SIGQUIT"};
  static bool IsStopSignal(object value) {
    return value is string && Array.IndexOf(Signals,(string)value)>=0;
  }
  static string ReadRegistration(long deadline,string jobId,string jobHandle,string guardId,string guardHandle) {
    var m=ReadAvailable(deadline);
    if(!Exact(m,"type","jobId","jobHandle","commitGuardId","commitGuardHandle","stop") ||
       !Object.Equals(m["type"],"registered") || !Object.Equals(m["jobId"],jobId) ||
       !Object.Equals(m["jobHandle"],jobHandle) || !Object.Equals(m["commitGuardId"],guardId) ||
       !Object.Equals(m["commitGuardHandle"],guardHandle)) throw Fail("protocolFailure");
    object stop=m["stop"];
    if(stop!=null && !IsStopSignal(stop)) throw Fail("protocolFailure");
    return (string)stop;
  }
  static void PollCommands() {
    if(failure!=null) throw new IOException(failure);
    if(!ParentAlive()) throw new IOException(failure);
    Record m;
    while((m=ReadAvailable())!=null) {
      if(Exact(m,"type","signal") && Object.Equals(m["type"],"stop") && IsStopSignal(m["signal"]))
        stopRequested=true;
      else if(Exact(m,"type") && Object.Equals(m["type"],"acknowledge") && retained && ready && !acknowledged)
        acknowledged=true; // A racing STOP wins regardless of the wire order.
      else throw Fail("protocolFailure");
    }
  }
  static NamedPipeServerStream OpenControl(string name) {
    IntPtr descriptor;
    using(var user=WindowsIdentity.GetCurrent())
      Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;"+user.User.Value+")",1,out descriptor,IntPtr.Zero));
    try {
      var attrs=new SECURITY_ATTRIBUTES{nLength=Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),lpSecurityDescriptor=descriptor};
      // Windows PowerShell's .NET Framework has no PipeOptions.CurrentUserOnly.
      const uint Overlapped=0x40000000, FirstPipeInstance=0x80000, Duplex=3, RejectRemoteClients=8;
      var pipe=CreateNamedPipeW(@"\\.\pipe\"+name,Overlapped|FirstPipeInstance|Duplex,RejectRemoteClients,1,FrameBytes,FrameBytes,0,ref attrs);
      if(pipe.IsInvalid) {
        int error=Marshal.GetLastWin32Error();
        pipe.Dispose();
        throw new System.ComponentModel.Win32Exception(error);
      }
      try { return new NamedPipeServerStream(PipeDirection.InOut,true,false,pipe); }
      catch { pipe.Dispose(); throw; }
    } finally { LocalFree(descriptor); }
  }
  static void Authenticate(string name,int helperPid,int parentPid,long selfCreated,long parentCreated,long deadline) {
    control=OpenControl(name);
    try {
      AwaitIo(Task.Factory.FromAsync(control.BeginWaitForConnection,control.EndWaitForConnection,null),deadline);
      uint peerPid;
      Check(GetNamedPipeClientProcessId(control.SafePipeHandle,out peerPid));
      if(peerPid!=GetProcessId(parent) || peerPid!=(uint)parentPid) throw Fail("controlFailure");
    } catch { throw Fail("controlFailure"); }
    Send("{\"type\":\"hello\",\"helperPid\":"+helperPid+",\"parentPid\":"+parentPid+",\"birth\":\""+selfCreated.ToString(CultureInfo.InvariantCulture)+"\",\"parentBirth\":\""+parentCreated.ToString(CultureInfo.InvariantCulture)+"\"}",deadline);
    var auth=ReadAvailable(deadline);
    if(!Exact(auth,"type","helperPid","parentPid","mode") || !Object.Equals(auth["type"],"auth") ||
       !Object.Equals(auth["helperPid"],(uint)helperPid) || !Object.Equals(auth["parentPid"],(uint)parentPid) ||
       !Object.Equals(auth["mode"],retained ? "retained" : "ordinary")) throw Fail("protocolFailure");
    authenticated=true;
  }
  static string ReadSpec() {
    var input=Console.OpenStandardInput(); var b=new MemoryStream(); int v;
    while((v=input.ReadByte())!=-1 && v!=10) { if(b.Length>=1048576) throw new Exception("launch specification too large"); b.WriteByte((byte)v); }
    if(v==-1) throw new Exception("missing launch specification");
    return Utf8.GetString(b.ToArray()).TrimEnd('\r');
  }
  static void CloseControl() {
    if(control==null) return;
    try { CancelIoEx(control.SafePipeHandle,IntPtr.Zero); } finally { control.Dispose(); }
  }
}
`
