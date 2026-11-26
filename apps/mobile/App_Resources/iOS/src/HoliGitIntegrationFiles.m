#import "HoliGitIntegrationFiles.h"
#import <git2.h>
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>
#import <errno.h>
#import <string.h>
#import <stdio.h>
#import <stdlib.h>

static NSString *const HGIErrorDomain = @"HoliGitIntegrationFiles";
static BOOL HGIError(NSError **error, int code, NSString *message) {
    if (error) *error = [NSError errorWithDomain:HGIErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey: message}];
    return NO;
}
static BOOL HGIName(NSString *s) {
    return [s isKindOfClass:NSString.class] && s.length && ![s containsString:@"/"] && ![s isEqual:@"."] && ![s isEqual:@".."] && [s rangeOfString:@"\0"].location == NSNotFound;
}
static int HGIDir(int root, NSString *path, BOOL create, NSString **leaf, NSError **error) {
    if (![path isKindOfClass:NSString.class] || !path.length || [path containsString:@"\0"]) { HGIError(error, EINVAL, @"invalid path"); return -1; }
    NSArray *parts = [path componentsSeparatedByString:@"/"];
    int fd = dup(root); if (fd < 0) { HGIError(error, errno, @"duplicate root descriptor"); return -1; }
    for (NSUInteger i=0; i+1<parts.count; i++) {
        NSString *part=parts[i]; if (!HGIName(part)) { close(fd); HGIError(error, EINVAL, @"unsafe path component"); return -1; }
        int next=openat(fd,part.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
        if(next<0 && create && errno==ENOENT) { if(mkdirat(fd,part.fileSystemRepresentation,0755)<0 && errno!=EEXIST) { close(fd); HGIError(error,errno,@"create directory"); return -1; } next=openat(fd,part.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); }
        if(next<0) { close(fd); HGIError(error,errno,@"open path directory"); return -1; } close(fd); fd=next;
    }
    *leaf=parts.lastObject; if(!HGIName(*leaf)){close(fd);HGIError(error,EINVAL,@"unsafe final component");return -1;} return fd;
}
static BOOL HGIStateEqual(NSDictionary *a, NSDictionary *b) { return a==b || [a isEqual:b]; }
static NSDictionary *HGIReadState(int dir, NSString *name, NSError **error) {
    struct stat st; if(fstatat(dir,name.fileSystemRepresentation,&st,AT_SYMLINK_NOFOLLOW)<0) { if(errno==ENOENT)return NSNull.null; HGIError(error,errno,@"stat working file"); return nil; }
    if(!S_ISREG(st.st_mode)||st.st_nlink!=1) { HGIError(error,EINVAL,@"working entry is not a singly-linked regular file"); return nil; }
    int fd=openat(dir,name.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW|O_CLOEXEC); if(fd<0){HGIError(error,errno,@"open working file");return nil;}
    struct stat before,after; if(fstat(fd,&before)<0){close(fd);HGIError(error,errno,@"stat opened file");return nil;}
    NSMutableData *data=[NSMutableData data]; uint8_t buf[65536]; ssize_t n;
    while((n=read(fd,buf,sizeof(buf)))>0)[data appendBytes:buf length:(NSUInteger)n];
    if(n<0||fstat(fd,&after)<0){int e=errno;close(fd);HGIError(error,e,@"read working file");return nil;} close(fd);
    if(before.st_dev!=after.st_dev||before.st_ino!=after.st_ino||before.st_size!=after.st_size||before.st_mtime!=after.st_mtime||before.st_ctime!=after.st_ctime||before.st_size!=(off_t)data.length){HGIError(error,EAGAIN,@"working file changed while hashing");return nil;}
    git_oid oid; if(git_odb_hash(&oid,data.bytes,data.length,GIT_OBJECT_BLOB)<0){HGIError(error,EIO,@"hash working file");return nil;}
    return @{ @"oid":[NSString stringWithUTF8String:git_oid_tostr_s(&oid)], @"mode":@((st.st_mode&0111)?33261:33188) };
}
static BOOL HGIValidState(id state) { if(state==NSNull.null)return YES; if(![state isKindOfClass:NSDictionary.class])return NO; NSString *oid=state[@"oid"]; NSNumber *mode=state[@"mode"]; if(![oid isKindOfClass:NSString.class]||oid.length!=40||![mode isKindOfClass:NSNumber.class]||(mode.intValue!=33188&&mode.intValue!=33261))return NO; git_oid parsed; return git_oid_fromstr(&parsed,oid.UTF8String)==0; }
static BOOL HGIMoveExclusive(int from, NSString *source, int to, NSString *dest) {
#ifdef RENAME_EXCL
    return renameatx_np(from,source.fileSystemRepresentation,to,dest.fileSystemRepresentation,RENAME_EXCL)==0;
#else
    errno=ENOTSUP; return NO;
#endif
}
BOOL HGIPreflightIntegrationFiles(int rootFD,int transactionFD,NSArray<NSDictionary *> *changes,NSError **error) {
    for(NSDictionary *c in changes){ NSString *path=c[@"path"],*artifact=c[@"newArtifact"],*slot=c[@"oldSlot"]; id old=c[@"old"], new=c[@"new"];
        if(!HGIValidState(old)||!HGIValidState(new)||!HGIName(artifact)||!HGIName(slot))return HGIError(error,EINVAL,@"invalid change descriptor");
        NSString *leaf=nil; int d=HGIDir(rootFD,path,NO,&leaf,error); if(d<0)return NO;
        NSDictionary *current=HGIReadState(d,leaf,error); close(d); if(!current)return NO;
        BOOL expected=HGIStateEqual(current,old)||HGIStateEqual(current,new);
        struct stat st; if(!expected && current==NSNull.null && fstatat(transactionFD,slot.fileSystemRepresentation,&st,AT_SYMLINK_NOFOLLOW)==0) expected=HGIStateEqual(old,old)&&old!=NSNull.null;
        if(!expected)return HGIError(error,EBUSY,@"working file is neither recorded old nor new state");
    } return YES;
}
BOOL HGIApplyIntegrationFiles(int rootFD,int transactionFD,NSArray<NSDictionary *> *changes,NSError **error) {
    if(!HGIPreflightIntegrationFiles(rootFD,transactionFD,changes,error))return NO;
    for(NSDictionary *c in changes){ NSString *leaf=nil,*path=c[@"path"],*slot=c[@"oldSlot"],*artifact=c[@"newArtifact"]; id old=c[@"old"], new=c[@"new"];
        int d=HGIDir(rootFD,path,new!=NSNull.null,&leaf,error); if(d<0)return NO;
        NSDictionary *cur=HGIReadState(d,leaf,error); if(!cur){close(d);return NO;}
        if(HGIStateEqual(cur,old)&&old!=NSNull.null){ if(!HGIMoveExclusive(d,leaf,transactionFD,slot)){int e=errno;close(d);return HGIError(error,e,@"exclusive displacement failed");} fsync(d);fsync(transactionFD); cur=NSNull.null; }
        if(new!=NSNull.null && HGIStateEqual(cur,NSNull.null)){
            int fd=openat(transactionFD,artifact.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW|O_CLOEXEC); if(fd<0){close(d);return HGIError(error,errno,@"open staged image");} if(fsync(fd)<0){int e=errno;close(fd);close(d);return HGIError(error,e,@"sync staged image");} close(fd);
            if(!HGIMoveExclusive(transactionFD,artifact,d,leaf)){int e=errno;close(d);return HGIError(error,e,@"exclusive publication failed");} fsync(d);
        }
        NSDictionary *after=HGIReadState(d,leaf,error); close(d); if(!after||!HGIStateEqual(after,new))return HGIError(error,EIO,@"published state verification failed");
    } return YES;
}
