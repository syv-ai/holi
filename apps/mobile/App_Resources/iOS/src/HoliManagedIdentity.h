#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HoliManagedIdentity : NSObject
- (nullable NSDictionary<NSString *, id> *)createIdentityAtRoot:(NSString *)root
                                                         remote:(NSString *)remote
                                                         branch:(NSString *)branch
                                                       endpoint:(NSString *)endpoint
                                                           error:(NSError *_Nullable __autoreleasing *)error;
- (nullable NSDictionary<NSString *, id> *)readIdentityAtRoot:(NSString *)root
                                                          error:(NSError *_Nullable __autoreleasing *)error;
- (BOOL)identity:(NSDictionary<NSString *, id> *)identity
 matchesRemote:(NSString *)remote
          branch:(NSString *)branch
        endpoint:(NSString *)endpoint
           error:(NSError *_Nullable __autoreleasing *)error;
@end

NS_ASSUME_NONNULL_END
