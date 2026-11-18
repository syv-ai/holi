/// <reference types="@nativescript/ios" />

declare class HoliNativeFiles extends NSObject {
  static alloc(): HoliNativeFiles
  init(): this

  canonicalPathError(
    pathBytes: NSData,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSData | null
  namesError(
    pathBytes: NSData,
    error: interop.Pointer | interop.Reference<NSError>,
  ): NSArray<NSData> | null
  kindError(pathBytes: NSData, error: interop.Pointer | interop.Reference<NSError>): string | null
  makeDirectoryError(
    pathBytes: NSData,
    error: interop.Pointer | interop.Reference<NSError>,
  ): boolean
  readError(pathBytes: NSData, error: interop.Pointer | interop.Reference<NSError>): NSData | null
  writeExclusiveDataFaultError(
    pathBytes: NSData,
    data: NSData,
    fault: string | null,
    error: interop.Pointer | interop.Reference<NSError>,
  ): boolean
  publishFromToExclusiveFaultError(
    fromBytes: NSData,
    toBytes: NSData,
    exclusive: boolean,
    fault: string | null,
    error: interop.Pointer | interop.Reference<NSError>,
  ): boolean
  removeFileError(pathBytes: NSData, error: interop.Pointer | interop.Reference<NSError>): boolean
  syncFileError(pathBytes: NSData, error: interop.Pointer | interop.Reference<NSError>): boolean
  syncDirectoryError(
    pathBytes: NSData,
    error: interop.Pointer | interop.Reference<NSError>,
  ): boolean
}
