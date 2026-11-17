#import "HoliNativeFiles.h"
#import <dirent.h>
#import <errno.h>
#import <fcntl.h>
#import <stdio.h>
#import <sys/stat.h>
#import <sys/types.h>
#import <unistd.h>
#if __has_include(<sys/attr.h>)
#import <sys/attr.h>
#endif

static NSString *const HoliNativeFilesErrorDomain =
    @"HoliNativeFilesErrorDomain";

static void HNFSetError(NSError **error, NSString *operation, int code) {
  if (error)
    *error = [NSError
        errorWithDomain:HoliNativeFilesErrorDomain
                   code:code
               userInfo:@{
                 NSLocalizedDescriptionKey : [NSString
                     stringWithFormat:@"%@ failed (errno %d)", operation, code],
                 @"syscall" : operation
               }];
}

static char *HNFPath(NSData *bytes, NSError **error) {
  const unsigned char *raw = bytes.bytes;
  if (bytes.length == 0 || raw[0] != '/') {
    HNFSetError(error, @"validate-path", EINVAL);
    return NULL;
  }
  if (memchr(raw, 0, bytes.length)) {
    HNFSetError(error, @"validate-path", EINVAL);
    return NULL;
  }
  char *path = malloc(bytes.length + 1);
  if (!path) {
    HNFSetError(error, @"malloc", ENOMEM);
    return NULL;
  }
  memcpy(path, raw, bytes.length);
  path[bytes.length] = 0;
  return path;
}

static BOOL HNFIsFault(NSString *fault, NSString *stage) {
  return [fault isEqualToString:stage];
}

@implementation HoliNativeFiles

- (NSData *)canonicalPath:(NSData *)pathBytes error:(NSError **)error {
  char *path = HNFPath(pathBytes, error);
  if (!path)
    return nil;
  char *resolved = realpath(path, NULL);
  int saved = errno;
  free(path);
  if (!resolved) {
    HNFSetError(error, @"realpath", saved);
    return nil;
  }
  struct stat st;
  if (stat(resolved, &st) != 0) {
    saved = errno;
    free(resolved);
    HNFSetError(error, @"stat", saved);
    return nil;
  }
  if (!S_ISDIR(st.st_mode)) {
    free(resolved);
    HNFSetError(error, @"canonical-directory", ENOTDIR);
    return nil;
  }
  NSData *result = [NSData dataWithBytes:resolved length:strlen(resolved)];
  free(resolved);
  return result;
}

- (NSArray<NSData *> *)names:(NSData *)pathBytes error:(NSError **)error {
  char *path = HNFPath(pathBytes, error);
  if (!path)
    return nil;
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  int saved = errno;
  free(path);
  if (fd < 0) {
    HNFSetError(error, @"open-directory", saved);
    return nil;
  }
  DIR *dir = fdopendir(fd);
  if (!dir) {
    saved = errno;
    close(fd);
    HNFSetError(error, @"fdopendir", saved);
    return nil;
  }
  NSMutableArray<NSData *> *result = [NSMutableArray array];
  struct dirent *entry;
  int readError = 0;
  for (;;) {
    errno = 0;
    entry = readdir(dir);
    if (!entry) {
      readError = errno;
      break;
    }
    [result addObject:[NSData dataWithBytes:entry->d_name
                                     length:strlen(entry->d_name)]];
  }
  int closeResult = closedir(dir);
  int closeError = errno;
  if (readError) {
    HNFSetError(error, @"readdir", readError);
    return nil;
  }
  if (closeResult != 0) {
    HNFSetError(error, @"closedir", closeError);
    return nil;
  }
  return result;
}

- (NSString *)kind:(NSData *)pathBytes error:(NSError **)error {
  char *path = HNFPath(pathBytes, error);
  if (!path)
    return nil;
  struct stat st;
  int result = lstat(path, &st);
  int saved = errno;
  free(path);
  if (result != 0) {
    if (saved == ENOENT)
      return nil;
    HNFSetError(error, @"lstat", saved);
    return nil;
  }
  if (S_ISREG(st.st_mode))
    return @"regular";
  if (S_ISDIR(st.st_mode))
    return @"directory";
  if (S_ISLNK(st.st_mode))
    return @"symlink";
  return @"other";
}

- (BOOL)makeDirectory:(NSData *)pathBytes error:(NSError **)error {
  char *path = HNFPath(pathBytes, error);
  if (!path)
    return NO;
  int result = mkdir(path, 0700);
  int saved = errno;
  free(path);
  if (result != 0) {
    HNFSetError(error, @"mkdir", saved);
    return NO;
  }
  return YES;
}

- (NSData *)read:(NSData *)pathBytes error:(NSError **)error {
  char *path = HNFPath(pathBytes, error);
  if (!path)
    return nil;
  int fd = open(path, O_RDONLY | O_NOFOLLOW);
  int saved = errno;
  free(path);
  if (fd < 0) {
    HNFSetError(error, @"open", saved);
    return nil;
  }
  struct stat st;
  BOOL ok = YES;
  if (fstat(fd, &st) != 0) {
    saved = errno;
    HNFSetError(error, @"fstat", saved);
    ok = NO;
  } else if (!S_ISREG(st.st_mode)) {
    HNFSetError(error, @"read-regular-file", EINVAL);
    ok = NO;
  }
  NSMutableData *data = [NSMutableData data];
  unsigned char buffer[65536];
  while (ok) {
    ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count > 0)
      [data appendBytes:buffer length:(NSUInteger)count];
    else if (count == 0)
      break;
    else if (errno != EINTR) {
      saved = errno;
      HNFSetError(error, @"read", saved);
      ok = NO;
    }
  }
  if (close(fd) != 0) {
    saved = errno;
    if (ok)
      HNFSetError(error, @"close", saved);
    ok = NO;
  }
  return ok ? data : nil;
}

