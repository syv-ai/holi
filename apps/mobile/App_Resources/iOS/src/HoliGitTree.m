#import "HoliGitSafety.h"
#import <sys/stat.h>
#import <fcntl.h>
#import <unistd.h>
#import <errno.h>
#import <dirent.h>

static BOOL HNGTreeFail(NSError **error, NSString *message) {
  if (error) *error = HNGPathError(EINVAL, message);
  return NO;
}
static NSDictionary *HNGTreeFileIdentity(struct stat st) {
  return @{@"dev":@(st.st_dev), @"ino":@(st.st_ino), @"mode":@(st.st_mode), @"size":@(st.st_size), @"mtime":@(st.st_mtimespec.tv_sec), @"mtimeNS":@(st.st_mtimespec.tv_nsec), @"ctime":@(st.st_ctimespec.tv_sec), @"ctimeNS":@(st.st_ctimespec.tv_nsec)};
}
static BOOL HNGTreeDecision(NSString *path, NSInteger (^policy)(NSString *), BOOL *include, NSError **error) {
  NSInteger value = policy(path);
  if (value != 0 && value != 1) return HNGTreeFail(error, @"Invalid working-tree path");
  *include = value == 1;
  return YES;
}
// Metadata only. Excluded subtrees are pruned before opening or enumerating them.
static BOOL HNGTreeInventory(int fd, NSString *prefix, NSMutableDictionary *records, NSInteger (^policy)(NSString *), NSUInteger *visits, NSUInteger depth, NSError **error) {
  if (depth > 64) return HNGTreeFail(error, @"Working tree exceeds depth limit");
  int copy = dup(fd);
  DIR *dir = copy >= 0 ? fdopendir(copy) : NULL;
  if (!dir) { if (copy >= 0) close(copy); return HNGTreeFail(error, @"Cannot enumerate working tree"); }
  BOOL ok = YES;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(dir);
    if (!entry) { if (errno) ok = HNGTreeFail(error, @"Cannot enumerate working tree"); break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..") || !strcmp(entry->d_name, ".git")) continue;
    if (++*visits > 10000) { ok = HNGTreeFail(error, @"Working tree exceeds entry limit"); break; }
    NSString *part = [NSString stringWithUTF8String:entry->d_name];
    if (!part) { ok = HNGTreeFail(error, @"Invalid working-tree filename"); break; }
    NSString *path = prefix.length ? [prefix stringByAppendingFormat:@"/%@", part] : part;
    BOOL include = NO;
    if (!HNGTreeDecision(path, policy, &include, error)) { ok = NO; break; }
    if (!include) continue;
    struct stat before, opened, after;
    if (fstatat(fd, entry->d_name, &before, AT_SYMLINK_NOFOLLOW)) { ok = HNGTreeFail(error, @"Cannot inspect working-tree entry"); break; }
    records[path] = HNGTreeFileIdentity(before);
    if (S_ISDIR(before.st_mode)) {
      int child = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      ok = child >= 0 && !fstat(child, &opened) && [HNGTreeFileIdentity(before) isEqualToDictionary:HNGTreeFileIdentity(opened)];
      if (ok) ok = HNGTreeInventory(child, path, records, policy, visits, depth + 1, error);
      if (child >= 0) close(child);
      if (ok) ok = !fstatat(fd, entry->d_name, &after, AT_SYMLINK_NOFOLLOW) && [HNGTreeFileIdentity(before) isEqualToDictionary:HNGTreeFileIdentity(after)];
      if (!ok) { HNGTreeFail(error, @"Working-tree directory changed during enumeration"); break; }
    }
  }
  closedir(dir);
  return ok;
}
static NSData *HNGTreeRead(int rootFD, NSString *path, NSDictionary *identity, NSUInteger *total, NSError **error) {
  NSArray *parts = nil;
  if (!HNGPathParts(path, &parts)) { HNGTreeFail(error, @"Invalid tree path"); return nil; }
  int parent = HNGOpenParent(rootFD, parts);
  int fd = parent >= 0 ? openat(parent, [parts.lastObject fileSystemRepresentation], O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) : -1;
  struct stat before, after;
  BOOL ok = fd >= 0 && !fstat(fd, &before) && S_ISREG(before.st_mode) && [identity isEqualToDictionary:HNGTreeFileIdentity(before)];
  NSUInteger limit = [path.lastPathComponent isEqualToString:@".gitignore"] ? 1024 * 1024 : 64 * 1024 * 1024;
  if (ok) ok = before.st_size >= 0 && before.st_size <= (off_t)limit && *total + before.st_size <= 512 * 1024 * 1024;
  NSMutableData *data = [NSMutableData data];
  uint8_t buffer[16384];
  while (ok) {
    ssize_t n = read(fd, buffer, sizeof(buffer));
    if (n < 0) { ok = NO; break; }
    if (!n) break;
    if (data.length + (NSUInteger)n > (NSUInteger)before.st_size) { ok = NO; break; }
    [data appendBytes:buffer length:(NSUInteger)n];
  }
  if (ok) ok = data.length == (NSUInteger)before.st_size && !fstat(fd, &after) && [identity isEqualToDictionary:HNGTreeFileIdentity(after)] && !fstatat(parent, [parts.lastObject fileSystemRepresentation], &after, AT_SYMLINK_NOFOLLOW) && [identity isEqualToDictionary:HNGTreeFileIdentity(after)];
  if (fd >= 0) close(fd);
  if (parent >= 0) close(parent);
  if (!ok) { HNGTreeFail(error, @"Working-tree file changed or exceeds limits"); return nil; }
  *total += data.length;
  return data;
}
static BOOL HNGTreeObjectValid(git_repository *repo, const git_oid *oid, git_object_t type, NSError **error) {
  git_odb *odb = NULL;
  git_odb_object *object = NULL;
  git_oid actual;
  int rc = git_repository_odb(&odb, repo);
  if (rc == 0) rc = git_odb_read(&object, odb, oid);
  if (rc == 0 && (git_odb_object_type(object) != type || git_odb_object_size(object) > 64 * 1024 * 1024)) rc = GIT_ERROR;
  if (rc == 0) rc = git_odb_hash(&actual, git_odb_object_data(object), git_odb_object_size(object), type);
  if (rc == 0 && !git_oid_equal(&actual, oid)) rc = GIT_ERROR;
  git_odb_object_free(object); git_odb_free(odb);
  return rc == 0 ? YES : HNGTreeFail(error, @"Git object is missing, corrupt or unsupported");
}
static NSString *HNGTreeOID(const git_oid *oid) {
  char text[GIT_OID_HEXSZ + 1]; git_oid_tostr(text, sizeof(text), oid);
  return [NSString stringWithUTF8String:text];
}
static BOOL HNGTreeParentPaths(git_repository *repo, git_tree *tree, NSString *prefix, NSMutableSet *paths, NSInteger (^policy)(NSString *), NSUInteger *visits, NSUInteger depth, NSError **error) {
  if (depth > 64) return HNGTreeFail(error, @"Parent tree exceeds depth limit");
  if (!HNGTreeObjectValid(repo, git_tree_id(tree), GIT_OBJECT_TREE, error)) return NO;
  for (size_t i = 0; i < git_tree_entrycount(tree); i++) {
    if (++*visits > 10000) return HNGTreeFail(error, @"Parent tree exceeds entry limit");
    const git_tree_entry *entry = git_tree_entry_byindex(tree, i);
    NSString *name = [NSString stringWithUTF8String:git_tree_entry_name(entry)];
    if (!name) return HNGTreeFail(error, @"Invalid parent-tree filename");
    NSString *path = prefix.length ? [prefix stringByAppendingFormat:@"/%@", name] : name;
    BOOL include = NO;
    if (!HNGTreeDecision(path, policy, &include, error)) return NO;
    if (!include) continue;
    if (git_tree_entry_type(entry) == GIT_OBJECT_TREE) {
      git_tree *child = NULL;
      int rc = git_tree_lookup(&child, repo, git_tree_entry_id(entry));
      BOOL ok = rc == 0 && HNGTreeParentPaths(repo, child, path, paths, policy, visits, depth + 1, error);
      git_tree_free(child);
      if (!ok) return HNGTreeFail(error, @"Cannot inspect parent tree");
    } else {
      if (git_tree_entry_filemode(entry) != GIT_FILEMODE_BLOB && git_tree_entry_filemode(entry) != GIT_FILEMODE_BLOB_EXECUTABLE) return HNGTreeFail(error, @"Unsupported parent-tree entry");
      [paths addObject:path];
    }
  }
  return YES;
}
static BOOL HNGTreeVerifyPlan(git_repository *repo, const git_oid *oid, NSString *prefix, NSDictionary *plan, NSMutableSet *seen, NSUInteger depth, NSError **error) {
  if (depth > 64) return HNGTreeFail(error, @"Prepared tree exceeds depth limit");
  if (!HNGTreeObjectValid(repo, oid, GIT_OBJECT_TREE, error)) return NO;
  git_tree *tree = NULL;
  if (git_tree_lookup(&tree, repo, oid) < 0) return HNGTreeFail(error, @"Cannot read prepared tree");
  BOOL ok = YES;
  for (size_t i = 0; ok && i < git_tree_entrycount(tree); i++) {
    const git_tree_entry *entry = git_tree_entry_byindex(tree, i);
    NSString *name = [NSString stringWithUTF8String:git_tree_entry_name(entry)];
    if (!name) { ok = NO; break; }
    NSString *path = prefix.length ? [prefix stringByAppendingFormat:@"/%@", name] : name;
    if (git_tree_entry_type(entry) == GIT_OBJECT_TREE) ok = HNGTreeVerifyPlan(repo, git_tree_entry_id(entry), path, plan, seen, depth + 1, error);
    else {
      NSDictionary *expected = plan[path];
      ok = expected && ![seen containsObject:path] && [expected[@"oid"] isEqualToString:HNGTreeOID(git_tree_entry_id(entry))] && [expected[@"mode"] unsignedIntValue] == git_tree_entry_filemode(entry) && HNGTreeObjectValid(repo, git_tree_entry_id(entry), GIT_OBJECT_BLOB, error);
      if (ok) [seen addObject:path];
    }
    if (seen.count > 10000) ok = NO;
  }
  git_tree_free(tree);
  return ok ? YES : HNGTreeFail(error, @"Prepared tree differs from captured bytes and modes");
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

@implementation HoliNativeGit (TreePreparation)
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
    if (rc < 0 || !policy || !git_reference_is_branch(head) || !branch.length || ![branch isEqualToString:[NSString stringWithUTF8String:git_reference_shorthand(head)]] || !remoteMatches || git_repository_state(repo) != GIT_REPOSITORY_STATE_NONE) { HNGTreeFail(error, @"Tree preparation identity or repository state mismatch"); break; }
    rc = git_repository_index(&original, repo);
    if (rc < 0 || git_index_has_conflicts(original) || git_index_entrycount(original) > 10000) { HNGTreeFail(error, @"Unsupported or conflicted index"); break; }
    BOOL valid = YES;
    NSMutableSet *trackedPaths = [NSMutableSet set];
    for (size_t i = 0; i < git_index_entrycount(original); i++) {
      const git_index_entry *entry = git_index_get_byindex(original, i);
      NSString *path = entry && entry->path ? [NSString stringWithUTF8String:entry->path] : nil;
      BOOL include = NO;
      if (!path || !HNGTreeDecision(path, policy, &include, error) || (entry->flags & GIT_INDEX_ENTRY_VALID) || (entry->flags_extended & (GIT_INDEX_ENTRY_SKIP_WORKTREE | GIT_INDEX_ENTRY_INTENT_TO_ADD)) || (entry->mode != GIT_FILEMODE_BLOB && entry->mode != GIT_FILEMODE_BLOB_EXECUTABLE)) { valid = NO; break; }
      if (include) [trackedPaths addObject:path];
    }
    if (!valid) { HNGTreeFail(error, @"Unsupported index path or state"); break; }
    rc = git_reference_peel((git_object **)&commit, head, GIT_OBJECT_COMMIT);
    if (rc == 0) rc = git_commit_tree(&tree, commit);
    if (rc < 0 || !HNGTreeObjectValid(repo, git_commit_id(commit), GIT_OBJECT_COMMIT, error)) break;
    NSUInteger visits = 0;
    if (!HNGTreeParentPaths(repo, tree, @"", trackedPaths, policy, &visits, 0, error)) break;
    rc = git_repository_config(&config, repo);
    const char *unsupported[] = {"core.autocrlf", "core.eol", "core.attributesfile", "core.excludesfile"};
    for (NSUInteger i = 0; rc == 0 && i < 4; i++) {
      git_config_entry *setting = NULL;
      int found = git_config_get_entry(&setting, config, unsupported[i]);
      git_config_entry_free(setting);
      if (found != GIT_ENOTFOUND) rc = GIT_ERROR;
    }
    int filemode = 1;
    if (rc == 0) { int found = git_config_get_bool(&filemode, config, "core.filemode"); if (found != 0 && found != GIT_ENOTFOUND) rc = found; }
    if (rc < 0) { HNGTreeFail(error, @"Unsupported tree preparation configuration"); break; }
    NSDictionary *metadata = HNGTreeMetadata(snapshot.path);
    NSSet *objectsBefore = HNGLooseObjects(snapshot.path);
    if (!metadata) { HNGTreeFail(error, @"Existing metadata lock or unreadable metadata"); break; }
    rootFD = open(root.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (rootFD < 0) { HNGTreeFail(error, @"Cannot open working tree"); break; }
    NSMutableDictionary *inventory = [NSMutableDictionary dictionary];
    visits = 0;
    if (!HNGTreeInventory(rootFD, @"", inventory, policy, &visits, 0, error)) break;
    NSMutableDictionary *cache = [NSMutableDictionary dictionary];
    NSUInteger total = 0;
    // Load ignore rules once. These exact bytes also become their prepared blobs.
    for (NSString *path in inventory) {
      if ([path.lastPathComponent isEqualToString:@".gitattributes"]) { valid = HNGTreeFail(error, @"Attributes are unsupported"); break; }
      if (![path.lastPathComponent isEqualToString:@".gitignore"]) continue;
      NSData *bytes = HNGTreeRead(rootFD, path, inventory[path], &total, error);
      if (!bytes) { valid = NO; break; }
      cache[path] = bytes;
      NSString *target = [snapshot.path stringByAppendingPathComponent:path];
      if (![[NSFileManager defaultManager] createDirectoryAtPath:target.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:error] || ![bytes writeToFile:target options:0 error:error]) { valid = NO; break; }
    }
    if (!valid) break;
    rc = git_repository_set_workdir(repo, snapshot.path.fileSystemRepresentation, 0);
    if (rc == 0) rc = git_index_new(&prepared);
    if (rc < 0) { HNGError(error, rc); break; }
    NSMutableSet *foldedNames = [NSMutableSet set];
    NSMutableDictionary *plan = [NSMutableDictionary dictionary];
    for (NSString *path in [[inventory allKeys] sortedArrayUsingSelector:@selector(compare:)]) {
      NSDictionary *identity = inventory[path];
      mode_t mode = [identity[@"mode"] unsignedIntValue];
      if (S_ISDIR(mode)) continue;
      NSString *folded = path.precomposedStringWithCanonicalMapping.lowercaseString;
      if ([foldedNames containsObject:folded]) { valid = HNGTreeFail(error, @"Case-ambiguous working tree"); break; }
      [foldedNames addObject:folded];
      const git_index_entry *tracked = git_index_get_bypath(original, path.UTF8String, 0);
      if (tracked && strcmp(tracked->path, path.UTF8String)) { valid = HNGTreeFail(error, @"Case-only staged rename is unsupported"); break; }
      BOOL inHead = [trackedPaths containsObject:path];
      if (!tracked && !inHead) {
        int ignored = 0;
        if (git_ignore_path_is_ignored(&ignored, repo, path.UTF8String) < 0) { valid = HNGTreeFail(error, @"Cannot evaluate ignore rules"); break; }
        if (ignored) continue;
      }
      NSData *bytes = cache[path];
      if (!bytes) bytes = HNGTreeRead(rootFD, path, identity, &total, error);
      if (!bytes) { valid = NO; break; }
      git_index_entry entry = {0};
      entry.path = path.UTF8String;
      entry.mode = mode & S_IXUSR ? GIT_FILEMODE_BLOB_EXECUTABLE : GIT_FILEMODE_BLOB;
      if (!filemode && tracked) entry.mode = tracked->mode;
      else if (!filemode && inHead) {
        git_tree_entry *old = NULL;
        if (git_tree_entry_bypath(&old, tree, path.UTF8String) == 0) entry.mode = git_tree_entry_filemode(old);
        git_tree_entry_free(old);
      }
      git_oid expected;
      rc = git_odb_hash(&expected, bytes.bytes, bytes.length, GIT_OBJECT_BLOB);
      if (rc == 0) rc = git_blob_create_frombuffer(&entry.id, repo, bytes.bytes, bytes.length);
      if (rc < 0 || !git_oid_equal(&expected, &entry.id) || !HNGTreeObjectValid(repo, &entry.id, GIT_OBJECT_BLOB, error)) { valid = HNGTreeFail(error, @"Prepared blob differs from captured bytes"); break; }
      rc = git_index_add(prepared, &entry);
      if (rc < 0) { HNGError(error, rc); valid = NO; break; }
      plan[path] = @{@"oid":HNGTreeOID(&entry.id), @"mode":@(entry.mode)};
    }
    if (!valid) break;
    git_oid treeOID;
    rc = git_index_write_tree_to(&treeOID, prepared, repo);
    NSMutableSet *seen = [NSMutableSet set];
    if (rc < 0 || !HNGTreeVerifyPlan(repo, &treeOID, @"", plan, seen, 0, error) || seen.count != plan.count) { HNGTreeFail(error, @"Prepared tree is incomplete or corrupt"); break; }
    NSMutableDictionary *current = [NSMutableDictionary dictionary];
    visits = 0;
    if (!HNGTreeInventory(rootFD, @"", current, policy, &visits, 0, error) || ![inventory isEqualToDictionary:current]) { HNGTreeFail(error, @"Working tree changed during preparation"); break; }
    HoliGitSnapshot *verification = [[HoliGitSnapshot alloc] initWithRoot:root error:error];
    BOOL unchangedMetadata = verification && [metadata isEqualToDictionary:HNGTreeMetadata(verification.path)];
    BOOL closed = [verification closeWithError:error];
    if (!unchangedMetadata || !closed) { HNGTreeFail(error, @"Repository changed during preparation"); break; }
    if (!HNGInstallTreeObjects(snapshot.path, objectsBefore, rootFD, repo, error)) break;
    HoliGitSnapshot *destination = nil;
    git_repository *destinationRepo = [self openSafeRepository:root snapshot:&destination error:error];
    [seen removeAllObjects];
    BOOL installed = destinationRepo && [metadata isEqualToDictionary:HNGTreeMetadata(destination.path)] && HNGTreeVerifyPlan(destinationRepo, &treeOID, @"", plan, seen, 0, error) && seen.count == plan.count;
    git_repository_free(destinationRepo);
    closed = [destination closeWithError:error];
    if (!installed || !closed) { HNGTreeFail(error, @"Destination tree verification failed"); break; }
    [current removeAllObjects]; visits = 0;
    if (!HNGTreeInventory(rootFD, @"", current, policy, &visits, 0, error) || ![inventory isEqualToDictionary:current]) { HNGTreeFail(error, @"Working tree changed during object installation"); break; }
    result = @{@"treeOID":HNGTreeOID(&treeOID), @"parentOID":HNGTreeOID(git_commit_id(commit)), @"branch":branch, @"unchanged":@(git_oid_equal(&treeOID, git_tree_id(tree)))};
  } while (0);
  if (rootFD >= 0) close(rootFD);
  git_config_free(config); git_tree_free(tree); git_commit_free(commit); git_remote_free(origin); git_reference_free(head); git_index_free(original); git_index_free(prepared); git_repository_free(repo);
  if (![snapshot closeWithError:error]) return nil;
  return result;
}
@end
