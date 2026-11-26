#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Applies only caller-authorized concrete file changes beneath rootFD. Paths are
/// slash-separated relative paths; all artifacts/slots are transaction-local names.
FOUNDATION_EXPORT BOOL HGIApplyIntegrationFiles(int rootFD, int transactionFD,
    NSArray<NSDictionary *> *changes, NSError **error);
FOUNDATION_EXPORT BOOL HGIPreflightIntegrationFiles(int rootFD, int transactionFD,
    NSArray<NSDictionary *> *changes, NSError **error);

NS_ASSUME_NONNULL_END
