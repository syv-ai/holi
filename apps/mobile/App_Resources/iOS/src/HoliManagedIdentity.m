#import "HoliManagedIdentity.h"

#import <errno.h>
#import <fcntl.h>
#import <sys/stat.h>
#import <unistd.h>
#import <CoreFoundation/CoreFoundation.h>

static NSString * const HoliManagedIdentityErrorDomain = @"HoliManagedIdentity";
static const size_t HoliManagedIdentityLimit = 16384;

static NSError *HoliIdentityError(NSInteger code, NSString *description) {
    return [NSError errorWithDomain:HoliManagedIdentityErrorDomain code:code
                           userInfo:@{NSLocalizedDescriptionKey: description}];
}

static BOOL HoliValidString(id value) {
    return [value isKindOfClass:NSString.class] && [value length] > 0 &&
           [value rangeOfString:@"\0"].location == NSNotFound;
}

static NSData *HoliReadBytes(int gitFD, const char *name, NSError **error) {
    int fd = openat(gitFD, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) { if (error) *error = HoliIdentityError(errno, @"Managed metadata is unavailable"); return nil; }
    struct stat before, after;
    BOOL ok = fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_size > 0 && before.st_size <= HoliManagedIdentityLimit;
    NSMutableData *bytes = [NSMutableData data];
    uint8_t buffer[1024];
    while (ok) {
        ssize_t count = read(fd, buffer, sizeof(buffer));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { ok = NO; break; }
        if (!count) break;
        if (bytes.length + (NSUInteger)count > HoliManagedIdentityLimit) { ok = NO; break; }
        [bytes appendBytes:buffer length:(NSUInteger)count];
    }
    if (ok) ok = fstat(fd, &after) == 0 && before.st_dev == after.st_dev && before.st_ino == after.st_ino &&
        before.st_size == after.st_size && bytes.length == (NSUInteger)before.st_size &&
        before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec && before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec;
    close(fd);
    if (!ok) { if (error) *error = HoliIdentityError(EINVAL, @"Managed metadata is not stable bounded regular data"); return nil; }
    return bytes;
}
static BOOL HoliAttachedBranch(int gitFD, NSString *branch, NSError **error) {
    NSData *data = HoliReadBytes(gitFD, "HEAD", error);
    if (!data) return NO;
    NSString *head = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if ([head hasSuffix:@"\n"]) head = [head substringToIndex:head.length - 1];
    if (![head isEqual:[@"ref: refs/heads/" stringByAppendingString:branch]]) {
        if (error) *error = HoliIdentityError(EINVAL, @"Managed checkout is detached or on another branch");
        return NO;
    }
    return YES;
}
static NSDictionary<NSString *, id> * _Nullable HoliReadRecord(int gitFD, NSError **error) {
    NSData *data = HoliReadBytes(gitFD, "holi-managed.json", error);
    if (!data) return nil;
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSData *json = text ? [text dataUsingEncoding:NSUTF8StringEncoding] : nil;
    id object = json ? [NSJSONSerialization JSONObjectWithData:json options:0 error:nil] : nil;
    NSArray *keys = @[@"version", @"nativeId", @"remote", @"branch", @"endpoint"];
    if (![object isKindOfClass:NSDictionary.class] || [object count] != keys.count ||
        ![[NSSet setWithArray:[object allKeys]] isEqualToSet:[NSSet setWithArray:keys]] ||
        ![object[@"version"] isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)object[@"version"]) == CFBooleanGetTypeID() || ![object[@"version"] isEqual:@1] ||
        !HoliValidString(object[@"nativeId"]) || ![[NSUUID alloc] initWithUUIDString:object[@"nativeId"]] ||
        !HoliValidString(object[@"remote"]) || !HoliValidString(object[@"branch"]) ||
        !HoliValidString(object[@"endpoint"])) {
        if (error) *error = HoliIdentityError(4, @"Managed identity is malformed or unsupported.");
        return nil;
    }
    return HoliAttachedBranch(gitFD, object[@"branch"], error) ? object : nil;
}

@implementation HoliManagedIdentity

- (int)openGitDirectoryAtRoot:(NSString *)root error:(NSError **)error {
    int rootFD = open(root.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (rootFD < 0) {
        if (error) *error = HoliIdentityError(errno, @"Vault root is unavailable.");
        return -1;
    }
    int gitFD = openat(rootFD, ".git", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int saved = errno;
    close(rootFD);
    if (gitFD < 0) {
        if (error) *error = HoliIdentityError(saved, @"Vault .git directory is unavailable or unsafe.");
    }
    return gitFD;
}

- (NSDictionary<NSString *,id> *)readIdentityAtRoot:(NSString *)root error:(NSError **)error {
    int gitFD = [self openGitDirectoryAtRoot:root error:error];
    if (gitFD < 0) return nil;
    NSDictionary *identity = HoliReadRecord(gitFD, error);
    close(gitFD);
    return identity;
}

- (NSDictionary<NSString *,id> *)createIdentityAtRoot:(NSString *)root remote:(NSString *)remote branch:(NSString *)branch endpoint:(NSString *)endpoint error:(NSError **)error {
    if (!HoliValidString(remote) || !HoliValidString(branch) || !HoliValidString(endpoint)) {
        if (error) *error = HoliIdentityError(5, @"Identity fields must be non-empty strings.");
        return nil;
    }
    int gitFD = [self openGitDirectoryAtRoot:root error:error];
    if (gitFD < 0) return nil;
    if (!HoliAttachedBranch(gitFD, branch, error)) { close(gitFD); return nil; }
    NSDictionary *identity = @{@"version": @1, @"nativeId": NSUUID.UUID.UUIDString,
                               @"remote": remote, @"branch": branch, @"endpoint": endpoint};
    NSData *data = [NSJSONSerialization dataWithJSONObject:identity options:NSJSONWritingSortedKeys error:error];
    if (!data || data.length > HoliManagedIdentityLimit) {
        close(gitFD);
        if (error && !*error) *error = HoliIdentityError(6, @"Identity record exceeds its size limit.");
        return nil;
    }
    int fd = openat(gitFD, "holi-managed.json", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) {
        close(gitFD);
        if (error) *error = HoliIdentityError(errno, @"Managed identity already exists or cannot be created.");
        return nil;
    }
    size_t offset = 0;
    BOOL ok = YES;
    while (offset < data.length) {
        ssize_t count = write(fd, (const char *)data.bytes + offset, data.length - offset);
        if (count <= 0) { ok = NO; break; }
        offset += (size_t)count;
    }
    if (ok && fsync(fd) != 0) ok = NO;
    if (close(fd) != 0) ok = NO;
    if (ok && fsync(gitFD) != 0) ok = NO;
    close(gitFD);
    if (!ok) {
        if (error) *error = HoliIdentityError(errno ?: EIO, @"Managed identity could not be durably written.");
        return nil;
    }
    return identity;
}

- (BOOL)identity:(NSDictionary<NSString *,id> *)identity matchesRemote:(NSString *)remote branch:(NSString *)branch endpoint:(NSString *)endpoint error:(NSError **)error {
    if (!identity || ![identity[@"remote"] isEqual:remote] || ![identity[@"branch"] isEqual:branch] ||
        ![identity[@"endpoint"] isEqual:endpoint]) {
        if (error) *error = HoliIdentityError(7, @"Managed identity does not match the expected vault.");
        return NO;
    }
    return YES;
}

@end
