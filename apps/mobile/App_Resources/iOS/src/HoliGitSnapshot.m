#import "HoliGitSnapshot.h"
#import <fcntl.h>
#import <dirent.h>
#import <sys/stat.h>
#import <unistd.h>
#import <limits.h>
#import <errno.h>

static NSString * const SnapshotErrorDomain = @"HoliGitSnapshot";
static const off_t MaxFileSize = 256LL * 1024 * 1024;
static const off_t MaxTotalSize = 512LL * 1024 * 1024;


static BOOL Fail(NSError **error, NSString *message) {
    if (error) *error = [NSError errorWithDomain:SnapshotErrorDomain code:1 userInfo:@{NSLocalizedDescriptionKey: message}];
    return NO;
}

static BOOL Same(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && (a->st_mode & S_IFMT) == (b->st_mode & S_IFMT) && a->st_size == b->st_size;
}

static BOOL Forbidden(NSString *name) {
    return [@[@"alternates", @"http-alternates", @"commondir", @"gitdir", @"config.worktree", @"grafts", @"shallow"] containsObject:name] || [name isEqualToString:@"replace"];
}

static BOOL CopyDirectory(int source, int target, NSError **error, off_t *totalBytes) {
    int scan = dup(source);
    if (scan < 0) return Fail(error, @"Cannot scan metadata directory");
    DIR *dir = fdopendir(scan);
    if (!dir) { close(scan); return Fail(error, @"Cannot scan metadata directory"); }
    struct dirent *entry;
    errno = 0;
    BOOL ok = YES;
    while (ok && (entry = readdir(dir))) {
        NSString *name = [NSString stringWithUTF8String:entry->d_name];
        if ([name isEqualToString:@"."] || [name isEqualToString:@".."]) continue;
        if (!name || Forbidden(name) || [name isEqualToString:@"worktrees"]) { ok = Fail(error, @"Unsupported Git metadata indirection"); break; }
        struct stat before, after;
        if (fstatat(source, entry->d_name, &before, AT_SYMLINK_NOFOLLOW) || !S_ISDIR(before.st_mode) && !S_ISREG(before.st_mode)) { ok = Fail(error, @"Unsupported Git metadata entry"); break; }
        if (S_ISDIR(before.st_mode)) {
            if (mkdirat(target, entry->d_name, 0700)) { ok = Fail(error, @"Cannot create snapshot directory"); break; }
            int in = openat(source, entry->d_name, O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
            int out = openat(target, entry->d_name, O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
            struct stat opened;
            if (in < 0 || out < 0 || fstat(in, &opened) || !Same(&before, &opened)) ok = Fail(error, @"Metadata directory changed during snapshot");
            else ok = CopyDirectory(in, out, error, totalBytes);
            if (in >= 0) close(in); if (out >= 0) close(out);
            if (ok && (fstatat(source, entry->d_name, &after, AT_SYMLINK_NOFOLLOW) || !Same(&before, &after))) ok = Fail(error, @"Metadata directory changed during snapshot");
        } else {
            if (before.st_size < 0 || before.st_size > MaxFileSize || (*totalBytes += before.st_size) > MaxTotalSize) { ok = Fail(error, @"Git metadata snapshot exceeds size limits"); break; }
            int in = openat(source, entry->d_name, O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
            struct stat opened;
            if (in < 0 || fstat(in, &opened) || !Same(&before, &opened) || !S_ISREG(opened.st_mode)) { if(in>=0)close(in); ok=Fail(error,@"Metadata file changed during snapshot"); break; }
            int out = openat(target, entry->d_name, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600);
            char buffer[32768]; ssize_t n;
            if(out < 0) ok=Fail(error,@"Cannot create snapshot file");
            while(ok && (n=read(in,buffer,sizeof(buffer)))>0) { ssize_t offset=0; while(offset<n) { ssize_t w=write(out,buffer+offset,(size_t)(n-offset)); if(w<=0){ok=Fail(error,@"Cannot copy metadata file");break;} offset+=w; } }
            if(ok && n<0) ok=Fail(error,@"Cannot read metadata file");
            if(out>=0)close(out);
            if (fstat(in,&after) || !Same(&before,&after)) ok=Fail(error,@"Metadata file changed during snapshot");
            if (ok && (fstatat(source, entry->d_name, &after, AT_SYMLINK_NOFOLLOW) || !Same(&before, &after))) ok = Fail(error, @"Metadata file replaced during snapshot");
            close(in);
        }
        errno = 0;
    }
    if (ok && errno) ok = Fail(error, @"Cannot enumerate Git metadata");
    closedir(dir);
    return ok;
}

@implementation HoliGitSnapshot {
    NSString *_path;
    NSData *_configData;
}
- (NSString *)path { return _path; }
- (NSData *)configData { return _configData; }
- (nullable instancetype)initWithRoot:(NSString *)root error:(NSError **)error {
    self=[super init]; if(!self)return nil;
    int base=open(root.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    if(base<0){Fail(error,@"Cannot open vault root");return nil;}
    int git=openat(base,".git",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); close(base);
    if(git<0){Fail(error,@"Cannot open Git metadata directory");return nil;}
    char temp[PATH_MAX];
    snprintf(temp, sizeof(temp), "%sholi-git-snapshot-XXXXXX", NSTemporaryDirectory().fileSystemRepresentation);
    char *made=mkdtemp(temp); if(!made){close(git);Fail(error,@"Cannot create private snapshot");return nil;}
    _path=[[NSFileManager defaultManager] stringWithFileSystemRepresentation:made length:strlen(made)];
    NSString *gitPath=[_path stringByAppendingPathComponent:@".git"];
    mkdir(gitPath.fileSystemRepresentation,0700);
    int dest=open(gitPath.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    off_t totalBytes=0;
    BOOL ok=dest>=0 && CopyDirectory(git,dest,error,&totalBytes);
    close(git); if(dest>=0)close(dest);
    if(ok){
        NSString *config=[gitPath stringByAppendingPathComponent:@"config"];
        NSData *data=[NSData dataWithContentsOfFile:config];
        NSString *text=data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"";
        NSRegularExpression *bad=[NSRegularExpression regularExpressionWithPattern:@"(?im)^\\s*\\[\\s*(include(?:if)?|extensions)(?:\\s+[^\\]]*)?\\s*\\]" options:0 error:nil];
        NSRegularExpression *worktree=[NSRegularExpression regularExpressionWithPattern:@"(?im)^\\s*worktree\\s*=" options:0 error:nil];
        if(!data || !text || [bad numberOfMatchesInString:text options:0 range:NSMakeRange(0,text.length)] || [worktree numberOfMatchesInString:text options:0 range:NSMakeRange(0,text.length)]) ok=Fail(error,@"Git config contains unsupported directives");
        else _configData=data;
    }
    if(!ok){[self close];return nil;}
    return self;
}
- (void)close { if(_path){[[NSFileManager defaultManager] removeItemAtPath:_path error:nil];_path=nil;} }
- (void)dealloc { [self close]; }
@end
