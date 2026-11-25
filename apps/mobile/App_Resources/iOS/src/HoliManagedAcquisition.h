#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
@interface HoliManagedAcquisition : NSObject
/// Canonical lock key for a target whose parent exists, even before target creation.
- (nullable NSString *)rootKeyAtTarget:(NSString *)target error:(NSError *_Nullable __autoreleasing *)error;
- (nullable NSDictionary<NSString *, id> *)beginAtTarget:(NSString *)target remote:(NSString *)remote branch:(NSString *)branch runId:(NSString *)runId error:(NSError *_Nullable __autoreleasing *)error;
- (BOOL)checkpointReceipt:(NSDictionary<NSString *, id> *)receipt name:(NSString *)name error:(NSError *_Nullable __autoreleasing *)error;
- (nullable NSDictionary<NSString *, id> *)finishReceipt:(NSDictionary<NSString *, id> *)receipt error:(NSError *_Nullable __autoreleasing *)error;
- (NSDictionary<NSString *, id> *)receiptsAtTarget:(NSString *)target error:(NSError *_Nullable __autoreleasing *)error;
@end
NS_ASSUME_NONNULL_END
