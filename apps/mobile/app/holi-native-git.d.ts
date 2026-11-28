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
  managedIdentityError(
    root: string,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSDictionary<string, NSObject> | null
  committedEntriesHistoryError(
    root: string,
    history: boolean,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSDictionary<string, NSObject> | null
  publishManagedPlanUsernamePasswordError(
    root: string,
    plan: NSDictionary<string, NSObject>,
    username: string,
    password: string,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSDictionary<string, NSObject> | null
  materializeManagedPlanError(
    root: string,
    plan: NSDictionary<string, NSObject>,
    error: interop.Pointer | interop.Reference<NSError>,
  ): boolean
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
  prepareWorkingCopyTreeRemoteBranchPolicyError(
    root: string,
    remote: string,
    branch: string,
    policy: (path: string) => number,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSDictionary<string, NSObject> | null
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
