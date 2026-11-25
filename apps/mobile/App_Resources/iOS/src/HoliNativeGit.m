#import "HoliNativeGit.h"
#import "HoliGitSnapshot.h"
#import <git2.h>
#import <sys/stat.h>
#import <errno.h>
#import <fcntl.h>
#import <unistd.h>
#import <dirent.h>

static NSString *const HoliNativeGitErrorDomain = @"HoliNativeGitErrorDomain";
static NSError *HNGPathError(int code, NSString *message);
static void HNGInitializeLibgit2(void) {
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{ git_libgit2_init(); });
}
static void HNGError(NSError **error, int code) {
  const git_error *detail = git_error_last();
  NSString *message = detail && detail->message ? [NSString stringWithUTF8String:detail->message] : @"libgit2 operation failed";
  if (error) *error = [NSError errorWithDomain:HoliNativeGitErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey: message, @"gitErrorClass": @(detail ? detail->klass : GIT_ERROR_NONE)}];
}

typedef struct { const char *username; const char *password; NSString *origin; BOOL challenged; BOOL attempted; } HNGCredentials;
static int HNGCredentialCallback(git_credential **out, const char *url, const char *username_from_url, unsigned int allowed, void *payload) {
  HNGCredentials *credentials = payload;
  NSURL *requested = [NSURL URLWithString:[NSString stringWithUTF8String:url ?: ""]];
  NSURL *permitted = [NSURL URLWithString:credentials->origin];
  NSNumber *requestedPort = requested.port ?: @443;
  NSNumber *permittedPort = permitted.port ?: @443;
  if (![requested.scheme.lowercaseString isEqualToString:@"https"] || ![requested.host.lowercaseString isEqualToString:permitted.host.lowercaseString] || ![requestedPort isEqualToNumber:permittedPort]) return GIT_EAUTH;
  credentials->challenged = YES;
  if (credentials->attempted || !(allowed & GIT_CREDENTIAL_USERPASS_PLAINTEXT) || !credentials->username || !credentials->password) return GIT_EAUTH;
  credentials->attempted = YES;
  return git_credential_userpass_plaintext_new(out, credentials->username, credentials->password);
}
static int HNGTransferProgress(const git_indexer_progress *stats, void *payload) { return 0; }
static int HNGPushUpdate(const char *refname, const char *status, void *payload) { return status ? GIT_ERROR : 0; }
typedef struct { BOOL hooks; BOOL filters; BOOL helpers; } HNGUnsafeConfig;
static int HNGDisableUnsafeConfig(git_repository *repository) {
  git_config *config = NULL;
  int result = git_repository_config(&config, repository);
  if (result < 0) return result;
  const char *keys[] = { "core.hookspath", "filter.holi-sentinel.smudge", "credential.helper" };
  for (NSUInteger index = 0; index < sizeof(keys) / sizeof(keys[0]); index++) {
    result = git_config_delete_multivar(config, keys[index], ".*");
    if (result == GIT_ENOTFOUND) result = 0;
    if (result < 0) break;
  }
  git_config_free(config);
  return result;
}
static int HNGCollectTree(const char *rootPath, const git_tree_entry *entry, void *payload) {
  NSMutableSet *paths=(__bridge NSMutableSet *)payload;
  const char *name=git_tree_entry_name(entry); if(git_tree_entry_type(entry)!=GIT_OBJECT_TREE && name){NSString *p=[NSString stringWithFormat:@"%s%s",rootPath,name]; if(![p hasPrefix:@".git/"])[paths addObject:p];}
  return 0;
}
static int HNGInspectConfig(const git_config_entry *entry, void *payload) {
  HNGUnsafeConfig *unsafe = payload;
  if (!entry->name) return 0;
  if (!strcmp(entry->name, "core.hookspath")) unsafe->hooks = YES;
  if (!strncmp(entry->name, "filter.", 7)) unsafe->filters = YES;
  if (!strcmp(entry->name, "credential.helper")) unsafe->helpers = YES;
  return 0;
}

static BOOL HNGCollectNames(int fd, NSString *prefix, NSMutableSet *paths, NSError **error) {
  int copy = dup(fd);
  DIR *dir = copy >= 0 ? fdopendir(copy) : NULL;
  if (!dir) { if (copy >= 0) close(copy); if (error) *error = HNGPathError(errno, @"Cannot enumerate working tree"); return NO; }
  BOOL ok = YES;
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(dir))) {
    NSString *name = [NSString stringWithUTF8String:entry->d_name];
    if (!name) { ok = NO; break; }
    if ([name isEqualToString:@"."] || [name isEqualToString:@".."] || [name isEqualToString:@".git"]) continue;
    NSString *path = prefix.length ? [prefix stringByAppendingFormat:@"/%@", name] : name;
    struct stat st;
    if (fstatat(fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW)) { ok = NO; break; }
    if (S_ISDIR(st.st_mode)) {
      int child = openat(fd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      if (child < 0) { ok = NO; break; }
      ok = HNGCollectNames(child, path, paths, error);
      close(child);
      if (!ok) break;
    } else [paths addObject:path];
    errno = 0;
  }
  if (errno) ok = NO;
  if (!ok && error && !*error) *error = HNGPathError(EIO, @"Cannot enumerate working tree safely");
  closedir(dir);
  return ok;
}

