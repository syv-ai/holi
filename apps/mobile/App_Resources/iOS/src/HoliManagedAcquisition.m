#import "HoliManagedAcquisition.h"
#import "HoliManagedIdentity.h"
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>
#import <dirent.h>
#import <errno.h>
#import <uuid/uuid.h>
#import <string.h>

static NSString *const HMAErrorDomain = @"HoliManagedAcquisitionErrorDomain";
static NSError *HMAError(int c, NSString *s) { return [NSError errorWithDomain:HMAErrorDomain code:c userInfo:@{NSLocalizedDescriptionKey:s}]; }
static BOOL HMAString(id x) { return [x isKindOfClass:NSString.class] && [x length] && ![x containsString:@"\0"]; }
static NSString *HMAUUID(void) { uuid_t u; uuid_generate(u); char s[37]; uuid_unparse_lower(u,s); return [NSString stringWithUTF8String:s]; }
static BOOL HMAWrite(int fd, NSData *d) { const char *p=d.bytes; size_t n=d.length; while(n){ssize_t k=write(fd,p,n);if(k<0&&errno==EINTR)continue;if(k<=0)return NO;p+=k;n-=k;}return fsync(fd)==0; }
static NSDictionary *HMARead(int d) {
 int f=openat(d,".holi-acquisition.json",O_RDONLY|O_NOFOLLOW|O_CLOEXEC); if(f<0)return nil;
 struct stat st; BOOL valid=fstat(f,&st)==0&&S_ISREG(st.st_mode)&&st.st_size>=2&&st.st_size<=4096;
 NSMutableData *data=[NSMutableData data]; char b[4097]; ssize_t n=0;
 if(valid){ do { n=read(f,b,sizeof b); if(n>0){if(data.length+(NSUInteger)n>4096){valid=NO;break;}[data appendBytes:b length:(NSUInteger)n];} } while(n>0|| (n<0&&errno==EINTR)); if(n<0)valid=NO; }
 close(f); if(!valid)return nil; id x=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]; return [x isKindOfClass:NSDictionary.class]?x:nil;
}
@implementation HoliManagedAcquisition
- (NSString *)rootKeyAtTarget:(NSString *)target error:(NSError **)error {
 if(!HMAString(target)||![target isAbsolutePath]||target.length>PATH_MAX){if(error)*error=HMAError(EINVAL,@"Invalid absolute target");return nil;}
 NSString *p=target.stringByStandardizingPath.stringByDeletingLastPathComponent,*leaf=target.lastPathComponent; char r[PATH_MAX]; if(!leaf.length||!realpath(p.fileSystemRepresentation,r)){if(error)*error=HMAError(errno, @"Target parent unavailable");return nil;} return [[NSString stringWithUTF8String:r]stringByAppendingPathComponent:leaf];
}
- (NSDictionary *)beginAtTarget:(NSString *)target remote:(NSString *)remote branch:(NSString *)branch runId:(NSString *)runId error:(NSError **)error {
 NSString *key=[self rootKeyAtTarget:target error:error]; if(!key||!HMAString(remote)||!HMAString(branch)||!HMAString(runId))return nil;
 struct stat st;if(lstat(key.fileSystemRepresentation,&st)==0||errno!=ENOENT){if(error)*error=HMAError(EEXIST,@"Target already exists");return nil;}
 NSString *uid=HMAUUID(),*container=[key.stringByDeletingLastPathComponent stringByAppendingPathComponent:[@".holi-acquire-" stringByAppendingString:uid]],*checkout=[container stringByAppendingPathComponent:@"checkout"];
 if(mkdir(container.fileSystemRepresentation,0700)){if(error)*error=HMAError(errno,@"Cannot create acquisition container");return nil;}
 int d=open(container.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); NSDictionary *m=@{@"version":@1,@"uuid":uid,@"container":container,@"stage":checkout,@"target":key,@"rootKey":key,@"remote":remote,@"branch":branch,@"runId":runId,@"phase":@"prepared"};
 NSData *data=[NSJSONSerialization dataWithJSONObject:m options:NSJSONWritingSortedKeys error:nil]; int f=d<0?-1:openat(d,".holi-acquisition.json",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600); BOOL ok=f>=0&&data.length<=4096&&HMAWrite(f,data)&&fsync(d)==0; if(f>=0)close(f);if(d>=0)close(d);
 if(!ok){if(error)*error=HMAError(errno?:EIO,@"Cannot record acquisition");return nil;} return @{@"stagePath":checkout,@"containerPath":container,@"targetPath":key,@"rootKey":key,@"receipt":m};
}
- (BOOL)checkpointReceipt:(NSDictionary *)receipt name:(NSString *)name error:(NSError **)error {
 if(![@[@"prepared",@"before-publication",@"after-publication"] containsObject:name]){if(error)*error=HMAError(EINVAL,@"Unknown checkpoint");return NO;}
 NSString *container=receipt[@"containerPath"]; if(!HMAString(container)){if(error)*error=HMAError(EINVAL,@"Missing container");return NO;} int d=open(container.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); NSDictionary *m=d<0?nil:HMARead(d);
 if(!m||![m[@"container"] isEqual:container]||![receipt[@"stagePath"] isEqual:m[@"stage"]]||![receipt[@"targetPath"] isEqual:m[@"target"]]||![receipt[@"rootKey"] isEqual:m[@"rootKey"]]||![receipt[@"receipt"] isEqual:m]){if(d>=0)close(d);if(error)*error=HMAError(EPERM,@"Receipt ownership mismatch");return NO;}
 NSMutableDictionary *u=[m mutableCopy];u[@"phase"]=name;NSData *data=[NSJSONSerialization dataWithJSONObject:u options:NSJSONWritingSortedKeys error:nil];unlinkat(d,".holi-acquisition.tmp",0);int f=openat(d,".holi-acquisition.tmp",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);BOOL ok=f>=0&&HMAWrite(f,data);if(f>=0)close(f);if(ok)ok=renameat(d,".holi-acquisition.tmp",d,".holi-acquisition.json")==0&&fsync(d)==0;close(d);if(!ok&&error)*error=HMAError(errno?:EIO,@"Checkpoint failed");return ok;
}
- (NSDictionary *)finishReceipt:(NSDictionary *)receipt error:(NSError **)error {
 NSString *stage=receipt[@"stagePath"],*target=receipt[@"targetPath"]; NSDictionary *m=receipt[@"receipt"]; struct stat st;
 if(![self checkpointReceipt:receipt name:@"before-publication" error:error])return nil;
 NSString *container=receipt[@"containerPath"]; if(lstat(stage.fileSystemRepresentation,&st)||!S_ISDIR(st.st_mode)){if(error)*error=HMAError(ENOENT,@"Checkout stage missing");return nil;}
 HoliManagedIdentity *identity=[HoliManagedIdentity new];NSDictionary *i=[identity readIdentityAtRoot:stage error:error];if(!i||![i[@"remote"] isEqual:m[@"remote"]]||![i[@"branch"] isEqual:m[@"branch"]]||!HMAString(i[@"nativeId"])){if(error&&!*error)*error=HMAError(EPERM,@"Checkout identity mismatch");return nil;}
 NSString *key=[self rootKeyAtTarget:target error:error];if(![key isEqual:target]||lstat(target.fileSystemRepresentation,&st)==0){if(error)*error=HMAError(EEXIST,@"Target changed or already exists");return nil;}
 // Bind identity into the private manifest before the atomic no-replace publication.
 NSMutableDictionary *bound=[m mutableCopy];bound[@"nativeId"]=i[@"nativeId"];if(![self checkpointReceipt:@{@"containerPath":container,@"stagePath":stage,@"targetPath":target,@"rootKey":target,@"receipt":m} name:@"before-publication" error:error])return nil;
 if(renamex_np(stage.fileSystemRepresentation,target.fileSystemRepresentation,RENAME_EXCL)){if(error)*error=HMAError(errno,@"Atomic publication refused");return nil;} return @{@"targetPath":target,@"rootKey":target,@"receipt":bound};
}
- (NSDictionary *)receiptsAtTarget:(NSString *)target error:(NSError **)error {
 NSString *key=[self rootKeyAtTarget:target error:error];if(!key)return @{@"receipts":@[],@"refusals":@[]}; NSString *parent=key.stringByDeletingLastPathComponent;DIR *dir=opendir(parent.fileSystemRepresentation);NSMutableArray *found=[NSMutableArray array],*ref=[NSMutableArray array];struct dirent *e;
 while(dir&&(e=readdir(dir)))if(!strncmp(e->d_name,".holi-acquire-",14)){NSString *c=[parent stringByAppendingPathComponent:[NSString stringWithUTF8String:e->d_name]];int d=open(c.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);NSDictionary *m=d<0?nil:HMARead(d);if(d>=0)close(d);if(!m||![m[@"target"] isEqual:key]){[ref addObject:@{@"containerPath":c,@"reason":@"Invalid owned acquisition record"}];continue;}[found addObject:@{@"containerPath":c,@"stagePath":m[@"stage"],@"targetPath":key,@"rootKey":key,@"receipt":m}];}
 if(dir)closedir(dir);return @{@"receipts":found,@"refusals":ref};
}
@end
