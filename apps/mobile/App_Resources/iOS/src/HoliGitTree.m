#import "HoliGitSafety.h"
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>
#import <errno.h>
#import <dirent.h>

@implementation HoliNativeGit (TreePreparation)
static BOOL HNGTreeFail(NSError **error, NSString *message) {
  if (error) *error = HNGPathError(EINVAL, message);
  return NO;
}
static BOOL HNGTreeCollectNames(int fd, NSString *prefix, NSMutableSet<NSString *> *names, NSUInteger depth, NSError **error) {
  if (depth > 64 || names.count > 10000) return HNGTreeFail(error, @"Working tree exceeds traversal limits");
  int copy = dup(fd);
  DIR *dir = copy >= 0 ? fdopendir(copy) : NULL;
  if (!dir) { if (copy >= 0) close(copy); return HNGTreeFail(error, @"Cannot enumerate working tree"); }
  struct dirent *entry;
  BOOL ok = YES;
  while ((entry = readdir(dir))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..") || !strcmp(entry->d_name, ".git")) continue;
    NSString *part = [NSString stringWithUTF8String:entry->d_name];
    if (!part) { ok = NO; break; }
    NSString *path = prefix.length ? [prefix stringByAppendingFormat:@"/%@", part] : part;
    struct stat st;
    if (fstatat(fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW)) { ok = NO; break; }
    if (S_ISDIR(st.st_mode)) {
      int child = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child < 0) { ok = NO; break; }
      ok = HNGTreeCollectNames(child, path, names, depth + 1, error);
      close(child);
    } else [names addObject:path];
    if (!ok || names.count > 10000) { ok = NO; break; }
  }
  if (errno) ok = NO;
  closedir(dir);
  return ok ? YES : HNGTreeFail(error, @"Working tree traversal failed or exceeded limits");
}
static BOOL HNGTreeSameFile(struct stat a, struct stat b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode == b.st_mode && a.st_size == b.st_size && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec;
}
static NSSet<NSString *> *HNGLooseObjects(NSString *snapshot) {
  NSString *objects = [snapshot stringByAppendingPathComponent:@".git/objects"];
  NSMutableSet *names = [NSMutableSet set];
  NSCharacterSet *notHex = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
  for (NSString *directory in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:objects error:nil]) {
    if (directory.length != 2 || [directory rangeOfCharacterFromSet:notHex].location != NSNotFound) continue;
    for (NSString *file in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:[objects stringByAppendingPathComponent:directory] error:nil]) {
      if (file.length == 38 && [file rangeOfCharacterFromSet:notHex].location == NSNotFound) [names addObject:[directory stringByAppendingPathComponent:file]];
    }
  }
  return names;
}
// These are private, bounded snapshots; omit only object bytes, which preparation may add.
static NSDictionary *HNGTreeMetadata(NSString *snapshot) {
  NSString *git = [snapshot stringByAppendingPathComponent:@".git"];
  NSMutableDictionary *metadata = [NSMutableDictionary dictionary];
  NSDirectoryEnumerator *scan = [[NSFileManager defaultManager] enumeratorAtPath:git];
  NSString *name;
  while ((name = scan.nextObject)) {
    if ([name isEqualToString:@"objects"]) { [scan skipDescendants]; continue; }
    if ([name.pathExtension isEqualToString:@"lock"]) return nil;
    BOOL directory = NO;
    NSString *full = [git stringByAppendingPathComponent:name];
    if (![[NSFileManager defaultManager] fileExistsAtPath:full isDirectory:&directory]) return nil;
    if (!directory) {
      NSData *bytes = [NSData dataWithContentsOfFile:full];
      if (!bytes) return nil;
      metadata[name] = bytes;
    }
  }
  return metadata;
}
static BOOL HNGInstallTreeObjects(NSString *snapshot, NSSet *before, int rootFD, git_repository *repo, NSError **error) {
  int gitFD = openat(rootFD, ".git", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  int objectsFD = gitFD >= 0 ? openat(gitFD, "objects", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) : -1;
  if (gitFD >= 0) close(gitFD);
  if (objectsFD < 0) return HNGTreeFail(error, @"Cannot open object database safely");
  BOOL ok = YES;
  NSUInteger total = 0;
  git_odb *odb = NULL;
  if (git_repository_odb(&odb, repo) < 0) ok = HNGTreeFail(error, @"Cannot inspect prepared objects");
  for (NSString *relative in HNGLooseObjects(snapshot)) {
    if (!ok) break;
    if ([before containsObject:relative]) continue;
    NSString *oidText = [relative stringByReplacingOccurrencesOfString:@"/" withString:@""];
    git_oid oid, verified;
    git_odb_object *object = NULL;
    int rc = git_oid_fromstr(&oid, oidText.UTF8String);
    if (rc == 0) rc = git_odb_read(&object, odb, &oid);
    if (rc == 0 && git_odb_object_size(object) > 64 * 1024 * 1024) rc = GIT_ERROR;
    if (rc == 0) rc = git_odb_hash(&verified, git_odb_object_data(object), git_odb_object_size(object), git_odb_object_type(object));
    if (rc == 0 && !git_oid_equal(&oid, &verified)) rc = GIT_ERROR;
    git_odb_object_free(object);
    if (rc < 0) { ok = HNGTreeFail(error, @"Prepared object failed verification"); break; }
    NSData *bytes = [NSData dataWithContentsOfFile:[[snapshot stringByAppendingPathComponent:@".git/objects"] stringByAppendingPathComponent:relative]];
    if (!bytes || bytes.length > 64 * 1024 * 1024 || (total += bytes.length) > 512 * 1024 * 1024) { ok = HNGTreeFail(error, @"Prepared objects exceed limits"); break; }
    NSString *directory = relative.stringByDeletingLastPathComponent;
    NSString *name = relative.lastPathComponent;
    if (mkdirat(objectsFD, directory.UTF8String, 0700) && errno != EEXIST) { ok = HNGTreeFail(error, @"Cannot create object directory"); break; }
    int target = openat(objectsFD, directory.UTF8String, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (target < 0) { ok = HNGTreeFail(error, @"Unsafe object directory"); break; }
    // linkat publishes a complete immutable object without replacing any existing name.
    NSString *temporary = [@"holi-tree-" stringByAppendingString:NSUUID.UUID.UUIDString];
    int output = openat(target, temporary.UTF8String, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0444);
    if (output < 0) ok = HNGTreeFail(error, @"Cannot create owned object temporary");
    NSUInteger offset = 0;
    while (ok && offset < bytes.length) {
      ssize_t wrote = write(output, (const uint8_t *)bytes.bytes + offset, bytes.length - offset);
      if (wrote <= 0) ok = HNGTreeFail(error, @"Cannot write prepared object");
      else offset += (NSUInteger)wrote;
    }
    if (ok && fsync(output)) ok = HNGTreeFail(error, @"Cannot flush prepared object");
    if (output >= 0) close(output);
    if (ok && linkat(target, temporary.UTF8String, target, name.UTF8String, 0)) {
      if (errno != EEXIST) ok = HNGTreeFail(error, @"Cannot publish prepared object");
      else {
        int existing = openat(target, name.UTF8String, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
        struct stat st;
        if (existing < 0 || fstat(existing, &st) || !S_ISREG(st.st_mode) || st.st_size != (off_t)bytes.length) ok = HNGTreeFail(error, @"Existing object is unsafe or differs");
        uint8_t buffer[16384]; NSUInteger compared = 0;
        while (ok && compared < bytes.length) {
          ssize_t n = read(existing, buffer, MIN(sizeof(buffer), bytes.length - compared));
          if (n <= 0 || memcmp(buffer, (const uint8_t *)bytes.bytes + compared, (size_t)n)) ok = HNGTreeFail(error, @"Existing object differs");
          else compared += (NSUInteger)n;
        }
        if (existing >= 0) close(existing);
      }
    }
    if (output >= 0 && unlinkat(target, temporary.UTF8String, 0)) ok = HNGTreeFail(error, @"Cannot remove owned object temporary");
    if (ok && fsync(target)) ok = HNGTreeFail(error, @"Cannot flush object directory");
    close(target);
  }
  git_odb_free(odb);
  if (ok && fsync(objectsFD)) ok = HNGTreeFail(error, @"Cannot flush object database");
  close(objectsFD);
  return ok;
}
- (NSDictionary<NSString *, id> *)prepareWorkingCopyTree:(NSString *)root remote:(NSString *)remote branch:(NSString *)branch policy:(NSInteger (^)(NSString *))policy error:(NSError **)error {
  HoliGitSnapshot *snapshot = nil;
  git_repository *repo = [self openSafeRepository:root snapshot:&snapshot error:error];
  if (!repo) return nil;
  git_index *original = NULL, *prepared = NULL;
  git_reference *head = NULL;
  git_remote *origin = NULL;
  git_commit *commit = NULL;
  git_tree *tree = NULL;
  git_config *config = NULL;
  int rootFD = -1;
  NSDictionary *result = nil;
  do {
    int rc = git_repository_head(&head, repo);
    if (rc == 0) rc = git_remote_lookup(&origin, repo, "origin");
    NSString *url = origin && git_remote_url(origin) ? [NSString stringWithUTF8String:git_remote_url(origin)] : @"";
    NSString *https = [@"https://github.com/" stringByAppendingString:remote];
    NSString *ssh = [@"git@github.com:" stringByAppendingString:remote];
    BOOL remoteMatches = [url isEqualToString:https] || [url isEqualToString:[https stringByAppendingString:@".git"]] || [url isEqualToString:ssh] || [url isEqualToString:[ssh stringByAppendingString:@".git"]];
    if (rc < 0 || !git_reference_is_branch(head) || !branch.length || ![branch isEqualToString:[NSString stringWithUTF8String:git_reference_shorthand(head)]] || !remoteMatches || git_repository_state(repo) != GIT_REPOSITORY_STATE_NONE) { HNGTreeFail(error, @"Tree preparation identity or repository state mismatch"); break; }
    rc = git_repository_index(&original, repo);
    if (rc < 0 || git_index_has_conflicts(original)) { HNGTreeFail(error, @"Tree preparation refuses conflicted indexes"); break; }
    BOOL valid = YES;
    for (size_t i = 0; i < git_index_entrycount(original); i++) {
      const git_index_entry *entry = git_index_get_byindex(original, i);
      if (!entry || (entry->flags & GIT_INDEX_ENTRY_VALID) || (entry->flags_extended & (GIT_INDEX_ENTRY_SKIP_WORKTREE | GIT_INDEX_ENTRY_INTENT_TO_ADD)) || (entry->mode != GIT_FILEMODE_BLOB && entry->mode != GIT_FILEMODE_BLOB_EXECUTABLE)) { valid = NO; break; }
    }
    if (!valid) { HNGTreeFail(error, @"Unsupported tree preparation index state"); break; }
    rc = git_reference_peel((git_object **)&commit, head, GIT_OBJECT_COMMIT);
    if (rc == 0) rc = git_commit_tree(&tree, commit);
    if (rc == 0) rc = git_repository_config(&config, repo);
    const char *unsupported[] = {"core.autocrlf", "core.eol", "core.attributesfile", "core.excludesfile"};
    for (NSUInteger i = 0; rc == 0 && i < 4; i++) {
      git_config_entry *setting = NULL;
      int found = git_config_get_entry(&setting, config, unsupported[i]);
      git_config_entry_free(setting);
      if (found != GIT_ENOTFOUND) rc = GIT_ERROR;
    }
    if (rc < 0 || !policy) { HNGTreeFail(error, @"Unsupported tree preparation configuration or missing policy"); break; }
    NSDictionary *metadata = HNGTreeMetadata(snapshot.path);
    NSSet *objectsBefore = HNGLooseObjects(snapshot.path);
    if (!metadata) { HNGTreeFail(error, @"Existing metadata lock or unreadable metadata"); break; }
    rootFD = open(root.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (rootFD < 0) { HNGTreeFail(error, @"Cannot open tree preparation root"); break; }
    // Enumerate candidates before reading content; the caller's pure policy excludes private
    // paths and subtrees at the native boundary.
    NSMutableSet<NSString *> *candidateNames = [NSMutableSet set];
    if (!HNGTreeCollectNames(rootFD, @"", candidateNames, 0, error)) break;
    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    for (NSString *candidate in candidateNames) {
      NSInteger decision = policy(candidate);
      if (decision < -1 || decision > 1 || decision == -1) { HNGTreeFail(error, @"Working tree policy refused an invalid path"); valid = NO; break; }
      if (decision == 1) [paths addObject:candidate];
    }
    if (!valid || paths.count > 10000) { HNGTreeFail(error, @"Working tree exceeds policy or path limits"); break; }
    if (!HNGPrepareIgnores(repo, snapshot, rootFD, paths, error)) break;
    rc = git_index_new(&prepared);
    if (rc < 0) { HNGError(error, rc); break; }
    NSMutableSet *names = [NSMutableSet set];
    NSUInteger total = 0;
    for (NSString *path in paths) {
      NSArray *parts = nil;
      NSString *folded = path.precomposedStringWithCanonicalMapping.lowercaseString;
      if (!HNGPathParts(path, &parts) || [names containsObject:folded]) { valid = HNGTreeFail(error, @"Invalid or case-ambiguous tree path"); break; }
      [names addObject:folded];
      const git_index_entry *tracked = git_index_get_bypath(original, path.fileSystemRepresentation, 0);
      if (tracked && strcmp(tracked->path, path.fileSystemRepresentation)) { valid = HNGTreeFail(error, @"Case-only staged renames are unsupported"); break; }
      git_tree_entry *old = NULL;
      int lookup = git_tree_entry_bypath(&old, tree, path.fileSystemRepresentation);
      if (lookup != 0 && lookup != GIT_ENOTFOUND) { valid = HNGTreeFail(error, @"Cannot inspect parent tree"); break; }
      BOOL inHead = old && git_tree_entry_type(old) != GIT_OBJECT_TREE;
      if (inHead && git_tree_entry_filemode(old) != GIT_FILEMODE_BLOB && git_tree_entry_filemode(old) != GIT_FILEMODE_BLOB_EXECUTABLE) valid = HNGTreeFail(error, @"Unsupported parent tree entry");
      git_tree_entry_free(old);
      if (!valid) break;
      if (!tracked && !inHead) {
        int ignored = 0;
        if (git_ignore_path_is_ignored(&ignored, repo, path.fileSystemRepresentation) < 0) { valid = HNGTreeFail(error, @"Cannot evaluate ignore rules"); break; }
        if (ignored) continue;
      }
      int parent = HNGOpenParent(rootFD, parts);
      int saved = errno;
      struct stat before, opened, after;
      int inspected = parent >= 0 ? fstatat(parent, [parts.lastObject fileSystemRepresentation], &before, AT_SYMLINK_NOFOLLOW) : -1;
      if (inspected < 0) {
        saved = parent < 0 ? saved : errno;
        if (parent >= 0) close(parent);
        if (saved == ENOENT || saved == ENOTDIR) continue;
        valid = HNGTreeFail(error, @"Cannot inspect tree entry"); break;
      }
      if (S_ISDIR(before.st_mode)) { close(parent); continue; }
      if (!S_ISREG(before.st_mode) || before.st_size < 0 || before.st_size > 64 * 1024 * 1024 || total + before.st_size > 512 * 1024 * 1024) { close(parent); valid = HNGTreeFail(error, @"Unsupported or oversized tree entry"); break; }
      int input = openat(parent, [parts.lastObject fileSystemRepresentation], O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
      if (input < 0 || fstat(input, &opened) || !HNGTreeSameFile(before, opened)) { if (input >= 0) close(input); close(parent); valid = HNGTreeFail(error, @"Tree entry changed before reading"); break; }
      NSMutableData *bytes = [NSMutableData data];
      uint8_t buffer[16384]; ssize_t count;
      while ((count = read(input, buffer, sizeof(buffer))) > 0) {
        if (bytes.length + (NSUInteger)count > (NSUInteger)before.st_size) { valid = NO; break; }
        [bytes appendBytes:buffer length:(NSUInteger)count];
      }
      if (count < 0 || bytes.length != (NSUInteger)before.st_size || fstat(input, &after) || !HNGTreeSameFile(before, after) || fstatat(parent, [parts.lastObject fileSystemRepresentation], &after, AT_SYMLINK_NOFOLLOW) || !HNGTreeSameFile(before, after)) valid = NO;
      close(input); close(parent);
      if (!valid) { HNGTreeFail(error, @"Tree entry changed while reading"); break; }
      total += bytes.length;
      git_index_entry entry = {0};
      entry.path = path.fileSystemRepresentation;
      entry.mode = (before.st_mode & S_IXUSR) ? GIT_FILEMODE_BLOB_EXECUTABLE : GIT_FILEMODE_BLOB;
      rc = git_blob_create_frombuffer(&entry.id, repo, bytes.bytes, bytes.length);
      if (rc == 0) rc = git_index_add(prepared, &entry);
      if (rc < 0) { HNGError(error, rc); valid = NO; break; }
    }
    if (!valid) break;
    git_oid treeOID;
    rc = git_index_write_tree_to(&treeOID, prepared, repo);
    if (rc < 0) { HNGError(error, rc); break; }
    HoliGitSnapshot *verification = [[HoliGitSnapshot alloc] initWithRoot:root error:error];
    BOOL unchangedMetadata = verification && [metadata isEqualToDictionary:HNGTreeMetadata(verification.path)];
    BOOL closed = [verification closeWithError:error];
    if (!unchangedMetadata || !closed) { HNGTreeFail(error, @"Repository changed during tree preparation"); break; }
    if (!HNGInstallTreeObjects(snapshot.path, objectsBefore, rootFD, repo, error)) break;
    char treeText[GIT_OID_HEXSZ + 1], parentText[GIT_OID_HEXSZ + 1];
    git_oid_tostr(treeText, sizeof(treeText), &treeOID);
    git_oid_tostr(parentText, sizeof(parentText), git_commit_id(commit));
    result = @{@"treeOID": [NSString stringWithUTF8String:treeText], @"parentOID": [NSString stringWithUTF8String:parentText], @"branch": branch, @"unchanged": @(git_oid_equal(&treeOID, git_tree_id(tree)))};
  } while (0);
  if (rootFD >= 0) close(rootFD);
  git_config_free(config); git_tree_free(tree); git_commit_free(commit); git_remote_free(origin); git_reference_free(head); git_index_free(original); git_index_free(prepared); git_repository_free(repo);
  if (![snapshot closeWithError:error]) return nil;
  return result;
}

@end
