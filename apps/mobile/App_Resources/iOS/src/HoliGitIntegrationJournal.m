#import "HoliGitIntegrationJournal.h"
#import <sys/stat.h>
#import <sys/file.h>
#import <fcntl.h>
#import <unistd.h>
#import <errno.h>
#import <string.h>
#import <CoreFoundation/CoreFoundation.h>

static NSString *const HGIError = @"HoliGitIntegrationJournal";
static BOOL HGIFail(NSError **error, int code, NSString *message) {
  if (error) *error = [NSError errorWithDomain:HGIError code:code userInfo:@{NSLocalizedDescriptionKey:message}];
  return NO;
}
static BOOL HGIString(id s) { return [s isKindOfClass:NSString.class] && [s length] > 0 && [s length] <= 4096 && ![s containsString:@"\0"]; }
static BOOL HGIUUID(id s) { return HGIString(s) && [s length] == 36 && [[NSUUID alloc] initWithUUIDString:s] != nil; }
static BOOL HGIName(NSString *s) { return HGIString(s) && ![s isEqual:@"."] && ![s isEqual:@".."] && [s rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"] invertedSet]].location == NSNotFound; }
static BOOL HGISame(struct stat a, struct stat b) { return a.st_dev == b.st_dev && a.st_ino == b.st_ino && (a.st_mode & S_IFMT) == (b.st_mode & S_IFMT); }
static BOOL HGIWriteAll(int fd, NSData *data) { const uint8_t *p=data.bytes; size_t n=data.length; while(n){ssize_t k=write(fd,p,n); if(k<0&&errno==EINTR)continue; if(k<=0)return NO; p+=k;n-=k;} return fsync(fd)==0; }

@interface HoliGitIntegrationJournal ()
@property(nonatomic) int directoryFD;
@property(nonatomic) int leaseFD;
@property(nonatomic) NSString *transactionPath;
@property(nonatomic) NSString *uuid;
@property(nonatomic) NSDictionary *manifest;
@end
@implementation HoliGitIntegrationJournal
- (void)close { if (_leaseFD >= 0) { flock(_leaseFD, LOCK_UN); close(_leaseFD); _leaseFD=-1; } if (_directoryFD>=0) { close(_directoryFD); _directoryFD=-1; } }
- (void)dealloc { [self close]; }
- (BOOL)loadManifest:(NSError **)error {
  int fd=openat(_directoryFD,"manifest.json",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
  if(fd<0)return HGIFail(error,errno,@"Manifest unavailable"); struct stat a,b;
  BOOL ok=fstat(fd,&a)==0&&S_ISREG(a.st_mode)&&a.st_nlink==1&&a.st_size>=2&&a.st_size<=65536;
  NSMutableData *d=[NSMutableData data]; uint8_t buf[4096];
  while(ok){ssize_t n=read(fd,buf,sizeof(buf));if(n<0&&errno==EINTR)continue;if(n<0){ok=NO;break;}if(!n)break;if(d.length+(NSUInteger)n>65536){ok=NO;break;}[d appendBytes:buf length:n];}
  ok=ok&&fstat(fd,&b)==0&&HGISame(a,b)&&d.length==(NSUInteger)a.st_size; close(fd);
  NSDictionary *m=ok?[NSJSONSerialization JSONObjectWithData:d options:0 error:nil]:nil;
  if(![m isKindOfClass:NSDictionary.class]||![m[@"version"] isEqual:@1]||!HGIUUID(m[@"uuid"])||![m[@"uuid"] isEqual:_uuid]||!HGIString(m[@"root"])||!HGIString(m[@"remote"])||!HGIString(m[@"branch"])||!HGIString(m[@"gitDev"])||!HGIString(m[@"gitIno"])||![m[@"artifacts"] isKindOfClass:NSArray.class]||![m[@"plan"] isKindOfClass:NSDictionary.class])return HGIFail(error,EINVAL,@"Invalid journal manifest");
  for(id n in m[@"artifacts"])if(!HGIName(n))return HGIFail(error,EINVAL,@"Invalid artifact ownership");
  _manifest=m; return YES;
}
- (instancetype)initPath:(NSString *)path error:(NSError **)error {
  if(!HGIString(path)||![path isAbsolutePath]||![path isEqual:path.stringByStandardizingPath]){HGIFail(error,EINVAL,@"Invalid transaction path");return nil;}
  int dir=open(path.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); if(dir<0){HGIFail(error,errno,@"Cannot open transaction");return nil;}
  struct stat ds; if(fstat(dir,&ds)||ds.st_nlink<1){close(dir);HGIFail(error,EINVAL,@"Invalid transaction directory");return nil;}
  int lease=openat(dir,"lease",O_RDWR|O_NOFOLLOW|O_CLOEXEC); struct stat ls;
  if(lease<0||fstat(lease,&ls)||!S_ISREG(ls.st_mode)||ls.st_nlink!=1||flock(lease,LOCK_EX|LOCK_NB)){if(lease>=0)close(lease);close(dir);HGIFail(error,EBUSY,@"Journal lease unavailable");return nil;}
  self=[super init]; if(self){_directoryFD=dir;_leaseFD=lease;_transactionPath=path;_uuid=path.lastPathComponent; if(![self loadManifest:error]){[self close];return nil;}} else {close(dir);close(lease);} return self;
}
- (instancetype)init { self=[super init]; if(self){_directoryFD=-1;_leaseFD=-1;}return self; }
- (instancetype)createAtRoot:(NSString *)root remote:(NSString *)remote branch:(NSString *)branch nativeId:(NSString *)nativeId plan:(NSData *)plan error:(NSError **)error {
  char resolved[PATH_MAX]; if(!HGIString(root)||!realpath(root.fileSystemRepresentation,resolved)||!HGIString(remote)||!HGIString(branch)|| (nativeId&&!HGIUUID(nativeId))||plan.length>32768){HGIFail(error,EINVAL,@"Invalid integration identity or plan");return nil;}
  NSDictionary *p=[NSJSONSerialization JSONObjectWithData:plan options:0 error:error]; if(![p isKindOfClass:NSDictionary.class]){HGIFail(error,EINVAL,@"Plan must be a JSON object");return nil;}
  NSString *r=[NSString stringWithUTF8String:resolved],*git=[r stringByAppendingPathComponent:@".git"]; struct stat rs,gs;
  if(stat(r.fileSystemRepresentation,&rs)||lstat(git.fileSystemRepresentation,&gs)||!S_ISDIR(gs.st_mode)){HGIFail(error,errno?:EINVAL,@"Invalid root or git directory");return nil;}
  NSString *base=[git stringByAppendingPathComponent:@"holi-integration"]; if(mkdir(base.fileSystemRepresentation,0700)&&errno!=EEXIST){HGIFail(error,errno,@"Cannot create journal directory");return nil;}
  int bfd=open(base.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); if(bfd<0){HGIFail(error,errno,@"Unsafe journal directory");return nil;}
  NSString *uuid=NSUUID.UUID.UUIDString.lowercaseString,*name=[@"txn-" stringByAppendingString:uuid],*path=[base stringByAppendingPathComponent:name];
  if(mkdirat(bfd,name.fileSystemRepresentation,0700)){close(bfd);HGIFail(error,errno,@"Cannot reserve transaction");return nil;}
  int d=openat(bfd,name.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); close(bfd); if(d<0){HGIFail(error,errno,@"Cannot open transaction");return nil;}
  int l=openat(d,"lease",O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600); if(l<0||flock(l,LOCK_EX|LOCK_NB)){if(l>=0)close(l);close(d);HGIFail(error,errno,@"Cannot own transaction lease");return nil;}
  NSMutableDictionary *m=[@{@"version":@1,@"uuid":uuid,@"root":r,@"gitDev":[NSString stringWithFormat:@"%llu",(unsigned long long)gs.st_dev],@"gitIno":[NSString stringWithFormat:@"%llu",(unsigned long long)gs.st_ino],@"remote":remote,@"branch":branch,@"artifacts":@[],@"plan":p} mutableCopy]; if(nativeId)m[@"nativeId"]=nativeId;
  NSData *bytes=[NSJSONSerialization dataWithJSONObject:m options:NSJSONWritingSortedKeys error:error]; int f=openat(d,"manifest.json",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600); BOOL ok=f>=0&&HGIWriteAll(f,bytes); if(f>=0)close(f); ok=ok&&fsync(d)==0;
  close(l);close(d); if(!ok){HGIFail(error,errno?:EIO,@"Cannot durably create manifest");return nil;} return [self initPath:path error:error];
}
- (instancetype)openAtPath:(NSString *)path error:(NSError **)error { return [self initPath:path error:error]; }
- (NSDictionary *)readState:(NSError **)error { return [self loadManifest:error]?_manifest:nil; }
- (BOOL)publish:(NSDictionary *)manifest error:(NSError **)error {
  NSData *bytes=[NSJSONSerialization dataWithJSONObject:manifest options:NSJSONWritingSortedKeys error:error];
  if(!bytes||bytes.length>65536)return HGIFail(error,EFBIG,@"Journal state exceeds bound");
  NSString *tmp=[@".journal-" stringByAppendingString:NSUUID.UUID.UUIDString.lowercaseString];
  int fd=openat(_directoryFD,tmp.fileSystemRepresentation,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if(fd<0)return HGIFail(error,errno,@"Cannot reserve journal publication");
  BOOL ok=HGIWriteAll(fd,bytes); int saved=errno; if(close(fd)&&ok){ok=NO;saved=errno;}
  if(ok)ok=renameat(_directoryFD,tmp.fileSystemRepresentation,_directoryFD,"manifest.json")==0;
  if(ok)ok=fsync(_directoryFD)==0; if(!ok)return HGIFail(error,saved?:errno?:EIO,@"Journal publication failed; evidence retained");
  _manifest=manifest; return YES;
}
- (BOOL)replaceState:(NSDictionary *)state error:(NSError **)error {
  if(![state isKindOfClass:NSDictionary.class]||![state[@"uuid"] isEqual:_uuid]||![state[@"version"] isEqual:@1]||![state[@"root"] isEqual:_manifest[@"root"]]||![state[@"gitDev"] isEqual:_manifest[@"gitDev"]]||![state[@"gitIno"] isEqual:_manifest[@"gitIno"]]||![state[@"remote"] isEqual:_manifest[@"remote"]]||![state[@"branch"] isEqual:_manifest[@"branch"]]||![state[@"artifacts"] isEqual:_manifest[@"artifacts"]]||![state[@"plan"] isEqual:_manifest[@"plan"]])return HGIFail(error,EINVAL,@"State ownership mismatch");
  return [self publish:state error:error];
}
- (BOOL)writeArtifact:(NSData *)data named:(NSString *)name error:(NSError **)error {
  if(!HGIName(name)||[name isEqual:@"manifest.json"]||[name isEqual:@"lease"]||[_manifest[@"artifacts"] containsObject:name]||data.length>16*1024*1024)return HGIFail(error,EINVAL,@"Invalid artifact");
  int f=openat(_directoryFD,name.fileSystemRepresentation,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600); if(f<0)return HGIFail(error,errno,@"Artifact already exists or is unsafe");
  struct stat created; BOOL ok=fstat(f,&created)==0&&S_ISREG(created.st_mode)&&created.st_nlink==1&&HGIWriteAll(f,data); int saved=errno; if(close(f)&&ok){ok=NO;saved=errno;}
  if(!ok)return HGIFail(error,saved?:EIO,@"Artifact durability failed; evidence retained");
  NSMutableDictionary *m=[_manifest mutableCopy]; m[@"artifacts"]=[_manifest[@"artifacts"] arrayByAddingObject:name]; return [self publish:m error:error];
}
- (BOOL)cleanupRecordedArtifacts:(NSError **)error {
  for(NSString *name in _manifest[@"artifacts"]){struct stat s;if(fstatat(_directoryFD,name.fileSystemRepresentation,&s,AT_SYMLINK_NOFOLLOW)||!S_ISREG(s.st_mode)||s.st_nlink!=1)return HGIFail(error,EPERM,@"Recorded artifact changed; evidence retained");}
  for(NSString *name in _manifest[@"artifacts"])if(unlinkat(_directoryFD,name.fileSystemRepresentation,0))return HGIFail(error,errno,@"Artifact cleanup incomplete");
  if(fsync(_directoryFD))return HGIFail(error,errno,@"Artifact cleanup not durable");
  NSMutableDictionary *m=[_manifest mutableCopy];m[@"artifacts"]=@[];return [self publish:m error:error];
}
@end
