/// <reference types="@nativescript/ios" />

declare class HoliNativeCredentials extends NSObject {
  static alloc(): HoliNativeCredentials
  init(): this
  initWithDiagnosticRunIdSlot(runId: string, slot: number): HoliNativeCredentials | null
  read(error: interop.Pointer | interop.Reference<NSError>): NSData | null
  writeError(token: NSData, error: interop.Pointer | interop.Reference<NSError>): boolean
  remove(error: interop.Pointer | interop.Reference<NSError>): boolean
  metadata(error: interop.Pointer | interop.Reference<NSError>): NSDictionary | null
}
