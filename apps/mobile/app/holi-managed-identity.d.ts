/// <reference types="@nativescript/ios" />
declare class HoliManagedIdentity extends NSObject {
  static alloc(): HoliManagedIdentity
  init(): this
  createIdentityAtRootRemoteBranchEndpointError(
    root: string,
    remote: string,
    branch: string,
    endpoint: string,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSDictionary<string, NSObject> | null
  readIdentityAtRootError(
    root: string,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSDictionary<string, NSObject> | null
  identityMatchesRemoteBranchEndpointError(
    identity: NSDictionary<string, NSObject>,
    remote: string,
    branch: string,
    endpoint: string,
    error: interop.Pointer | interop.Reference<NSError>,
  ): boolean
}
