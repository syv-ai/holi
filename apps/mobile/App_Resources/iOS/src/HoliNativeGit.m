#import "HoliNativeGit.h"
#import <git2.h>
#import <sys/stat.h>
#import <errno.h>

static NSString *const HoliNativeGitErrorDomain = @"HoliNativeGitErrorDomain";
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
static int HNGInspectConfig(const git_config_entry *entry, void *payload) {
  HNGUnsafeConfig *unsafe = payload;
  if (!entry->name) return 0;
  if (!strcmp(entry->name, "core.hookspath")) unsafe->hooks = YES;
  if (!strncmp(entry->name, "filter.", 7)) unsafe->filters = YES;
  if (!strcmp(entry->name, "credential.helper")) unsafe->helpers = YES;
  return 0;
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
  git_libgit2_opts(GIT_OPT_SET_SEARCH_PATH, GIT_CONFIG_LEVEL_SYSTEM, "/dev/null");
  git_libgit2_opts(GIT_OPT_SET_SEARCH_PATH, GIT_CONFIG_LEVEL_GLOBAL, "/dev/null");
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
@end
