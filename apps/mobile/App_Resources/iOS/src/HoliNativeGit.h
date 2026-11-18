#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HoliNativeGit : NSObject
- (NSString *)embeddedVersion;
- (nullable NSDictionary<NSString *, id> *)runOperation:(NSString *)operation
                                                   root:(NSString *)root
                                                  remote:(NSString *)remote
                                               username:(nullable NSString *)username
                                               password:(nullable NSString *)password
                                                  error:(NSError *_Nullable __autoreleasing *)error;
@end

NS_ASSUME_NONNULL_END