@implementation HoliNativeGit
- (NSString *)embeddedVersion {
  HNGInitializeLibgit2();
  int major = 0, minor = 0, revision = 0;
  git_libgit2_version(&major, &minor, &revision);
  return [NSString stringWithFormat:@"%d.%d.%d", major, minor, revision];
}

- (NSDictionary<NSString *, id> *)runOperation:(NSString *)operation root:(NSString *)root remote:(NSString *)remote username:(NSString *)username password:(NSString *)password error:(NSError **)error {
  NSURL *remoteURL = [NSURL URLWithString:remote];
  if (![@[@"clone", @"fetch", @"push", @"poison"] containsObject:operation] || root.length == 0 || root.length > 4096 || remote.length == 0 || remote.length > 4096 || ![remoteURL.scheme.lowercaseString isEqualToString:@"https"] || remoteURL.user || remoteURL.password) {
    if (error) *error = [NSError errorWithDomain:HoliNativeGitErrorDomain code:EINVAL userInfo:@{NSLocalizedDescriptionKey: @"Only bounded HTTPS remotes and absolute roots are accepted"}];
    return nil;
  }
  NSData *rootBytes = [root dataUsingEncoding:NSUTF8StringEncoding];
  if (![root hasPrefix:@"/"] || memchr(rootBytes.bytes, 0, rootBytes.length) || [remote containsString:@"\n"] || [remote containsString:@"\r"]) {
    if (error) *error = [NSError errorWithDomain:HoliNativeGitErrorDomain code:EINVAL userInfo:@{NSLocalizedDescriptionKey: @"Invalid repository root or remote"}];
    return nil;
  }
  HNGInitializeLibgit2();
  const char *rootPath = root.fileSystemRepresentation;
  git_repository *repository = NULL;
  int result = 0;
  BOOL isClone = [operation isEqualToString:@"clone"];
  BOOL isPoison = [operation isEqualToString:@"poison"];
  if (isClone) {
    struct stat st;
    if (lstat(rootPath, &st) == 0) {
      if (!S_ISDIR(st.st_mode) || (st.st_mode & S_IFLNK)) {
        if (error) *error = [NSError errorWithDomain:HoliNativeGitErrorDomain code:EINVAL userInfo:@{NSLocalizedDescriptionKey: @"Clone destination must be an owned directory"}];
        return nil;
      }
      NSDirectoryEnumerator *enumerator = [[NSFileManager defaultManager] enumeratorAtPath:root];
      if (enumerator.nextObject) {
        if (error) *error = [NSError errorWithDomain:HoliNativeGitErrorDomain code:EEXIST userInfo:@{NSLocalizedDescriptionKey: @"Clone destination is not empty"}];
        return nil;
      }
    } else if (errno != ENOENT) { HNGError(error, errno); return nil; }
  } else {
    result = git_repository_open_ext(&repository, rootPath, GIT_REPOSITORY_OPEN_NO_SEARCH, NULL);
    if (result < 0) { HNGError(error, result); return nil; }
  }
  HNGCredentials credentials = { username.UTF8String, password.UTF8String, remote, NO, NO };
  git_remote_callbacks callbacks = GIT_REMOTE_CALLBACKS_INIT;
  callbacks.credentials = HNGCredentialCallback;
  callbacks.transfer_progress = HNGTransferProgress;
  callbacks.push_update_reference = HNGPushUpdate;
  callbacks.payload = &credentials;
  if (isClone) {
    git_clone_options options = GIT_CLONE_OPTIONS_INIT;
    options.fetch_opts.callbacks = callbacks;
    options.fetch_opts.download_tags = GIT_REMOTE_DOWNLOAD_TAGS_NONE;
    result = git_clone(&repository, remote.UTF8String, rootPath, &options);
  } else if (isPoison) {
    git_config *config = NULL;
    result = git_repository_config(&config, repository);
    if (result == 0) result = git_config_set_string(config, "core.hookspath", "/holi-sentinel-hooks");
    if (result == 0) result = git_config_set_string(config, "filter.holi-sentinel.smudge", "/bin/false");
    if (result == 0) result = git_config_set_string(config, "credential.helper", "/bin/false");
    git_config_free(config);
    git_remote *gitRemote = NULL;
    if (result == 0) result = git_remote_lookup(&gitRemote, repository, "origin");
    if (result == 0) result = git_remote_set_url(repository, "origin", "https://127.0.0.1:1/attacker.git");
    if (result == 0) result = git_remote_set_pushurl(repository, "origin", "https://127.0.0.1:1/attacker.git");
    git_remote_free(gitRemote);
  } else {
    result = HNGDisableUnsafeConfig(repository);
    git_remote *gitRemote = NULL;
    if (result == 0) result = git_remote_lookup(&gitRemote, repository, "origin");
    if (result == GIT_ENOTFOUND) result = git_remote_create(&gitRemote, repository, "origin", remote.UTF8String);
    if (result == 0) result = git_remote_set_url(repository, "origin", remote.UTF8String);
    if (result == 0) result = git_remote_set_pushurl(repository, "origin", remote.UTF8String);
    if (gitRemote) { git_remote_free(gitRemote); gitRemote = NULL; }
    if (result == 0) result = git_remote_lookup(&gitRemote, repository, "origin");
    if (result == 0) result = git_remote_connect(gitRemote, [operation isEqualToString:@"push"] ? GIT_DIRECTION_PUSH : GIT_DIRECTION_FETCH, &callbacks, NULL, NULL);
    if (result == 0 && [operation isEqualToString:@"fetch"]) {
      git_fetch_options fetchOptions = GIT_FETCH_OPTIONS_INIT;
      fetchOptions.callbacks = callbacks;
      fetchOptions.download_tags = GIT_REMOTE_DOWNLOAD_TAGS_NONE;
      result = git_remote_download(gitRemote, NULL, &fetchOptions);
    }
    if (result == 0 && [operation isEqualToString:@"fetch"]) result = git_remote_update_tips(gitRemote, &callbacks, 0, GIT_REMOTE_DOWNLOAD_TAGS_NONE, "Holi compatibility fetch");
    if (result == 0 && [operation isEqualToString:@"push"]) {
      git_strarray refspecs = {0};
      char *spec = "HEAD:refs/heads/holi-compat";
      refspecs.strings = &spec; refspecs.count = 1;
      git_push_options options = GIT_PUSH_OPTIONS_INIT;
      options.callbacks = callbacks;
      result = git_remote_push(gitRemote, &refspecs, &options);
    }
    if (gitRemote && git_remote_connected(gitRemote)) git_remote_disconnect(gitRemote);
    git_remote_free(gitRemote);
  }
  if (result < 0) { HNGError(error, result); git_repository_free(repository); return nil; }
  git_reference *head = NULL;
  NSString *branch = @"";
  if (git_repository_head(&head, repository) == 0) {
    const char *name = git_reference_name(head);
    if (name) branch = [NSString stringWithUTF8String:name];
  }
  NSString *headTarget = @"";
  if (head) {
    char oid[GIT_OID_HEXSZ + 1];
    git_oid_tostr(oid, sizeof(oid), git_reference_target(head));
    headTarget = [NSString stringWithUTF8String:oid];
  }
  git_reference_free(head);
  NSString *fetchTarget = @"";
  if ([operation isEqualToString:@"fetch"]) {
    git_reference *fetched = NULL;
    if (git_reference_lookup(&fetched, repository, "refs/remotes/origin/fixture-start") == 0) {
      char oid[GIT_OID_HEXSZ + 1];
      git_oid_tostr(oid, sizeof(oid), git_reference_target(fetched));
      fetchTarget = [NSString stringWithUTF8String:oid];
    }
    git_reference_free(fetched);
  }
  BOOL remoteConstrained = YES;
  if (!isClone && !isPoison) {
    git_remote *verifiedRemote = NULL;
    if (git_remote_lookup(&verifiedRemote, repository, "origin") == 0) {
      const char *fetchURL = git_remote_url(verifiedRemote);
      const char *pushURL = git_remote_pushurl(verifiedRemote);
      remoteConstrained = fetchURL && pushURL && !strcmp(fetchURL, remote.UTF8String) && !strcmp(pushURL, remote.UTF8String);
    } else remoteConstrained = NO;
    git_remote_free(verifiedRemote);
  }
  HNGUnsafeConfig unsafe = { NO, NO, NO };
  git_config *config = NULL;
  if (git_repository_config(&config, repository) == 0) {
    git_config_foreach(config, HNGInspectConfig, &unsafe);
    git_config_free(config);
  }
  git_repository_free(repository);
  return @{ @"operation": operation, @"credentialChallenge": @(credentials.challenged), @"success": @YES, @"branch": branch, @"fetchTarget": fetchTarget, @"headTarget": headTarget, @"hooksDisabled": @(!unsafe.hooks), @"filtersDisabled": @(!unsafe.filters), @"helpersDisabled": @(!unsafe.helpers), @"remoteConstrained": @(remoteConstrained) };
}
- (NSString *)canonicalRoot:(NSString *)root error:(NSError **)error {
  if (![root hasPrefix:@"/"] || root.length > 4096) { if (error) *error = [NSError errorWithDomain:HoliNativeGitErrorDomain code:EINVAL userInfo:nil]; return nil; }
  char resolved[PATH_MAX];
  if (!realpath(root.fileSystemRepresentation, resolved)) { if (error) *error = [NSError errorWithDomain:HoliNativeGitErrorDomain code:errno userInfo:nil]; return nil; }
  struct stat st; if (lstat(resolved, &st) || !S_ISDIR(st.st_mode)) { if (error) *error = [NSError errorWithDomain:HoliNativeGitErrorDomain code:EINVAL userInfo:nil]; return nil; }
  return [NSString stringWithUTF8String:resolved];
}
- (git_repository *)openSafeRepository:(NSString *)root snapshot:(HoliGitSnapshot **)snapshotOut error:(NSError **)error {
  HNGInitializeLibgit2();
  HoliGitSnapshot *snapshot = [[HoliGitSnapshot alloc] initWithRoot:root error:error];
  if (!snapshot) return NULL;
  git_config *config = NULL;
  int rc = git_config_new(&config);
  NSString *configPath = [snapshot.path stringByAppendingPathComponent:@".git/config"];
  if (rc == 0) rc = git_config_add_file_ondisk(config, configPath.fileSystemRepresentation, GIT_CONFIG_LEVEL_LOCAL, NULL, 0);
  git_repository *repo = NULL;
  NSString *gitDir = [snapshot.path stringByAppendingPathComponent:@".git"];
  if (rc == 0) rc = git_repository_open_holi(&repo, gitDir.fileSystemRepresentation, GIT_REPOSITORY_OPEN_NO_SEARCH | GIT_REPOSITORY_OPEN_BARE, NULL, config);
  git_config_free(config);
  if (rc < 0) { HNGError(error, rc); [snapshot close]; return NULL; }
  git_config *readConfig = NULL;
  HNGUnsafeConfig unsafe = {0};
  rc = git_repository_config(&readConfig, repo);
  if (rc == 0) { git_config_foreach(readConfig, HNGInspectConfig, &unsafe); git_config_free(readConfig); }
  git_config *local = NULL; int bare = 1;
  if (rc == 0) rc = git_config_new(&local);
  if (rc == 0) rc = git_config_add_file_ondisk(local, configPath.fileSystemRepresentation, GIT_CONFIG_LEVEL_LOCAL, NULL, 0);
  if (rc == 0) { int value = 1; if (git_config_get_bool(&value, local, "core.bare") == 0) bare = value; }
  git_config_free(local);
  if (rc < 0 || bare || unsafe.hooks || unsafe.filters || unsafe.helpers) { git_repository_free(repo); [snapshot close]; if(error)*error=HNGPathError(EINVAL,@"Unsupported repository configuration"); return NULL; }
  git_repository_state_t state = git_repository_state(repo);
  if (state != GIT_REPOSITORY_STATE_NONE && state != GIT_REPOSITORY_STATE_MERGE) { git_repository_free(repo); [snapshot close]; if(error)*error=HNGPathError(EINVAL,@"Unsupported repository state"); return NULL; }
  *snapshotOut = snapshot;
  return repo;
}
- (NSDictionary *)workingCopyIdentity:(NSString *)root error:(NSError **)error {
  HoliGitSnapshot *snapshot = nil;
  git_repository *repo = [self openSafeRepository:root snapshot:&snapshot error:error];
  if (!repo) return nil;
  git_reference *head = NULL;
  git_remote *origin = NULL;
  int rc = git_repository_head(&head, repo);
  if (rc == 0) rc = git_remote_lookup(&origin, repo, "origin");
  NSDictionary *result = nil;
  if (rc == 0) {
    const char *raw = git_remote_url(origin);
    NSString *url = raw ? [NSString stringWithUTF8String:raw] : nil;
    NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^(?:https://github\\.com/|git@github\\.com:)([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+)$" options:NSRegularExpressionCaseInsensitive error:nil];
    NSTextCheckingResult *match = url ? [pattern firstMatchInString:url options:0 range:NSMakeRange(0,url.length)] : nil;
    if (!match) { if (error) *error = HNGPathError(EINVAL, @"Unsupported origin identity"); }
    else {
      NSString *owner = [url substringWithRange:[match rangeAtIndex:1]];
      NSString *name = [url substringWithRange:[match rangeAtIndex:2]];
      if ([name hasSuffix:@".git"]) name = [name substringToIndex:name.length - 4];
      BOOL attached = git_reference_is_branch(head);
      const char *branch = attached ? git_reference_shorthand(head) : NULL;
      if (!name.length || [name isEqualToString:@"."] || [name isEqualToString:@".."]) { if (error) *error = HNGPathError(EINVAL, @"Invalid origin identity"); }
      else result = @{@"remotes":@[[owner stringByAppendingFormat:@"/%@", name]], @"branch":branch ? [NSString stringWithUTF8String:branch] : [NSNull null], @"attached":@(attached)};
    }
  } else HNGError(error, rc);
  git_remote_free(origin);
  git_reference_free(head);
  git_repository_free(repo);
  if (![snapshot closeWithError:error]) return nil;
  return result;
}
- (NSArray<NSDictionary<NSString *,id> *> *)workingCopyCandidates:(NSString *)root error:(NSError **)error {
  HoliGitSnapshot *snapshot = nil;
  git_repository *repo = [self openSafeRepository:root snapshot:&snapshot error:error];
  if (!repo) return nil;
  git_index *index = NULL;
  git_reference *head = NULL;
  git_commit *commit = NULL;
  git_tree *tree = NULL;
  NSMutableSet *paths = [NSMutableSet set];
  int rc = git_repository_index(&index, repo);
  if (rc == 0) rc = git_repository_head(&head, repo);
  if (rc == 0) rc = git_reference_peel((git_object **)&commit, head, GIT_OBJECT_COMMIT);
  if (rc == 0) rc = git_commit_tree(&tree, commit);
  if (rc == 0) rc = git_tree_walk(tree, GIT_TREEWALK_PRE, HNGCollectTree, (__bridge void *)paths);
  if (rc == 0) {
    for (size_t i = 0; i < git_index_entrycount(index); i++) {
      const git_index_entry *entry = git_index_get_byindex(index, i);
      NSString *path = entry && entry->path ? [NSString stringWithUTF8String:entry->path] : nil;
      if (!path) { rc = GIT_ERROR; break; }
      [paths addObject:path];
    }
  }
  NSMutableArray *out = nil;
  if (rc == 0) {
    int fd = open(root.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    BOOL ok = fd >= 0 && HNGCollectNames(fd, @"", paths, error);
    if (fd >= 0) close(fd);
    if (ok) {
      out = [NSMutableArray array];
      for (NSString *path in paths) [out addObject:@{@"path":path}];
    } else if (error && !*error) *error = HNGPathError(EIO, @"Cannot open working tree");
  } else HNGError(error, rc);
  git_tree_free(tree);
  git_commit_free(commit);
  git_reference_free(head);
  git_index_free(index);
  git_repository_free(repo);
  if (![snapshot closeWithError:error]) return nil;
  return out;
}
- (BOOL)authorizeWorkingCopyPath:(NSString *)path root:(NSString *)root error:(NSError **)error {
  NSArray<NSString *> *parts = nil;
  if (!HNGPathParts(path, &parts)) { if(error)*error=HNGPathError(EINVAL,@"Invalid working-tree path"); return NO; }
  NSString *full=[root stringByAppendingPathComponent:path]; char resolved[PATH_MAX]; if(!realpath(full.fileSystemRepresentation,resolved)) { if(errno==ENOENT)return YES; if(error)*error=[NSError errorWithDomain:HoliNativeGitErrorDomain code:errno userInfo:nil]; return NO; }
  NSString *canonicalRoot=[self canonicalRoot:root error:error]; return canonicalRoot && [[NSString stringWithUTF8String:resolved] hasPrefix:[canonicalRoot stringByAppendingString:@"/"]];
}
static NSError *HNGPathError(int code, NSString *message) {
  return [NSError errorWithDomain:HoliNativeGitErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey:message}];
}
static BOOL HNGPathParts(NSString *path, NSArray<NSString *> **parts) {
  if (!path.length || [path hasPrefix:@"/"] || [path containsString:@"\\"] || [path containsString:@"\0"]) return NO;
  NSArray *items = [path componentsSeparatedByString:@"/"];
  for (NSString *item in items) if (!item.length || [item isEqualToString:@"."] || [item isEqualToString:@".."] || [item isEqualToString:@".git"]) return NO;
  *parts = items; return YES;
}
static int HNGOpenParent(int rootFD, NSArray<NSString *> *parts) {
  int fd = dup(rootFD); if (fd < 0) return -1;
  for (NSUInteger i=0; i+1<parts.count; i++) {
    int next = openat(fd, parts[i].fileSystemRepresentation, O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
    close(fd); if (next < 0) return -1; fd = next;
  }
  return fd;
}
static BOOL HNGPrepareIgnores(git_repository *repo, HoliGitSnapshot *snapshot, int rootFD, NSArray<NSString *> *paths, NSError **error) {
  for (NSString *path in paths) {
    if ([path.lastPathComponent isEqualToString:@".gitattributes"]) { if (error) *error = HNGPathError(EINVAL, @"Attributes are unsupported in read-only status"); return NO; }
    if (![path.lastPathComponent isEqualToString:@".gitignore"]) continue;
    NSArray<NSString *> *parts = nil;
    if (!HNGPathParts(path, &parts)) return NO;
    int parent = HNGOpenParent(rootFD, parts);
    int fd = parent >= 0 ? openat(parent, parts.lastObject.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) : -1;
    int saved = errno;
    if (parent >= 0) close(parent);
    if (fd < 0 && (saved == ENOENT || saved == ENOTDIR)) continue;
    struct stat st;
    if (fd < 0 || fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size > 1024 * 1024) {
      if (fd >= 0) close(fd);
      if (error) *error = HNGPathError(EINVAL, @"Cannot inspect ignore rules safely"); return NO;
    }
    NSMutableData *data = [NSMutableData data]; uint8_t buffer[4096]; ssize_t n;
    while ((n = read(fd, buffer, sizeof(buffer))) > 0) {
      [data appendBytes:buffer length:(NSUInteger)n];
      if (data.length > 1024 * 1024) { n = -1; break; }
    }
    close(fd);
    if (n < 0) { if (error) *error = HNGPathError(EIO, @"Cannot read ignore rules"); return NO; }
    NSString *target = [snapshot.path stringByAppendingPathComponent:path];
    if (![[NSFileManager defaultManager] createDirectoryAtPath:target.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:error] || ![data writeToFile:target options:0 error:error]) return NO;
  }
  int rc = git_repository_set_workdir(repo, snapshot.path.fileSystemRepresentation, 0);
  if (rc < 0) { HNGError(error, rc); return NO; }
  return YES;
}
static BOOL HNGTreeFail(NSError **error, NSString *message) {
  if (error) *error = HNGPathError(EINVAL, message);
  return NO;
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
- (NSDictionary<NSString *, id> *)prepareWorkingCopyTree:(NSString *)root remote:(NSString *)remote branch:(NSString *)branch paths:(NSArray<NSString *> *)paths error:(NSError **)error {
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
    if (rc < 0 || paths.count > 10000) { HNGTreeFail(error, @"Unsupported tree preparation configuration or size"); break; }
    NSDictionary *metadata = HNGTreeMetadata(snapshot.path);
    NSSet *objectsBefore = HNGLooseObjects(snapshot.path);
    if (!metadata) { HNGTreeFail(error, @"Existing metadata lock or unreadable metadata"); break; }
    rootFD = open(root.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (rootFD < 0 || !HNGPrepareIgnores(repo, snapshot, rootFD, paths, error)) break;
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

- (NSArray<NSDictionary<NSString *,id> *> *)workingCopyStatus:(NSArray<NSString *> *)paths root:(NSString *)root error:(NSError **)error {
  HoliGitSnapshot *snapshot = nil; git_repository *repo=[self openSafeRepository:root snapshot:&snapshot error:error]; if(!repo)return nil;
  int workdirResult = git_repository_set_workdir(repo, snapshot.path.fileSystemRepresentation, 0);
  if (workdirResult < 0) { if (error) HNGError(error, workdirResult); git_repository_free(repo); [snapshot close]; return nil; }
  int rootFD=open(root.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
  if(rootFD<0){ if(error)*error=HNGPathError(errno,@"Cannot safely open working tree"); git_repository_free(repo); [snapshot close]; return nil; }
  git_index *index=NULL; git_reference *head=NULL; git_commit *commit=NULL; git_tree *tree=NULL;
  int rc=git_repository_index(&index,repo);
  if (rc == 0) {
    rc = git_repository_head(&head, repo);
    if (rc == GIT_EUNBORNBRANCH || rc == GIT_ENOTFOUND) {
      if (error) *error = HNGPathError(ENODATA, @"Working-copy status requires an existing HEAD commit");
      close(rootFD); git_index_free(index); git_repository_free(repo); [snapshot close]; return nil;
    }
  }
  if (rc == 0) {
    if (!git_reference_is_branch(head)) {
      if (error) *error = HNGPathError(EINVAL, @"Working-copy status requires an attached branch");
      close(rootFD); git_reference_free(head); git_index_free(index); git_repository_free(repo); [snapshot close]; return nil;
    }
    rc = git_reference_peel((git_object **)&commit, head, GIT_OBJECT_COMMIT);
  }
  if(rc==0 && commit) rc=git_commit_tree(&tree,commit);
  if(rc<0){ if(error)HNGError(error,rc); close(rootFD); git_index_free(index); git_tree_free(tree); git_commit_free(commit); git_reference_free(head); git_repository_free(repo); [snapshot close]; return nil; }
  git_config *config=NULL; BOOL filemode=YES; if(git_repository_config(&config,repo)==0){ int value=1; if(git_config_get_bool(&value,config,"core.filemode")==0)filemode=value; const char *unsupported[] = {"core.autocrlf", "core.eol", "core.attributesfile", "core.excludesfile"}; for (NSUInteger i=0; i<4; i++) { git_config_entry *setting=NULL; int settingResult = git_config_get_entry(&setting,config,unsupported[i]); git_config_entry_free(setting); if (settingResult != GIT_ENOTFOUND) { if(error)*error=HNGPathError(EINVAL,@"Working-copy normalization or global ignore settings are unsupported"); git_config_free(config); close(rootFD); git_index_free(index); git_reference_free(head); git_commit_free(commit); git_tree_free(tree); git_repository_free(repo); [snapshot close]; return nil; } } git_config_free(config); }
  if (!HNGPrepareIgnores(repo, snapshot, rootFD, paths, error)) {
    close(rootFD); git_tree_free(tree); git_commit_free(commit); git_reference_free(head); git_index_free(index); git_repository_free(repo); [snapshot close]; return nil;
  }
  for (size_t i = 0; i < git_index_entrycount(index); i++) {
    const git_index_entry *entry = git_index_get_byindex(index, i);
    if ((entry->flags & GIT_INDEX_ENTRY_VALID) || (entry->flags_extended & (GIT_INDEX_ENTRY_SKIP_WORKTREE | GIT_INDEX_ENTRY_INTENT_TO_ADD)) || entry->mode == GIT_FILEMODE_COMMIT || entry->mode == GIT_FILEMODE_LINK) {
      if (error) *error = HNGPathError(EINVAL, @"Unsupported index state");
      close(rootFD); git_tree_free(tree); git_commit_free(commit); git_reference_free(head); git_index_free(index); git_repository_free(repo); [snapshot close]; return nil;
    }
  }
  NSMutableArray *changes=[NSMutableArray array];
  NSMutableSet *seen = [NSMutableSet set];
  NSSet *authorized = [NSSet setWithArray:paths];
  for(NSString *requestedPath in paths){
    NSString *path = requestedPath;
    NSArray<NSString *> *parts=nil; if(!HNGPathParts(path,&parts)){ if(error)*error=HNGPathError(EINVAL,@"Invalid working-tree path"); changes=nil; break; }
    const char *p=path.fileSystemRepresentation; const git_index_entry *stage0=git_index_get_bypath(index,p,0); BOOL conflict=NO;
    if (stage0 && strcmp(p, stage0->path)) {
      NSString *canonicalPath = [NSString stringWithUTF8String:stage0->path];
      if (![authorized containsObject:canonicalPath]) continue;
      git_tree_entry *original = NULL;
      int lookup = git_tree_entry_bypath(&original, tree, stage0->path);
      git_tree_entry_free(original);
      if (lookup != 0) { if(error)*error=HNGPathError(EINVAL,@"Case-only staged renames are unsupported"); changes=nil; break; }
      path = [NSString stringWithUTF8String:stage0->path];
      if (!HNGPathParts(path, &parts)) { if(error)*error=HNGPathError(EINVAL,@"Invalid index path"); changes=nil; break; }
      p = stage0->path;
    }
    if ([seen containsObject:path]) continue;
    [seen addObject:path];
    for(int stage=1;stage<=3;stage++) if(git_index_get_bypath(index,p,stage)){conflict=YES;break;}
    BOOL ignoredAbsent = NO;
    if (!stage0 && !conflict) {
      git_tree_entry *tracked = NULL;
      int trackedResult = git_tree_entry_bypath(&tracked, tree, p);
      BOOL inHead = trackedResult == 0;
      git_tree_entry_free(tracked);
      if (trackedResult != 0 && trackedResult != GIT_ENOTFOUND) { HNGError(error, trackedResult); changes = nil; break; }
      int ignored = 0;
      rc = git_ignore_path_is_ignored(&ignored, repo, p);
      if (rc < 0) { HNGError(error, rc); changes = nil; break; }
      ignoredAbsent = ignored;
      if (ignored && !inHead) continue;
    }
    const git_tree_entry *headEntry=NULL; if(tree){ rc=git_tree_entry_bypath((git_tree_entry **)&headEntry,tree,p); if(rc==GIT_ENOTFOUND)rc=0; else if(rc<0){if(error)HNGError(error,rc);changes=nil;break;} }
    if (headEntry && git_tree_entry_filemode(headEntry) == GIT_FILEMODE_COMMIT) { git_tree_entry_free((git_tree_entry *)headEntry); if(error)*error=HNGPathError(EINVAL,@"Unsupported HEAD gitlink"); changes=nil; break; }
    if (headEntry && git_tree_entry_type(headEntry) == GIT_OBJECT_TREE) { git_tree_entry_free((git_tree_entry *)headEntry); headEntry = NULL; }
    BOOL staged = conflict || ((headEntry!=NULL)!=(stage0!=NULL)) || (headEntry&&stage0&&(!git_oid_equal(git_tree_entry_id(headEntry),&stage0->id)||git_tree_entry_filemode(headEntry)!=stage0->mode));
    git_tree_entry_free((git_tree_entry *)headEntry);
    if (ignoredAbsent) { if (staged) [changes addObject:@{@"path":path,@"staged":@YES,@"worktree":@NO,@"conflict":@NO}]; continue; }
    BOOL worktree=NO; int parent=HNGOpenParent(rootFD,parts); struct stat st; int parentError = errno; int statResult=parent<0?-1:fstatat(parent,parts.lastObject.fileSystemRepresentation,&st,AT_SYMLINK_NOFOLLOW);
    BOOL missing = (statResult < 0 && (errno == ENOENT || errno == ENOTDIR)) || (parent < 0 && (parentError == ENOENT || parentError == ENOTDIR));
    if (missing && stage0 && (git_index_caps(index) & GIT_INDEX_CAPABILITY_IGNORE_CASE)) {
      for (NSString *alias in paths) {
        if ([alias isEqualToString:path] || git_index_get_bypath(index, alias.fileSystemRepresentation, 0) != stage0) continue;
        NSArray<NSString *> *aliasParts = nil;
        if (!HNGPathParts(alias, &aliasParts)) continue;
        int aliasParent = HNGOpenParent(rootFD, aliasParts);
        struct stat aliasStat;
        if (aliasParent >= 0 && fstatat(aliasParent, aliasParts.lastObject.fileSystemRepresentation, &aliasStat, AT_SYMLINK_NOFOLLOW) == 0) {
          if (parent >= 0) close(parent);
          parent = aliasParent; parts = aliasParts; st = aliasStat; statResult = 0; missing = NO;
          break;
        }
        if (aliasParent >= 0) close(aliasParent);
      }
    }
    if(statResult<0 && !missing){ if(error)*error=HNGPathError(errno,@"Cannot inspect working-tree path"); changes=nil; if(parent>=0)close(parent); break; }
    if (statResult == 0 && S_ISDIR(st.st_mode)) { statResult = -1; missing = YES; }
    if(statResult==0){
      if(S_ISLNK(st.st_mode)){ if(error)*error=HNGPathError(EINVAL,@"Symbolic links are not supported in status paths"); changes=nil; close(parent); break; }
      if(!S_ISREG(st.st_mode)){ if(error)*error=HNGPathError(EINVAL,@"Only regular files are supported in status paths"); changes=nil; close(parent); break; }
      int fd=openat(parent,parts.lastObject.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW|O_NONBLOCK); close(parent);
      if(fd<0){if(error)*error=HNGPathError(errno,@"Cannot safely read working-tree file");changes=nil;break;}
      struct stat opened; if(fstat(fd,&opened)||!S_ISREG(opened.st_mode)){close(fd);if(error)*error=HNGPathError(EINVAL,@"Working-tree file changed during status");changes=nil;break;}
      if (opened.st_size < 0 || opened.st_size > 64 * 1024 * 1024) { close(fd); if(error)*error=HNGPathError(EFBIG,@"Working-tree file exceeds the 64 MiB status limit"); changes=nil; break; }
      NSMutableData *data=[NSMutableData dataWithCapacity:(NSUInteger)opened.st_size]; uint8_t buffer[16384]; ssize_t n; errno = 0; while((n=read(fd,buffer,sizeof(buffer)))>0) { if (data.length + (NSUInteger)n > 64 * 1024 * 1024) { n = -1; errno = EFBIG; break; } [data appendBytes:buffer length:(NSUInteger)n]; } int readError=errno; close(fd);
      if(n<0){if(error)*error=HNGPathError(readError,@"Cannot read working-tree file");changes=nil;break;}
      git_oid oid; git_odb *odb=NULL; rc=git_repository_odb(&odb,repo); if(rc==0)rc=git_odb_hash(&oid,data.bytes,data.length,GIT_OBJECT_BLOB); git_odb_free(odb);
      uint32_t mode=(opened.st_mode & S_IXUSR)?GIT_FILEMODE_BLOB_EXECUTABLE:GIT_FILEMODE_BLOB;
      if(rc<0){if(error)HNGError(error,rc);changes=nil;break;} worktree=!stage0 || !git_oid_equal(&oid,&stage0->id) || (filemode && mode!=stage0->mode);
    } else { if(parent>=0)close(parent); worktree=stage0!=NULL; }
    if(staged||worktree||conflict)[changes addObject:@{@"path":path,@"staged":@(staged),@"worktree":@(worktree),@"conflict":@(conflict)}];
  }
  close(rootFD); git_tree_free(tree); git_commit_free(commit); git_reference_free(head); git_index_free(index); git_repository_free(repo); if (![snapshot closeWithError:error]) return nil; return changes;
}
@end
