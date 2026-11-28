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
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino && (a->st_mode & S_IFMT) == (b->st_mode & S_IFMT) && a->st_size == b->st_size && a->st_nlink == b->st_nlink;
}

static BOOL Forbidden(NSString *path) {
    return [@[@"objects/info/alternates", @"objects/info/http-alternates", @"commondir", @"gitdir", @"config.worktree", @"info/grafts", @"shallow", @"info/attributes", @"worktrees", @"refs/replace"] containsObject:path.lowercaseString];
}

static BOOL SafeConfig(NSString *text) {
    if (!text || [text containsString:@"\\"]) return NO;
    NSRegularExpression *header = [NSRegularExpression regularExpressionWithPattern:@"^\\[([A-Za-z][A-Za-z0-9-]*)(?:[ \\t]+\"[^\"]*\")?\\][ \\t]*(?:[#;].*)?$" options:0 error:nil];
    for (NSString *raw in [text componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet]) {
        NSString *line = [raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
        if (!line.length || [line hasPrefix:@"#"] || [line hasPrefix:@";"]) continue;
        if ([line containsString:@"["] || [line containsString:@"]"]) {
            NSTextCheckingResult *match = [header firstMatchInString:line options:0 range:NSMakeRange(0,line.length)];
            if (!match) return NO;
            NSString *section = [line substringWithRange:[match rangeAtIndex:1]].lowercaseString;
            if ([@[@"include", @"includeif", @"extensions"] containsObject:section]) return NO;
        } else {
            NSString *key = [[[line componentsSeparatedByString:@"="] firstObject] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].lowercaseString;
            if ([key isEqualToString:@"worktree"]) return NO;
        }
    }
    return YES;
}

static BOOL CopyDirectory(int source, int target, NSError **error, off_t *totalBytes, NSString *prefix, NSUInteger *entries, NSUInteger depth) {
    if (depth > 64) return Fail(error, @"Git metadata exceeds depth limit");
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
        if (++*entries > 20000) { ok = Fail(error, @"Git metadata exceeds entry limit"); break; }
        if (!name || Forbidden(prefix.length ? [prefix stringByAppendingFormat:@"/%@", name] : name)) { ok = Fail(error, @"Unsupported Git metadata indirection"); break; }
        struct stat before, after;
        if (fstatat(source, entry->d_name, &before, AT_SYMLINK_NOFOLLOW) || (!S_ISDIR(before.st_mode) && !S_ISREG(before.st_mode)) || (S_ISREG(before.st_mode) && before.st_nlink != 1)) { ok = Fail(error, @"Unsupported Git metadata entry"); break; }
        if (S_ISDIR(before.st_mode)) {
            if (mkdirat(target, entry->d_name, 0700)) { ok = Fail(error, @"Cannot create snapshot directory"); break; }
            int in = openat(source, entry->d_name, O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
            int out = openat(target, entry->d_name, O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
            struct stat opened;
            if (in < 0 || out < 0 || fstat(in, &opened) || !Same(&before, &opened)) ok = Fail(error, @"Metadata directory changed during snapshot");
            else ok = CopyDirectory(in, out, error, totalBytes, prefix.length ? [prefix stringByAppendingFormat:@"/%@", name] : name, entries, depth + 1);
            if (in >= 0) close(in); if (out >= 0) close(out);
            if (ok && (fstatat(source, entry->d_name, &after, AT_SYMLINK_NOFOLLOW) || !Same(&before, &after))) ok = Fail(error, @"Metadata directory changed during snapshot");
        } else {
            if (before.st_size < 0 || before.st_size > MaxFileSize || (*totalBytes += before.st_size) > MaxTotalSize) { ok = Fail(error, @"Git metadata snapshot exceeds size limits"); break; }
            int in = openat(source, entry->d_name, O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
            struct stat opened;
            if (in < 0 || fstat(in, &opened) || !Same(&before, &opened) || !S_ISREG(opened.st_mode)) { if(in>=0)close(in); ok=Fail(error,@"Metadata file changed during snapshot"); break; }
            int out = openat(target, entry->d_name, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC, 0600);
            char buffer[32768]; ssize_t n = 0; off_t copied = 0;
            if(out < 0) ok=Fail(error,@"Cannot create snapshot file");
            while(ok && (n=read(in,buffer,sizeof(buffer)))>0) { copied += n; if (copied > MaxFileSize || copied > before.st_size) { ok=Fail(error,@"Metadata grew beyond snapshot limit"); break; } ssize_t offset=0; while(offset<n) { ssize_t w=write(out,buffer+offset,(size_t)(n-offset)); if(w<=0){ok=Fail(error,@"Cannot copy metadata file");break;} offset+=w; } }
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
}
- (NSString *)path { return _path; }
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
    NSUInteger entries=0;
    BOOL ok=dest>=0 && CopyDirectory(git,dest,error,&totalBytes,@"",&entries,0);
    close(git); if(dest>=0)close(dest);
    if(ok){
        NSString *config=[gitPath stringByAppendingPathComponent:@"config"];
        NSData *data=[NSData dataWithContentsOfFile:config];
        NSString *text=data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"";
        if (!data || !SafeConfig(text)) ok=Fail(error,@"Git config contains unsupported directives");
    }
    if(!ok){[self close];return nil;}
    return self;
}
- (BOOL)closeWithError:(NSError **)error {
    if (!_path) return YES;
    if (![[NSFileManager defaultManager] removeItemAtPath:_path error:error]) return NO;
    _path = nil;
    return YES;
}
- (void)close { [self closeWithError:nil]; }
- (void)dealloc { [self close]; }
@end
