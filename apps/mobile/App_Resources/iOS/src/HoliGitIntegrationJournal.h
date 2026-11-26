#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HoliGitIntegrationJournal : NSObject
@property(nonatomic, readonly) NSString *transactionPath;
- (nullable instancetype)createAtRoot:(NSString *)root
                               remote:(NSString *)remote
                               branch:(NSString *)branch
                             nativeId:(nullable NSString *)nativeId
                                 plan:(NSData *)plan
                                error:(NSError **)error;
- (nullable instancetype)openAtPath:(NSString *)path error:(NSError **)error;
- (nullable NSDictionary *)readState:(NSError **)error;
- (BOOL)replaceState:(NSDictionary *)state error:(NSError **)error;
- (BOOL)writeArtifact:(NSData *)data named:(NSString *)name error:(NSError **)error;
- (BOOL)cleanupRecordedArtifacts:(NSError **)error;
- (void)close;
@end

NS_ASSUME_NONNULL_END
