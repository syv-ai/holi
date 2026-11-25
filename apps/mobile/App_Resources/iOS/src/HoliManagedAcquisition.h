#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Filesystem-only staged publication for a managed working copy.
@interface HoliManagedAcquisition : NSObject
/// Creates an owned private sibling stage. Result includes stagePath, targetPath, rootKey, receipt.
- (nullable NSDictionary<NSString *, id> *)beginAtTarget:(NSString *)target
                                                nativeId:(NSString *)nativeId
                                                  remote:(NSString *)remote
                                                  branch:(NSString *)branch
                                                   runId:(NSString *)runId
                                                   error:(NSError *_Nullable __autoreleasing *)error;
/// Durably records a named checkpoint for simulator restart diagnostics.
- (BOOL)checkpointReceipt:(NSDictionary<NSString *, id> *)receipt name:(NSString *)name error:(NSError *_Nullable __autoreleasing *)error;
/// Publishes a complete owned stage without replacing any existing destination.
- (nullable NSDictionary<NSString *, id> *)finishReceipt:(NSDictionary<NSString *, id> *)receipt error:(NSError *_Nullable __autoreleasing *)error;
/// Returns discovered owned receipts/refusals under the canonical target parent; never cleans stages.
- (NSDictionary<NSString *, id> *)receiptsAtTarget:(NSString *)target error:(NSError *_Nullable __autoreleasing *)error;
@end

NS_ASSUME_NONNULL_END
