#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>
#include <unistd.h>

struct Work {
  napi_env env;
  napi_async_work work;
  napi_deferred deferred;
  NSString *json;
  NSString *error;
};

static void Execute(napi_env, void *data) {
  Work *work = static_cast<Work *>(data);
  NSString *bundle = NSBundle.mainBundle.bundleIdentifier;
  if (bundle.length == 0) {
    work->error = @"missing Bundle.main.bundleIdentifier";
    return;
  }
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  __block UNNotificationSettings *settings = nil;
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *value) {
    settings = value;
    dispatch_semaphore_signal(semaphore);
  }];
  if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0 || settings == nil) {
    work->error = @"notification settings query timed out";
    return;
  }
  NSMutableDictionary *values = [@{
    @"bundleIdentifier": bundle,
    @"pid": @(getpid()),
    @"authorizationStatus": @(settings.authorizationStatus),
    @"alertStyle": @(settings.alertStyle),
    @"alertSetting": @(settings.alertSetting),
    @"notificationCenterSetting": @(settings.notificationCenterSetting)
  } mutableCopy];
  if (@available(macOS 13.0, *)) {
    values[@"scheduledDeliverySetting"] = @(settings.scheduledDeliverySetting);
    values[@"timeSensitiveSetting"] = @(settings.timeSensitiveSetting);
  }
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:values options:NSJSONWritingSortedKeys error:nil];
  if (!encoded) { work->error = @"could not encode notification settings"; return; }
  work->json = [[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding];
}

static void Complete(napi_env env, napi_status status, void *data) {
  Work *work = static_cast<Work *>(data);
  if (status != napi_ok && !work->error) work->error = @"native notification query failed";
  napi_value value;
  if (work->error) {
    napi_value message;
    napi_create_string_utf8(env, work->error.UTF8String, NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &value);
    napi_reject_deferred(env, work->deferred, value);
  } else {
    napi_create_string_utf8(env, work->json.UTF8String, NAPI_AUTO_LENGTH, &value);
    napi_resolve_deferred(env, work->deferred, value);
  }
  napi_delete_async_work(env, work->work);
  delete work;
}

static napi_value ReadSettings(napi_env env, napi_callback_info) {
  napi_value promise, resourceName;
  napi_deferred deferred;
  napi_create_promise(env, &deferred, &promise);
  Work *work = new Work{env, nullptr, deferred, nil, nil};
  napi_create_string_utf8(env, "read notification settings", NAPI_AUTO_LENGTH, &resourceName);
  napi_status status = napi_create_async_work(env, nullptr, resourceName, Execute, Complete, work, &work->work);
  if (status == napi_ok) status = napi_queue_async_work(env, work->work);
  if (status != napi_ok) {
    napi_value message, error;
    napi_create_string_utf8(env, "could not queue notification settings query", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &error);
    napi_reject_deferred(env, deferred, error);
    if (work->work) napi_delete_async_work(env, work->work);
    delete work;
  }
  return promise;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "readSettings", NAPI_AUTO_LENGTH, ReadSettings, nullptr, &function);
  napi_set_named_property(env, exports, "readSettings", function);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
