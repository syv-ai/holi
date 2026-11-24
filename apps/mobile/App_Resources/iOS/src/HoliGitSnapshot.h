#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// A private, read-only copy of Git metadata made without following filesystem links.
@interface HoliGitSnapshot : NSObject
@property(nonatomic, copy, readonly) NSString *path;
@property(nonatomic, copy, readonly) NSData *configData;
- (nullable instancetype)initWithRoot:(NSString *)root error:(NSError *_Nullable __autoreleasing *)error;
- (void)close;
@end

NS_ASSUME_NONNULL_END
