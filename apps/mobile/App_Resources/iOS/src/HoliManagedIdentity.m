#import "HoliManagedIdentity.h"

#import <errno.h>
#import <fcntl.h>
#import <sys/stat.h>
#import <unistd.h>

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

static NSDictionary<NSString *, id> * _Nullable HoliReadRecord(int gitFD, NSError **error) {
    int fd = openat(gitFD, "holi-managed.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) {
        if (error) *error = HoliIdentityError(errno, @"Managed identity is unavailable.");
        return nil;
    }
    struct stat st;
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size <= 0 ||
        st.st_size > HoliManagedIdentityLimit) {
        close(fd);
        if (error) *error = HoliIdentityError(1, @"Managed identity is not a bounded regular file.");
        return nil;
    }
    NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)st.st_size];
    size_t offset = 0;
    while (offset < data.length) {
        ssize_t count = read(fd, (char *)data.mutableBytes + offset, data.length - offset);
        if (count <= 0) {
            close(fd);
            if (error) *error = HoliIdentityError(2, @"Managed identity could not be read completely.");
            return nil;
        }
        offset += (size_t)count;
    }
    char extra;
    ssize_t trailing = read(fd, &extra, 1);
    close(fd);
    if (trailing != 0) {
        if (error) *error = HoliIdentityError(3, @"Managed identity changed while being read.");
        return nil;
    }
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSData *json = text ? [text dataUsingEncoding:NSUTF8StringEncoding] : nil;
    id object = json ? [NSJSONSerialization JSONObjectWithData:json options:0 error:nil] : nil;
    NSArray *keys = @[@"version", @"nativeId", @"remote", @"branch", @"endpoint"];
    if (![object isKindOfClass:NSDictionary.class] || [object count] != keys.count ||
        ![[NSSet setWithArray:[object allKeys]] isEqualToSet:[NSSet setWithArray:keys]] ||
        ![object[@"version"] isKindOfClass:NSNumber.class] || [object[@"version"] integerValue] != 1 ||
        !HoliValidString(object[@"nativeId"]) || ![[NSUUID alloc] initWithUUIDString:object[@"nativeId"]] ||
        !HoliValidString(object[@"remote"]) || !HoliValidString(object[@"branch"]) ||
        !HoliValidString(object[@"endpoint"])) {
        if (error) *error = HoliIdentityError(4, @"Managed identity is malformed or unsupported.");
        return nil;
    }
    return object;
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
