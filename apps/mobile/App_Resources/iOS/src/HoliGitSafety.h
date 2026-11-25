#import "HoliNativeGit.h"
#import "HoliGitSnapshot.h"
#import <git2.h>

// Internal native working-copy implementation seam; never exposed through IPC.
void HNGError(NSError **error, int code);
NSError *HNGPathError(int code, NSString *message);
BOOL HNGPathParts(NSString *path, NSArray<NSString *> **parts);
int HNGOpenParent(int rootFD, NSArray<NSString *> *parts);
@interface HoliNativeGit (WorkingCopySnapshot)
- (git_repository *)openSafeRepository:(NSString *)root snapshot:(HoliGitSnapshot **)snapshot error:(NSError **)error;
@end
