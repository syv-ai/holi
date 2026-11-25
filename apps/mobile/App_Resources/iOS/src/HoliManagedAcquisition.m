#import "HoliManagedAcquisition.h"
#import "HoliManagedIdentity.h"
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>
#import <dirent.h>
#import <errno.h>
#import <string.h>
#import <stdio.h>
#import <CoreFoundation/CoreFoundation.h>

static BOOL HMAFail(NSError **error, int code, NSString *message) {
  if (error) *error = [NSError errorWithDomain:@"HoliManagedAcquisition" code:code userInfo:@{NSLocalizedDescriptionKey:message}];
  return NO;
}
static BOOL HMAString(id value) {
  return [value isKindOfClass:NSString.class] && [value length] > 0 && [value length] <= PATH_MAX && ![value containsString:@"\0"];
}
static BOOL HMAUUID(id value) {
  return HMAString(value) && [value length] == 36 && [[NSUUID alloc] initWithUUIDString:value] != nil;
}
static BOOL HMASame(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && (a->st_mode & S_IFMT) == (b->st_mode & S_IFMT);
}
static BOOL HMAWrite(int directory, NSDictionary *manifest, NSError **error) {
  NSData *bytes = [NSJSONSerialization dataWithJSONObject:manifest options:NSJSONWritingSortedKeys error:error];
  if (!bytes || bytes.length > 4096) return HMAFail(error, EINVAL, @"Acquisition record exceeds its bound");
  NSString *temporary = [@".holi-acquisition-" stringByAppendingString:NSUUID.UUID.UUIDString.lowercaseString];
  int fd = openat(directory, temporary.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return HMAFail(error, errno, @"Cannot create acquisition record");
  const uint8_t *cursor = bytes.bytes;
  size_t remaining = bytes.length;
  BOOL ok = YES;
  while (remaining) {
    ssize_t written = write(fd, cursor, remaining);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) { ok = NO; break; }
    cursor += written;
    remaining -= written;
  }
  if (ok) ok = fsync(fd) == 0;
  close(fd);
  if (ok) ok = renameat(directory, temporary.fileSystemRepresentation, directory, ".holi-acquisition.json") == 0 && fsync(directory) == 0;
  // Failed records stay in the owned container. Never remove a path whose
  // contents may have changed after an interrupted write.
  return ok || HMAFail(error, errno ?: EIO, @"Cannot persist acquisition record");
}
static NSDictionary *HMARead(int directory, NSError **error) {
  int fd = openat(directory, ".holi-acquisition.json", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) { HMAFail(error, errno, @"Acquisition record unavailable"); return nil; }
  struct stat before, after;
  BOOL ok = fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_size >= 2 && before.st_size <= 4096;
  NSMutableData *bytes = [NSMutableData data];
  uint8_t buffer[1024];
  while (ok) {
    ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { ok = NO; break; }
    if (!count) break;
    if (bytes.length + (NSUInteger)count > 4096) { ok = NO; break; }
    [bytes appendBytes:buffer length:(NSUInteger)count];
  }
  if (ok) ok = fstat(fd, &after) == 0 && HMASame(&before, &after) && before.st_size == after.st_size && bytes.length == (NSUInteger)before.st_size;
  close(fd);
  id record = ok ? [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil] : nil;
  if (![record isKindOfClass:NSDictionary.class]) { HMAFail(error, EINVAL, @"Invalid acquisition record"); return nil; }
  return record;
}
static BOOL HMAValidate(NSDictionary *record, NSString *container, NSError **error) {
  if (![record[@"version"] isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)record[@"version"]) == CFBooleanGetTypeID() || ![record[@"version"] isEqual:@1] || !HMAUUID(record[@"uuid"]) ||
      !HMAString(record[@"container"]) || ![record[@"container"] isEqual:container] ||
      ![container.lastPathComponent isEqual:[@".holi-acquire-" stringByAppendingString:record[@"uuid"]]] ||
      !HMAString(record[@"target"]) || ![record[@"target"] isAbsolutePath] ||
      ![record[@"rootKey"] isEqual:record[@"target"]] ||
      ![record[@"target"] isEqual:[record[@"target"] stringByStandardizingPath]] ||
      ![container isAbsolutePath] || ![container isEqual:container.stringByStandardizingPath] ||
      ![record[@"stage"] isEqual:[container stringByAppendingPathComponent:@"checkout"]] ||
      ![container.stringByDeletingLastPathComponent isEqual:[record[@"target"] stringByDeletingLastPathComponent]] ||
      !HMAString(record[@"remote"]) || !HMAString(record[@"branch"]) || !HMAString(record[@"runId"]) ||
      ![@[@"prepared", @"before-publication", @"after-publication"] containsObject:record[@"phase"]] ||
      (record[@"nativeId"] && !HMAUUID(record[@"nativeId"])))
    return HMAFail(error, EINVAL, @"Invalid acquisition ownership");
  return YES;
}
static int HMAOpenReceipt(NSDictionary *receipt, NSDictionary **record, NSError **error) {
  NSString *container = receipt[@"containerPath"];
  if (!HMAString(container) || ![container isAbsolutePath]) { HMAFail(error, EINVAL, @"Invalid acquisition receipt"); return -1; }
  int directory = open(container.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  NSDictionary *disk = directory >= 0 ? HMARead(directory, error) : nil;
  NSDictionary *supplied = receipt[@"receipt"];
  BOOL ok = disk && HMAValidate(disk, container, error) && [supplied isKindOfClass:NSDictionary.class] &&
    [receipt[@"stagePath"] isEqual:disk[@"stage"]] && [receipt[@"targetPath"] isEqual:disk[@"target"]] && [receipt[@"rootKey"] isEqual:disk[@"rootKey"]];
  for (NSString *key in @[@"uuid", @"container", @"stage", @"target", @"rootKey", @"remote", @"branch", @"runId"])
    if (!ok) break;
    else if (![supplied[key] isEqual:disk[key]]) ok = NO;
  if (!ok) {
    if (directory >= 0) close(directory);
    HMAFail(error, EPERM, @"Acquisition receipt does not own this stage");
    return -1;
  }
  *record = disk;
  return directory;
}
static BOOL HMASyncTree(int directory, NSUInteger depth, NSUInteger *entries, NSError **error) {
  if (depth > 128) return HMAFail(error, EFBIG, @"Acquisition tree is too deep");
  int scan = dup(directory);
  DIR *stream = scan >= 0 ? fdopendir(scan) : NULL;
  if (!stream) { if (scan >= 0) close(scan); return HMAFail(error, errno, @"Cannot inspect acquisition tree"); }
  BOOL ok = YES;
  struct dirent *entry;
  errno = 0;
  while (ok && (entry = readdir(stream))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++*entries > 100000) { ok = HMAFail(error, EFBIG, @"Acquisition tree exceeds entry bound"); break; }
    struct stat before, opened, after;
    if (fstatat(directory, entry->d_name, &before, AT_SYMLINK_NOFOLLOW) || (!S_ISDIR(before.st_mode) && !S_ISREG(before.st_mode))) {
      ok = HMAFail(error, EINVAL, @"Unsupported acquisition entry"); break;
    }
    int fd = openat(directory, entry->d_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (S_ISDIR(before.st_mode) ? O_DIRECTORY : 0));
    ok = fd >= 0 && fstat(fd, &opened) == 0 && HMASame(&before, &opened);
    if (ok && S_ISDIR(before.st_mode)) ok = HMASyncTree(fd, depth + 1, entries, error);
    if (ok) ok = fsync(fd) == 0 && fstatat(directory, entry->d_name, &after, AT_SYMLINK_NOFOLLOW) == 0 && HMASame(&opened, &after);
    if (fd >= 0) close(fd);
    if (!ok && error && !*error) HMAFail(error, EIO, @"Acquisition entry changed during publication");
    errno = 0;
  }
  if (ok && errno) ok = HMAFail(error, errno, @"Cannot enumerate acquisition tree");
  closedir(stream);
  return ok && (fsync(directory) == 0 || HMAFail(error, errno, @"Cannot persist acquisition directory"));
}
@implementation HoliManagedAcquisition
- (NSString *)rootKeyAtTarget:(NSString *)target error:(NSError **)error {
  if (!HMAString(target) || !target.isAbsolutePath) { HMAFail(error, EINVAL, @"Invalid absolute acquisition target"); return nil; }
  NSString *standard = target.stringByStandardizingPath;
  NSString *leaf = standard.lastPathComponent;
  if (!leaf.length || [leaf isEqual:@"/"]) { HMAFail(error, EINVAL, @"Invalid acquisition target"); return nil; }
  char resolved[PATH_MAX];
  if (realpath(standard.fileSystemRepresentation, resolved)) return [NSString stringWithUTF8String:resolved];
  if (errno != ENOENT || !realpath(standard.stringByDeletingLastPathComponent.fileSystemRepresentation, resolved)) {
    HMAFail(error, errno, @"Acquisition parent unavailable"); return nil;
  }
  return [[NSString stringWithUTF8String:resolved] stringByAppendingPathComponent:leaf];
}
- (NSDictionary *)beginAtTarget:(NSString *)target remote:(NSString *)remote branch:(NSString *)branch runId:(NSString *)runId error:(NSError **)error {
  NSString *key = [self rootKeyAtTarget:target error:error];
  if (!key || !HMAString(remote) || !HMAString(branch) || !HMAString(runId)) { HMAFail(error, EINVAL, @"Invalid acquisition identity"); return nil; }
  struct stat st;
  if (lstat(key.fileSystemRepresentation, &st) == 0 || errno != ENOENT) { HMAFail(error, EEXIST, @"Acquisition target already exists"); return nil; }
  NSString *uuid = NSUUID.UUID.UUIDString.lowercaseString;
  NSString *parent = key.stringByDeletingLastPathComponent;
  NSString *container = [parent stringByAppendingPathComponent:[@".holi-acquire-" stringByAppendingString:uuid]];
  if (mkdir(container.fileSystemRepresentation, 0700)) { HMAFail(error, errno, @"Cannot reserve acquisition stage"); return nil; }
  NSDictionary *record = @{@"version":@1, @"uuid":uuid, @"container":container, @"stage":[container stringByAppendingPathComponent:@"checkout"], @"target":key, @"rootKey":key, @"remote":remote, @"branch":branch, @"runId":runId, @"phase":@"prepared"};
  int directory = open(container.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int parentFD = open(parent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  BOOL ok = directory >= 0 && parentFD >= 0 && HMAWrite(directory, record, error) && fsync(parentFD) == 0;
  if (directory >= 0) close(directory);
  if (parentFD >= 0) close(parentFD);
  if (!ok) { if (error && !*error) HMAFail(error, EIO, @"Cannot persist acquisition stage"); return nil; }
  return @{@"stagePath":record[@"stage"], @"containerPath":container, @"targetPath":key, @"rootKey":key, @"receipt":record};
}
- (BOOL)checkpointReceipt:(NSDictionary *)receipt name:(NSString *)name error:(NSError **)error {
  if (![name isEqual:@"prepared"] && ![name isEqual:@"before-publication"]) return HMAFail(error, EINVAL, @"Publication checkpoint is internal");
  NSDictionary *record = nil;
  int directory = HMAOpenReceipt(receipt, &record, error);
  if (directory < 0) return NO;
  BOOL ok = ![record[@"phase"] isEqual:@"after-publication"];
  NSMutableDictionary *next = [record mutableCopy];
  if ([name isEqual:@"before-publication"]) {
    HoliManagedIdentity *reader = [HoliManagedIdentity new];
    NSDictionary *identity = [reader readIdentityAtRoot:record[@"stage"] error:error];
    ok = ok && identity && [identity[@"remote"] isEqual:record[@"remote"]] && [identity[@"branch"] isEqual:record[@"branch"]] && HMAUUID(identity[@"nativeId"]);
    if (ok && record[@"nativeId"] && ![record[@"nativeId"] isEqual:identity[@"nativeId"]]) ok = NO;
    int stage = ok ? openat(directory, "checkout", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) : -1;
    NSUInteger entries = 0;
    ok = ok && stage >= 0 && HMASyncTree(stage, 0, &entries, error);
    if (stage >= 0) close(stage);
    if (ok) { next[@"nativeId"] = identity[@"nativeId"]; next[@"phase"] = name; }
  }
  if (ok) ok = HMAWrite(directory, next, error);
  close(directory);
  return ok || HMAFail(error, EPERM, @"Acquisition checkpoint identity changed");
}
- (NSDictionary *)finishReceipt:(NSDictionary *)receipt error:(NSError **)error {
  NSDictionary *record = nil;
  int directory = HMAOpenReceipt(receipt, &record, error);
  if (directory < 0) return nil;
  NSString *target = record[@"target"];
  struct stat targetStat;
  BOOL targetExists = lstat(target.fileSystemRepresentation, &targetStat) == 0;
  if (!targetExists && errno != ENOENT) { close(directory); HMAFail(error, errno, @"Cannot inspect publication target"); return nil; }
  HoliManagedIdentity *reader = [HoliManagedIdentity new];
  if (targetExists) {
    NSDictionary *published = [reader readIdentityAtRoot:target error:error];
    if (!record[@"nativeId"] || ![published[@"nativeId"] isEqual:record[@"nativeId"]] || ![published[@"remote"] isEqual:record[@"remote"]] || ![published[@"branch"] isEqual:record[@"branch"]]) {
      close(directory); HMAFail(error, EEXIST, @"Publication target belongs to another checkout"); return nil;
    }
  } else {
    close(directory);
    if (![self checkpointReceipt:receipt name:@"before-publication" error:error]) return nil;
    directory = HMAOpenReceipt(receipt, &record, error);
    if (directory < 0) return nil;
  }
  NSString *parent = target.stringByDeletingLastPathComponent;
  int parentFD = open(parent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat opened, visible;
  BOOL ok = parentFD >= 0 && fstat(directory, &opened) == 0 && fstatat(parentFD, [record[@"container"] lastPathComponent].fileSystemRepresentation, &visible, AT_SYMLINK_NOFOLLOW) == 0 && HMASame(&opened, &visible);
  if (ok && !targetExists) ok = renameatx_np(directory, "checkout", parentFD, target.lastPathComponent.fileSystemRepresentation, RENAME_EXCL) == 0;
  if (ok) ok = fsync(parentFD) == 0;
  if (ok) {
    NSMutableDictionary *next = [record mutableCopy];
    next[@"phase"] = @"after-publication";
    ok = HMAWrite(directory, next, error);
    if (ok) record = next;
  }
  if (parentFD >= 0) close(parentFD);
  close(directory);
  if (!ok) { if (error && !*error) HMAFail(error, errno ?: EIO, @"Acquisition publication failed"); return nil; }
  return @{@"targetPath":target, @"rootKey":target, @"containerPath":record[@"container"], @"stagePath":record[@"stage"], @"receipt":record};
}
- (NSDictionary *)receiptsAtTarget:(NSString *)target error:(NSError **)error {
  NSString *key = [self rootKeyAtTarget:target error:error];
  if (!key) return nil;
  DIR *stream = opendir(key.stringByDeletingLastPathComponent.fileSystemRepresentation);
  if (!stream) { HMAFail(error, errno, @"Cannot inspect acquisition receipts"); return nil; }
  NSMutableArray *receipts = [NSMutableArray array], *refusals = [NSMutableArray array];
  NSUInteger entries = 0;
  struct dirent *entry;
  BOOL ok = YES;
  errno = 0;
  while ((entry = readdir(stream))) {
    if (++entries > 10000) { ok = HMAFail(error, EFBIG, @"Acquisition receipt scan exceeds bound"); break; }
    if (strncmp(entry->d_name, ".holi-acquire-", 14)) continue;
    NSString *name = [NSString stringWithUTF8String:entry->d_name];
    if (!name) continue;
    NSString *container = [key.stringByDeletingLastPathComponent stringByAppendingPathComponent:name];
    int directory = open(container.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    NSDictionary *record = directory >= 0 ? HMARead(directory, nil) : nil;
    if (directory >= 0) close(directory);
    if (![record[@"target"] isEqual:key]) { errno = 0; continue; }
    if (!HMAValidate(record, container, nil)) [refusals addObject:@{@"containerPath":container, @"reason":@"Invalid acquisition ownership"}];
    else [receipts addObject:@{@"containerPath":container, @"stagePath":record[@"stage"], @"targetPath":key, @"rootKey":key, @"receipt":record}];
    errno = 0;
  }
  if (ok && errno) ok = HMAFail(error, errno, @"Cannot enumerate acquisition receipts");
  closedir(stream);
  return ok ? @{@"receipts":receipts, @"refusals":refusals} : nil;
}
@end