- (BOOL)writeExclusive:(NSData *)pathBytes
                  data:(NSData *)bytes
                 fault:(NSString *)fault
                 error:(NSError **)error {
  char *path = HNFPath(pathBytes, error);
  if (!path)
    return NO;
  if (HNFIsFault(fault, @"stage-open")) {
    free(path);
    HNFSetError(error, @"open", EIO);
    return NO;
  }
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  int saved = errno;
  if (fd < 0) {
    free(path);
    HNFSetError(error, @"open", saved);
    return NO;
  }
  struct stat created;
  BOOL haveIdentity = fstat(fd, &created) == 0;
  BOOL ok = haveIdentity;
  if (!haveIdentity) {
    saved = errno;
    HNFSetError(error, @"fstat", saved);
  }
  const unsigned char *cursor = bytes.bytes;
  size_t remaining = bytes.length;
  BOOL injectWrite = HNFIsFault(fault, @"stage-write");
  while (ok && remaining) {
    size_t request = injectWrite && remaining > 1 ? remaining / 2 : remaining;
    ssize_t count = write(fd, cursor, request);
    if (count < 0 && errno == EINTR)
      continue;
    if (count <= 0) {
      saved = count < 0 ? errno : EIO;
      HNFSetError(error, @"write", saved);
      ok = NO;
      break;
    }
    cursor += count;
    remaining -= (size_t)count;
    if (injectWrite) {
      HNFSetError(error, @"write", EIO);
      ok = NO;
    }
  }
  if (ok && injectWrite) {
    HNFSetError(error, @"write", EIO);
    ok = NO;
  }
  if (ok && HNFIsFault(fault, @"stage-sync")) {
    HNFSetError(error, @"fsync", EIO);
    ok = NO;
  } else if (ok && fsync(fd) != 0) {
    saved = errno;
    HNFSetError(error, @"fsync", saved);
    ok = NO;
  }
  BOOL injectClose = HNFIsFault(fault, @"stage-close");
  if (close(fd) != 0) {
    saved = errno;
    if (ok)
      HNFSetError(error, @"close", saved);
    ok = NO;
  } else if (injectClose) {
    HNFSetError(error, @"close", EIO);
    ok = NO;
  }
  if (!ok && haveIdentity) {
    struct stat current;
    if (lstat(path, &current) == 0 && current.st_dev == created.st_dev &&
        current.st_ino == created.st_ino)
      unlink(path);
  }
  free(path);
  return ok;
}

- (BOOL)publishFrom:(NSData *)fromBytes
                 to:(NSData *)toBytes
          exclusive:(BOOL)exclusive
              fault:(NSString *)fault
              error:(NSError **)error {
  char *from = HNFPath(fromBytes, error);
  if (!from)
    return NO;
  char *to = HNFPath(toBytes, error);
  if (!to) {
    free(from);
    return NO;
  }
  if (HNFIsFault(fault, @"publish")) {
    free(from);
    free(to);
    HNFSetError(error, @"rename", EIO);
    return NO;
  }
  int result;
  if (exclusive)
    result = renamex_np(from, to, RENAME_EXCL);
  else
    result = rename(from, to);
  int saved = errno;
  if (result != 0) {
    free(from);
    free(to);
    HNFSetError(error, exclusive ? @"renamex_np" : @"rename", saved);
    return NO;
  }
  char *slash = strrchr(to, '/');
  if (slash) *slash = 0;
  int dir = open(slash ? to : ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  int syncResult = dir < 0 ? -1 : fsync(dir);
  int syncError = errno;
  if (dir >= 0) close(dir);
  free(from);
  free(to);
  if (syncResult != 0) {
    HNFSetError(error, @"fsync-published-directory", syncError);
    return NO;
  }
  return YES;
}

- (BOOL)removeFile:(NSData *)pathBytes error:(NSError **)error {
  char *path = HNFPath(pathBytes, error);
  if (!path)
    return NO;
  int result = unlink(path);
  int saved = errno;
  free(path);
  if (result != 0) {
    HNFSetError(error, @"unlink", saved);
    return NO;
  }
  return YES;
}

- (BOOL)syncFile:(NSData *)pathBytes error:(NSError **)error {
  char *path = HNFPath(pathBytes, error);
  if (!path)
    return NO;
  int fd = open(path, O_RDONLY | O_NOFOLLOW);
  int saved = errno;
  free(path);
  if (fd < 0) {
    HNFSetError(error, @"open-file", saved);
    return NO;
  }
  struct stat st;
  int result = fstat(fd, &st);
  if (result == 0 && !S_ISREG(st.st_mode)) {
    result = -1;
    errno = EINVAL;
  }
  if (result == 0)
    result = fsync(fd);
  saved = errno;
  close(fd);
  if (result != 0) {
    HNFSetError(error, @"fsync-file", saved);
    return NO;
  }
  return YES;
}

- (BOOL)syncDirectory:(NSData *)pathBytes error:(NSError **)error {
  char *path = HNFPath(pathBytes, error);
  if (!path)
    return NO;
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  int saved = errno;
  free(path);
  if (fd < 0) {
    HNFSetError(error, @"open-directory", saved);
    return NO;
  }
  int result = fsync(fd);
  saved = errno;
  close(fd);
  if (result != 0) {
    HNFSetError(error, @"fsync-directory", saved);
    return NO;
  }
  return YES;
}

@end
