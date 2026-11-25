#import "HoliNativeCredentials.h"
#import <Security/Security.h>
#import <TargetConditionals.h>

#if TARGET_OS_SIMULATOR && defined(HOLI_CREDENTIAL_ACCEPTANCE_BUILD) && HOLI_CREDENTIAL_ACCEPTANCE_BUILD == 1
#define HNC_DIAGNOSTICS 1
#else
#define HNC_DIAGNOSTICS 0
#endif

static NSString *const HNCService = @"app.holi.github-credentials";
static NSString *const HNCAccount = @"github";
static NSString *const HNCErrorDomain = @"app.holi.native-credentials";

static void HNCSetError(NSError **error, NSString *operation, OSStatus status) {
  if (error == NULL) return;
  *error = [NSError errorWithDomain:HNCErrorDomain
                               code:status
                           userInfo:@{@"operation": operation, @"status": @(status)}];
}

@interface HoliNativeCredentials ()
@property(nonatomic, copy) NSString *service;
@property(nonatomic, copy) NSString *account;
- (instancetype)initWithService:(NSString *)service account:(NSString *)account;
@end

@implementation HoliNativeCredentials

- (instancetype)init {
  return [self initWithService:HNCService account:HNCAccount];
}

+ (BOOL)diagnosticsAvailable {
  return HNC_DIAGNOSTICS;
}

- (instancetype)initWithDiagnosticRunId:(NSString *)runId slot:(HoliCredentialSlot)slot {
#if HNC_DIAGNOSTICS
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:runId];
  if (uuid == nil || ![uuid.UUIDString.lowercaseString isEqualToString:runId.lowercaseString] ||
      (slot != HoliCredentialSlotPrimary && slot != HoliCredentialSlotUnrelated)) return nil;
  NSString *name = slot == HoliCredentialSlotPrimary ? @"primary" : @"unrelated";
  NSString *scope = [NSString stringWithFormat:@"diagnostic.%@.%@", uuid.UUIDString.lowercaseString, name];
  return [self initWithService:[HNCService stringByAppendingFormat:@".%@", scope]
                       account:[HNCAccount stringByAppendingFormat:@".%@", scope]];
#else
  return nil;
#endif
}

- (instancetype)initWithService:(NSString *)service account:(NSString *)account {
  if ((self = [super init])) { _service = [service copy]; _account = [account copy]; }
  return self;
}

- (NSMutableDictionary *)query {
  return [@{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: self.service,
            (__bridge id)kSecAttrAccount: self.account,
            (__bridge id)kSecAttrSynchronizable: @NO} mutableCopy];
}

- (nullable NSData *)read:(NSError **)error {
  NSMutableDictionary *query = [self query];
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status == errSecItemNotFound) return nil;
  if (status != errSecSuccess) { HNCSetError(error, @"read", status); return nil; }
  return CFBridgingRelease(result);
}

- (BOOL)write:(NSData *)token error:(NSError **)error {
  NSMutableDictionary *query = [self query];
  NSDictionary *attributes = @{
    (__bridge id)kSecValueData: token,
    (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    (__bridge id)kSecAttrSynchronizable: @NO,
  };
  OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)attributes);
  if (status == errSecItemNotFound) {
    [query addEntriesFromDictionary:attributes];
    status = SecItemAdd((__bridge CFDictionaryRef)query, NULL);
  }
  if (status == errSecSuccess) return YES;
  HNCSetError(error, @"write", status);
  return NO;
}

- (BOOL)remove:(NSError **)error {
  OSStatus status = SecItemDelete((__bridge CFDictionaryRef)[self query]);
  if (status == errSecSuccess || status == errSecItemNotFound) return YES;
  HNCSetError(error, @"remove", status);
  return NO;
}

- (nullable NSDictionary<NSString *,id> *)metadata:(NSError **)error {
  NSMutableDictionary *query = [self query];
  query[(__bridge id)kSecReturnAttributes] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (status == errSecItemNotFound) return nil;
  if (status != errSecSuccess) { HNCSetError(error, @"metadata", status); return nil; }
  NSDictionary *attributes = CFBridgingRelease(result);
  return @{ @"accessible": @([attributes[(__bridge id)kSecAttrAccessible] isEqual:(__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly]),
            @"synchronizable": @([attributes[(__bridge id)kSecAttrSynchronizable] boolValue]) };
}
@end
