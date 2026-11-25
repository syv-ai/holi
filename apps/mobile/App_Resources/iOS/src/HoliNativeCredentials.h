#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, HoliCredentialSlot) {
  HoliCredentialSlotPrimary = 0,
  HoliCredentialSlotUnrelated = 1,
};

@interface HoliNativeCredentials : NSObject
- (nullable NSData *)read:(NSError *_Nullable __autoreleasing *)error;
- (BOOL)write:(NSData *)token error:(NSError *_Nullable __autoreleasing *)error;
- (BOOL)remove:(NSError *_Nullable __autoreleasing *)error;
- (nullable NSDictionary<NSString *, id> *)metadata:(NSError *_Nullable __autoreleasing *)error;
- (nullable instancetype)initWithDiagnosticRunId:(NSString *)runId slot:(HoliCredentialSlot)slot;
@end

NS_ASSUME_NONNULL_END
