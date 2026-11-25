/// <reference types="@nativescript/ios" />
declare class HoliManagedAcquisition extends NSObject {
  static alloc(): HoliManagedAcquisition
  init(): this
  rootKeyAtTargetError(target: string, error: interop.Pointer | interop.Reference<NSError>): string | null
  beginAtTargetRemoteBranchRunIdError(target: string, remote: string, branch: string, runId: string, error: interop.Pointer | interop.Reference<NSError>): NSDictionary<string, NSObject> | null
  checkpointReceiptNameError(receipt: NSDictionary<string, NSObject>, name: string, error: interop.Pointer | interop.Reference<NSError>): boolean
  finishReceiptError(receipt: NSDictionary<string, NSObject>, error: interop.Pointer | interop.Reference<NSError>): NSDictionary<string, NSObject> | null
  receiptsAtTargetError(target: string, error: interop.Pointer | interop.Reference<NSError>): NSDictionary<string, NSObject>
}
