/// <reference types="@nativescript/ios" />

declare class HoliNativeGit extends NSObject {
  static alloc(): HoliNativeGit
  init(): this
  initWithOwnerRepositoryNameEndpointError(
    owner: string,
    repositoryName: string,
    endpoint: string,
    error: interop.Pointer | interop.Reference<NSError>,
  ): HoliNativeGit | null
  embeddedVersion(): string
  canonicalRootError(
    root: string,
    error: interop.Pointer | interop.Reference<NSError>,
  ): string | null
  workingCopyIdentityError(
    root: string,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSDictionary<string, NSObject> | null
  workingCopyCandidatesError(
    root: string,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSArray<NSDictionary<string, NSObject>> | null
  authorizeWorkingCopyPathRootError(
    path: string,
    root: string,
    error: interop.Pointer | interop.Reference<NSError>,
  ): boolean
  workingCopyStatusRootError(
    paths: NSArray<string>,
    root: string,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSArray<NSDictionary<string, NSObject>> | null
  runOperationRootRemoteUsernamePasswordError(
    operation: string,
    root: string,
    remote: string,
    username: string | null,
    password: string | null,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSDictionary<string, NSObject> | null
  runSelectedBranchOperationRootRemoteOwnerRepositoryNameBranchUsernamePasswordError(
    operation: string,
    root: string,
    remote: string,
    owner: string,
    repositoryName: string,
    branch: string,
    username: string | null,
    password: string | null,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSDictionary<string, NSObject> | null
}
