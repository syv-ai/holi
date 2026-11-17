/// <reference types="@nativescript/ios" />

declare class HoliNativeGit extends NSObject {
  static alloc(): HoliNativeGit
  init(): this
  embeddedVersion(): string
  runOperationRootRemoteUsernamePasswordError(
    operation: string,
    root: string,
    remote: string,
    username: string | null,
    password: string | null,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSDictionary<string, NSObject> | null
}
