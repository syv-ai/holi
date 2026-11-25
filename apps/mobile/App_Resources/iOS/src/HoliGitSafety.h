#import "HoliNativeGit.h"
#import "HoliGitSnapshot.h"
#import <git2.h>

// Internal native working-copy implementation seam; never exposed through IPC.
void HNGError(NSError **error, int code);
NSError *HNGPathError(int code, NSString *message);
BOOL HNGPathParts(NSString *path, NSArray<NSString *> **parts);
int HNGOpenParent(int rootFD, NSArray<NSString *> *parts);
BOOL HNGPrepareIgnores(git_repository *repo, HoliGitSnapshot *snapshot, int rootFD, NSArray<NSString *> *paths, NSError **error);
@interface HoliNativeGit (WorkingCopySnapshot)
- (git_repository *)openSafeRepository:(NSString *)root snapshot:(HoliGitSnapshot **)snapshot error:(NSError **)error;
@end
