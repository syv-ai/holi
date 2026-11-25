/// <reference types="@nativescript/ios" />

declare class HoliNativeCredentials extends NSObject {
  static alloc(): HoliNativeCredentials
  init(): this
  initWithDiagnosticRunIdSlot(runId: string, slot: number): HoliNativeCredentials | null
  readError(error: interop.Pointer | interop.Reference<NSError>): NSData | null
  writeError(token: NSData, error: interop.Pointer | interop.Reference<NSError>): boolean
  removeError(error: interop.Pointer | interop.Reference<NSError>): boolean
  metadataError(error: interop.Pointer | interop.Reference<NSError>): NSDictionary | null
}
