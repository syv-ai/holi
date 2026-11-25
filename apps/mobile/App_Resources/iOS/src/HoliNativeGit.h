#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HoliNativeGit : NSObject
- (nullable instancetype)initWithOwner:(NSString *)owner
                        repositoryName:(NSString *)repositoryName
                               endpoint:(NSString *)endpoint
                                  error:(NSError *_Nullable __autoreleasing *)error;
- (NSString *)embeddedVersion;
- (nullable NSString *)canonicalRoot:(NSString *)root error:(NSError *_Nullable __autoreleasing *)error;
- (nullable NSDictionary<NSString *, id> *)workingCopyIdentity:(NSString *)root error:(NSError *_Nullable __autoreleasing *)error;
- (nullable NSArray<NSDictionary<NSString *, id> *> *)workingCopyCandidates:(NSString *)root error:(NSError *_Nullable __autoreleasing *)error;
- (BOOL)authorizeWorkingCopyPath:(NSString *)path root:(NSString *)root error:(NSError *_Nullable __autoreleasing *)error;
- (nullable NSArray<NSDictionary<NSString *, id> *> *)workingCopyStatus:(NSArray<NSString *> *)paths root:(NSString *)root error:(NSError *_Nullable __autoreleasing *)error;
- (nullable NSDictionary<NSString *, id> *)runOperation:(NSString *)operation
                                                   root:(NSString *)root
                                                  remote:(NSString *)remote
                                               username:(nullable NSString *)username
                                               password:(nullable NSString *)password
                                                  error:(NSError *_Nullable __autoreleasing *)error;
- (nullable NSDictionary<NSString *, id> *)runSelectedBranchOperation:(NSString *)operation
                                                                 root:(NSString *)root
                                                               remote:(NSString *)remote
                                                                owner:(NSString *)owner
                                                             repositoryName:(NSString *)repositoryName
                                                                 branch:(NSString *)branch
                                                             username:(nullable NSString *)username
                                                             password:(nullable NSString *)password
                                                                error:(NSError *_Nullable __autoreleasing *)error;
@end

NS_ASSUME_NONNULL_END
