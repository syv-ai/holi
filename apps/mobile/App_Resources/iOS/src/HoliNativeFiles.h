#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface HoliNativeFiles : NSObject
- (nullable NSData *)canonicalPath:(NSData *)pathBytes
                             error:(NSError *_Nullable __autoreleasing *)error;
- (nullable NSArray<NSData *> *)names:(NSData *)pathBytes
                                error:
                                    (NSError *_Nullable __autoreleasing *)error;
- (nullable NSString *)kind:(NSData *)pathBytes
                      error:(NSError *_Nullable __autoreleasing *)error;
- (BOOL)makeDirectory:(NSData *)pathBytes
                error:(NSError *_Nullable __autoreleasing *)error;
- (nullable NSData *)read:(NSData *)pathBytes
                    error:(NSError *_Nullable __autoreleasing *)error;
- (BOOL)writeExclusive:(NSData *)pathBytes
                  data:(NSData *)bytes
                 fault:(nullable NSString *)fault
                 error:(NSError *_Nullable __autoreleasing *)error;
- (BOOL)publishFrom:(NSData *)fromBytes
                 to:(NSData *)toBytes
          exclusive:(BOOL)exclusive
              fault:(nullable NSString *)fault
              error:(NSError *_Nullable __autoreleasing *)error;
- (BOOL)removeFile:(NSData *)pathBytes
             error:(NSError *_Nullable __autoreleasing *)error;
- (BOOL)removeDirectory:(NSData *)pathBytes
                  error:(NSError *_Nullable __autoreleasing *)error;
@end

NS_ASSUME_NONNULL_END
