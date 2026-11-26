import Foundation
import FoundationModels

@objc(HoliFoundationModels)
public final class HoliFoundationModels: NSObject {
  @objc(availabilityReason)
  public class func availabilityReason() -> String {
    switch SystemLanguageModel.default.availability {
    case .available:
      return "available"
    case .unavailable(.deviceNotEligible):
      return "device-not-eligible"
    case .unavailable(.appleIntelligenceNotEnabled):
      return "apple-intelligence-not-enabled"
    case .unavailable(.modelNotReady):
      return "model-not-ready"
    @unknown default:
      return "unknown"
    }
  }
}
