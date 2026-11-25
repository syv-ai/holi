#import "HoliManagedAcquisition.h"
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>
#import <dirent.h>
#import <stdio.h>
#import <errno.h>
#import <uuid/uuid.h>
#import <stdio.h>
#import <string.h>

static NSString *const HMAErrorDomain = @"HoliManagedAcquisitionErrorDomain";
static NSError *HMAError(int code, NSString *message) { return [NSError errorWithDomain:HMAErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey: message}]; }
static BOOL HMAWrite(int fd, NSData *data) { const uint8_t *p=data.bytes; size_t n=data.length; while(n){ ssize_t k=write(fd,p,n); if(k<0&&errno==EINTR)continue; if(k<=0)return NO; p+=k;n-=k;} return fsync(fd)==0; }
static NSString *HMAUUID(void) { uuid_t u; uuid_generate(u); char s[37]; uuid_unparse_lower(u,s); return [NSString stringWithUTF8String:s]; }
@implementation HoliManagedAcquisition
- (NSDictionary *)beginAtTarget:(NSString *)target nativeId:(NSString *)nativeId remote:(NSString *)remote branch:(NSString *)branch runId:(NSString *)runId error:(NSError **)error {
  NSString *absolute=target.stringByStandardizingPath; NSString *parent=absolute.stringByDeletingLastPathComponent; NSString *leaf=absolute.lastPathComponent;
  char resolved[PATH_MAX]; if(!realpath(parent.fileSystemRepresentation,resolved)){ if(error)*error=HMAError(errno,@"Target parent must exist and be canonicalizable"); return nil; }
  NSString *canonicalParent=[NSString stringWithUTF8String:resolved]; NSString *canonicalTarget=[canonicalParent stringByAppendingPathComponent:leaf];
  struct stat st; if(lstat(canonicalTarget.fileSystemRepresentation,&st)==0){ if(error)*error=HMAError(EEXIST,@"Target already exists; reopen only through matching managed identity"); return nil; } if(errno!=ENOENT){if(error)*error=HMAError(errno,@"Cannot inspect target");return nil;}
  NSString *uid=HMAUUID(), *stage=[canonicalParent stringByAppendingPathComponent:[NSString stringWithFormat:@".holi-acquire-%@",uid]];
  if(mkdir(stage.fileSystemRepresentation,0700)){if(error)*error=HMAError(errno,@"Cannot create private stage");return nil;}
  int d=open(stage.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW); int f=d<0?-1:openat(d,".holi-acquisition.json",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);
  NSDictionary *manifest=@{@"uuid":uid,@"nativeId":nativeId,@"target":canonicalTarget,@"rootKey":canonicalTarget,@"remote":remote,@"branch":branch,@"runId":runId,@"phase":@"prepared"};
  NSData *bytes=[NSJSONSerialization dataWithJSONObject:manifest options:NSJSONWritingSortedKeys error:nil]; BOOL ok=f>=0&&HMAWrite(f,bytes)&&fsync(d)==0&&fsync(open(canonicalParent.fileSystemRepresentation,O_RDONLY|O_DIRECTORY))==0;
  if(f>=0)close(f);if(d>=0)close(d); if(!ok){if(error)*error=HMAError(errno?:EIO,@"Cannot durably record owned stage");return nil;}
  return @{@"stagePath":stage,@"targetPath":canonicalTarget,@"rootKey":canonicalTarget,@"receipt":manifest};
}
- (BOOL)checkpointReceipt:(NSDictionary *)receipt name:(NSString *)name error:(NSError **)error {
  NSSet *allowed=[NSSet setWithArray:@[@"prepared",@"before-publication",@"after-publication"]]; if(![allowed containsObject:name]){if(error)*error=HMAError(EINVAL,@"Unknown checkpoint");return NO;}
  NSString *stage=receipt[@"stagePath"]; int d=open(stage.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW); int f=d<0?-1:openat(d,".holi-acquisition.json",O_RDONLY|O_NOFOLLOW); if(f<0){if(d>=0)close(d);if(error)*error=HMAError(errno,@"Owned receipt unavailable");return NO;}
  NSMutableData *data=[NSMutableData data]; char b[4096]; ssize_t n; while((n=read(f,b,sizeof b))>0)[data appendBytes:b length:(NSUInteger)n]; close(f); NSDictionary *m=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]; NSMutableDictionary *updated=[m mutableCopy]; updated[@"phase"]=name; NSData *out=[NSJSONSerialization dataWithJSONObject:updated options:NSJSONWritingSortedKeys error:nil]; int w=openat(d,".holi-acquisition.tmp",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600); BOOL ok=w>=0&&HMAWrite(w,out); if(w>=0)close(w); if(ok)ok=renameat(d,".holi-acquisition.tmp",d,".holi-acquisition.json")==0&&fsync(d)==0; close(d); if(!ok&&error)*error=HMAError(errno?:EIO,@"Checkpoint write failed");return ok;
}
- (NSDictionary *)finishReceipt:(NSDictionary *)receipt error:(NSError **)error {
  NSString *stage=receipt[@"stagePath"], *target=receipt[@"targetPath"]; struct stat st; if(lstat(target.fileSystemRepresentation,&st)==0){if(error)*error=HMAError(EEXIST,@"Refusing to replace existing target");return nil;}
  if(![self checkpointReceipt:receipt name:@"before-publication" error:error])return nil;
  if(renamex_np(stage.fileSystemRepresentation,target.fileSystemRepresentation,RENAME_EXCL)){if(error)*error=HMAError(errno,@"Atomic no-replace publication refused");return nil;}
  int p=open(target.stringByDeletingLastPathComponent.fileSystemRepresentation,O_RDONLY|O_DIRECTORY); BOOL ok=p>=0&&fsync(p)==0;if(p>=0)close(p); if(!ok){if(error)*error=HMAError(errno?:EIO,@"Published, but parent durability is uncertain");return nil;}
  return @{@"targetPath":target,@"rootKey":receipt[@"rootKey"],@"receipt":receipt[@"receipt"]?:@{}};
}
- (NSDictionary *)receiptsAtTarget:(NSString *)target error:(NSError **)error { NSString *parent=target.stringByStandardizingPath.stringByDeletingLastPathComponent; char resolved[PATH_MAX]; if(!realpath(parent.fileSystemRepresentation,resolved)){if(error)*error=HMAError(errno,@"Cannot canonicalize target parent");return @{@"receipts":@[],@"refusals":@[]};} NSMutableArray *found=[NSMutableArray array]; DIR *dir=opendir(resolved); struct dirent *e; while(dir&&(e=readdir(dir)))if(strstr(e->d_name,".holi-acquire-")==e->d_name){NSString *path=[[NSString stringWithUTF8String:resolved] stringByAppendingPathComponent:[NSString stringWithUTF8String:e->d_name]]; int d=open(path.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW); int f=d<0?-1:openat(d,".holi-acquisition.json",O_RDONLY|O_NOFOLLOW); if(f>=0){NSMutableData *data=[NSMutableData data];char b[4096];ssize_t n;while((n=read(f,b,sizeof b))>0)[data appendBytes:b length:n];NSDictionary *m=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];if(m)[found addObject:@{@"stagePath":path,@"targetPath":m[@"target"]?:@"",@"rootKey":m[@"rootKey"]?:@"",@"receipt":m}];close(f);}if(d>=0)close(d);} if(dir)closedir(dir);return @{@"receipts":found,@"refusals":@[]}; }
@end
