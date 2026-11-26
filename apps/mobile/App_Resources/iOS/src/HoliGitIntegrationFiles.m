#import "HoliGitIntegrationFiles.h"
#import <git2.h>
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>
#import <dirent.h>
#import <errno.h>
#import <string.h>
#import <stdio.h>

static BOOL HGIFail(NSError **error, int code, NSString *message) {
  if (error) *error = [NSError errorWithDomain:@"HoliGitIntegrationFiles" code:code userInfo:@{NSLocalizedDescriptionKey:message}];
  errno = code;
  return NO;
}
static BOOL HGIName(id value) {
  if (![value isKindOfClass:NSString.class] || ![value length] || [value isEqual:@"."] || [value isEqual:@".."] || [value containsString:@"/"]) return NO;
  const char *bytes = [value UTF8String];
  return bytes && strlen(bytes) == [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
}
static BOOL HGIPath(id value) {
  if (![value isKindOfClass:NSString.class] || ![value length] || [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] >= PATH_MAX) return NO;
  for (NSString *part in [value componentsSeparatedByString:@"/"]) if (!HGIName(part)) return NO;
  return YES;
}
static BOOL HGIStable(struct stat a, struct stat b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_nlink == b.st_nlink && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec;
}
static int HGIParent(int root, NSString *path, BOOL create, NSString **leaf, NSError **error) {
  if (!HGIPath(path)) { HGIFail(error, EINVAL, @"Invalid integration path"); return -1; }
  NSArray *parts = [path componentsSeparatedByString:@"/"];
  int fd = dup(root);
  if (fd < 0) { HGIFail(error, errno, @"Cannot retain integration root"); return -1; }
  for (NSUInteger i = 0; i + 1 < parts.count; i++) {
    NSString *part = parts[i];
    int child = openat(fd, part.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (child < 0 && create && errno == ENOENT) {
      if (mkdirat(fd, part.fileSystemRepresentation, 0755) || fsync(fd)) { int saved = errno; close(fd); HGIFail(error, saved, @"Cannot durably create integration directory"); return -1; }
      child = openat(fd, part.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child >= 0 && fsync(child)) { int saved = errno; close(child); close(fd); HGIFail(error, saved, @"Cannot sync integration directory"); return -1; }
    }
    if (child < 0) { int saved = errno; close(fd); HGIFail(error, saved, @"Cannot traverse integration path"); return -1; }
    close(fd); fd = child;
  }
  *leaf = parts.lastObject;
  return fd;
}
static id HGIState(int directory, NSString *name, NSError **error) {
  struct stat named, before, after, finalName;
  if (fstatat(directory, name.fileSystemRepresentation, &named, AT_SYMLINK_NOFOLLOW)) {
    if (errno == ENOENT) return NSNull.null;
    HGIFail(error, errno, @"Cannot inspect integration entry"); return nil;
  }
  if (!S_ISREG(named.st_mode) || named.st_nlink != 1 || named.st_size < 0 || named.st_size > 64 * 1024 * 1024) { HGIFail(error, S_ISDIR(named.st_mode) ? EISDIR : EINVAL, @"Unsupported integration file"); return nil; }
  int fd = openat(directory, name.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) { HGIFail(error, errno, @"Cannot open integration file"); return nil; }
  BOOL ok = fstat(fd, &before) == 0 && HGIStable(named, before);
  NSMutableData *data = [NSMutableData data];
  unsigned char buffer[65536];
  while (ok) {
    ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { ok = NO; break; }
    if (!count) break;
    if (data.length + (NSUInteger)count > (NSUInteger)before.st_size) { ok = NO; break; }
    [data appendBytes:buffer length:(NSUInteger)count];
  }
  ok = ok && fstat(fd, &after) == 0 && HGIStable(before, after) && data.length == (NSUInteger)before.st_size && fstatat(directory, name.fileSystemRepresentation, &finalName, AT_SYMLINK_NOFOLLOW) == 0 && HGIStable(after, finalName);
  close(fd);
  if (!ok) { HGIFail(error, EAGAIN, @"Integration file changed while inspected"); return nil; }
  git_oid oid;
  if (git_odb_hash(&oid, data.bytes, data.length, GIT_OBJECT_BLOB)) { HGIFail(error, EIO, @"Cannot hash integration file"); return nil; }
  return @{ @"oid":[NSString stringWithUTF8String:git_oid_tostr_s(&oid)], @"mode":@((before.st_mode & S_IXUSR) ? 33261 : 33188) };
}
static BOOL HGIValidState(id state) {
  if (state == NSNull.null) return YES;
  if (![state isKindOfClass:NSDictionary.class] || ![state[@"oid"] isKindOfClass:NSString.class] || [state[@"oid"] length] != 40 || ![state[@"mode"] isKindOfClass:NSNumber.class] || ([state[@"mode"] intValue] != 33188 && [state[@"mode"] intValue] != 33261)) return NO;
  git_oid parsed;
  return git_oid_fromstr(&parsed, [state[@"oid"] UTF8String]) == 0;
}
static BOOL HGIExclusive(int from, NSString *source, int to, NSString *name, NSError **error) {
  if (renameatx_np(from, source.fileSystemRepresentation, to, name.fileSystemRepresentation, RENAME_EXCL)) return HGIFail(error, errno, @"Exclusive integration transition refused");
  if (fsync(from) || fsync(to)) return HGIFail(error, errno, @"Integration transition is not durable");
  return YES;
}
static BOOL HGIKnownDirectory(NSString *path, NSArray *changes) {
  NSString *prefix = [path stringByAppendingString:@"/"];
  for (NSDictionary *change in changes) if (change[@"old"] != NSNull.null && change[@"new"] == NSNull.null && [change[@"path"] hasPrefix:prefix]) return YES;
  return NO;
}
static BOOL HGIDirectoryInventory(int fd, NSString *path, NSDictionary *oldPaths, NSError **error) {
  int copy = dup(fd);
  DIR *entries = copy >= 0 ? fdopendir(copy) : NULL;
  if (!entries) { if (copy >= 0) close(copy); return HGIFail(error, errno, @"Cannot enumerate integration obstruction"); }
  BOOL ok = YES;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(entries))) {
    NSString *name = [NSString stringWithUTF8String:entry->d_name];
    if ([name isEqual:@"."] || [name isEqual:@".."]) continue;
    if (!HGIName(name)) { ok = HGIFail(error, EINVAL, @"Invalid obstruction name"); break; }
    NSString *full = [path stringByAppendingFormat:@"/%@", name];
    struct stat st;
    if (fstatat(fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW)) { ok = HGIFail(error, errno, @"Cannot inspect obstruction"); break; }
    if (S_ISDIR(st.st_mode)) {
      BOOL known = NO;
      for (NSString *oldPath in oldPaths) if ([oldPath hasPrefix:[full stringByAppendingString:@"/"]]) { known = YES; break; }
      if (!known) { ok = HGIFail(error, EEXIST, @"Untracked directory obstructs integration"); break; }
      int child = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child < 0) { ok = HGIFail(error, errno, @"Unsafe integration directory"); break; }
      ok = HGIDirectoryInventory(child, full, oldPaths, error); close(child);
      if (!ok) break;
    } else if (!oldPaths[full]) { ok = HGIFail(error, EEXIST, @"Untracked entry obstructs integration"); break; }
    errno = 0;
  }
  if (ok && errno) ok = HGIFail(error, errno, @"Cannot finish obstruction inventory");
  closedir(entries); return ok;
}
static id HGICurrent(int root, NSDictionary *change, NSArray *changes, NSError **error) {
  NSString *leaf = nil;
  NSError *failure = nil;
  int parent = HGIParent(root, change[@"path"], NO, &leaf, &failure);
  if (parent < 0) {
    if (failure.code == ENOENT) return NSNull.null;
    if (failure.code == ENOTDIR && change[@"old"] == NSNull.null) {
      for (NSDictionary *other in changes) if (other[@"old"] != NSNull.null && other[@"new"] == NSNull.null && [change[@"path"] hasPrefix:[other[@"path"] stringByAppendingString:@"/"]]) return NSNull.null;
    }
    if (error) *error = failure; return nil;
  }
  id current = HGIState(parent, leaf, &failure);
  if (!current && failure.code == EISDIR && change[@"old"] == NSNull.null && HGIKnownDirectory(change[@"path"], changes)) {
    NSMutableDictionary *oldPaths = [NSMutableDictionary dictionary];
    for (NSDictionary *other in changes) if (other[@"old"] != NSNull.null && other[@"new"] == NSNull.null) oldPaths[other[@"path"]] = other;
    int directory = openat(parent, leaf.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory >= 0) { if (HGIDirectoryInventory(directory, change[@"path"], oldPaths, &failure)) current = NSNull.null; close(directory); }
  }
  close(parent);
  if (!current && error) *error = failure;
  return current;
}
BOOL HGIPreflightIntegrationFiles(int rootFD, int transactionFD, NSArray<NSDictionary *> *changes, NSError **error) {
  if (![changes isKindOfClass:NSArray.class] || changes.count > 100000) return HGIFail(error, EINVAL, @"Invalid integration changes");
  NSMutableSet *paths = [NSMutableSet set], *artifacts = [NSMutableSet set];
  for (NSDictionary *change in changes) {
    if (![change isKindOfClass:NSDictionary.class] || !HGIPath(change[@"path"]) || !HGIValidState(change[@"old"]) || !HGIValidState(change[@"new"]) || !HGIName(change[@"newArtifact"]) || !HGIName(change[@"oldSlot"]) || [paths containsObject:change[@"path"]]) return HGIFail(error, EINVAL, @"Invalid integration change");
    [paths addObject:change[@"path"]];
    for (NSString *name in @[change[@"newArtifact"], change[@"oldSlot"], [change[@"newArtifact"] stringByAppendingString:@".publish"]]) {
      if ([artifacts containsObject:name]) return HGIFail(error, EINVAL, @"Aliased integration artifact");
      [artifacts addObject:name];
    }
    id current = HGICurrent(rootFD, change, changes, error);
    if (!current) return NO;
    id displaced = HGIState(transactionFD, change[@"oldSlot"], error);
    if (!displaced || (displaced != NSNull.null && ![displaced isEqual:change[@"old"]])) return HGIFail(error, EBUSY, @"Displaced integration image changed");
    BOOL expected = [current isEqual:change[@"old"]] || [current isEqual:change[@"new"]] || (current == NSNull.null && displaced != NSNull.null);
    if (!expected) return HGIFail(error, EBUSY, @"Newer working content prevents integration recovery");
    if (change[@"new"] != NSNull.null && ![current isEqual:change[@"new"]]) {
      id staged = HGIState(transactionFD, change[@"newArtifact"], error);
      if (!staged || staged == NSNull.null || ![staged[@"oid"] isEqual:change[@"new"][@"oid"]]) return HGIFail(error, EBUSY, @"Staged integration image changed");
    }
  }
  return YES;
}
static BOOL HGIPublishImage(int transaction, NSString *artifact, int parent, NSString *leaf, NSDictionary *expected, NSError **error) {
  NSString *temporary = [artifact stringByAppendingString:@".publish"];
  id prepared = HGIState(transaction, temporary, error);
  if (!prepared) return NO;
  if (prepared == NSNull.null) {
    int source = openat(transaction, artifact.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    int output = openat(transaction, temporary.fileSystemRepresentation, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (source < 0 || output < 0) { int saved = errno; if (source >= 0) close(source); if (output >= 0) close(output); return HGIFail(error, saved, @"Cannot stage publication image"); }
    BOOL ok = YES; unsigned char buffer[65536];
    while (ok) {
      ssize_t count = read(source, buffer, sizeof(buffer));
      if (count < 0 && errno == EINTR) continue;
      if (count < 0) { ok = NO; break; }
      if (!count) break;
      ssize_t offset = 0;
      while (offset < count) { ssize_t written = write(output, buffer + offset, (size_t)(count - offset)); if (written < 0 && errno == EINTR) continue; if (written <= 0) { ok = NO; break; } offset += written; }
    }
    ok = ok && fchmod(output, [expected[@"mode"] intValue] == 33261 ? 0755 : 0644) == 0 && fsync(output) == 0;
    int saved = errno; close(source); if (close(output)) ok = NO;
    if (!ok || fsync(transaction)) return HGIFail(error, saved ?: EIO, @"Publication image is not durable");
    prepared = HGIState(transaction, temporary, error);
  }
  if (!prepared || ![prepared isEqual:expected]) return HGIFail(error, EBUSY, @"Publication image does not match target");
  return HGIExclusive(transaction, temporary, parent, leaf, error);
}
static BOOL HGIRemoveOldDirectories(int root, NSArray *changes, NSError **error) {
  NSMutableSet *directories = [NSMutableSet set];
  for (NSDictionary *change in changes) if (change[@"old"] != NSNull.null && change[@"new"] == NSNull.null) {
    NSArray *parts = [change[@"path"] componentsSeparatedByString:@"/"];
    for (NSUInteger i = 1; i < parts.count; i++) [directories addObject:[[parts subarrayWithRange:NSMakeRange(0, i)] componentsJoinedByString:@"/"]];
  }
  NSArray *ordered = [directories.allObjects sortedArrayUsingComparator:^NSComparisonResult(NSString *a, NSString *b) { return a.length > b.length ? NSOrderedAscending : a.length < b.length ? NSOrderedDescending : [a compare:b]; }];
  for (NSString *path in ordered) {
    NSString *leaf = nil; NSError *failure = nil;
    int parent = HGIParent(root, path, NO, &leaf, &failure);
    if (parent < 0) { if (failure.code == ENOENT || failure.code == ENOTDIR) continue; if (error) *error = failure; return NO; }
    struct stat st;
    if (fstatat(parent, leaf.fileSystemRepresentation, &st, AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(st.st_mode)) {
      if (unlinkat(parent, leaf.fileSystemRepresentation, AT_REMOVEDIR) && errno != ENOTEMPTY && errno != EEXIST) { int saved = errno; close(parent); return HGIFail(error, saved, @"Cannot remove old empty directory"); }
      if (fsync(parent)) { int saved = errno; close(parent); return HGIFail(error, saved, @"Old directory transition is not durable"); }
    }
    close(parent);
  }
  return YES;
}
BOOL HGIApplyIntegrationFiles(int rootFD, int transactionFD, NSArray<NSDictionary *> *changes, NSError **error) {
  if (!HGIPreflightIntegrationFiles(rootFD, transactionFD, changes, error)) return NO;
  NSArray *ordered = [changes sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
    BOOL ad = a[@"new"] == NSNull.null, bd = b[@"new"] == NSNull.null;
    if (ad != bd) return ad ? NSOrderedAscending : NSOrderedDescending;
    return [a[@"path"] compare:b[@"path"]];
  }];
  BOOL directoriesHandled = NO;
  for (NSDictionary *change in ordered) {
    if (change[@"new"] != NSNull.null && !directoriesHandled) { if (!HGIRemoveOldDirectories(rootFD, changes, error)) return NO; directoriesHandled = YES; }
    NSString *leaf = nil; NSError *failure = nil;
    int parent = HGIParent(rootFD, change[@"path"], change[@"new"] != NSNull.null, &leaf, &failure);
    if (parent < 0) { if (change[@"new"] == NSNull.null && (failure.code == ENOENT || failure.code == ENOTDIR)) continue; if (error) *error = failure; return NO; }
    id current = HGIState(parent, leaf, error);
    if (!current) { close(parent); return NO; }
    if ([current isEqual:change[@"new"]]) { close(parent); continue; }
    if ([current isEqual:change[@"old"]] && current != NSNull.null) {
      if (!HGIExclusive(parent, leaf, transactionFD, change[@"oldSlot"], error)) { close(parent); return NO; }
      id displaced = HGIState(transactionFD, change[@"oldSlot"], error);
      if (!displaced || ![displaced isEqual:change[@"old"]]) {
        NSError *restoreError = nil;
        HGIExclusive(transactionFD, change[@"oldSlot"], parent, leaf, &restoreError);
        close(parent); return HGIFail(error, EBUSY, @"Displaced newer content retained; integration refused");
      }
      current = NSNull.null;
    }
    if (current != NSNull.null) { close(parent); return HGIFail(error, EBUSY, @"New working entry prevents publication"); }
    if (change[@"new"] != NSNull.null && !HGIPublishImage(transactionFD, change[@"newArtifact"], parent, leaf, change[@"new"], error)) { close(parent); return NO; }
    id after = HGIState(parent, leaf, error); close(parent);
    if (!after || ![after isEqual:change[@"new"]]) return HGIFail(error, EBUSY, @"Published integration state changed");
  }
  return directoriesHandled || HGIRemoveOldDirectories(rootFD, changes, error);
}
