import Foundation
import XCTest

@testable import HoliVaultFormat

final class VaultFormatTests: XCTestCase {
  func testSharedCompatibilityCorpus() throws {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "vault-paths", withExtension: "json"))
    let root = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    XCTAssertEqual(root["version"] as? Int, 1, "unsupported or malformed corpus version")
    let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
    XCTAssertFalse(cases.isEmpty)
    var seen = Set<String>()
    let operations: Set<String> = ["path", "local", "secret", "ignored", "remote"]
    for item in cases {
      let operation = try XCTUnwrap(item["op"] as? String)
      let input = try XCTUnwrap(item["input"] as? String)
      XCTAssertTrue(operations.contains(operation), "unknown operation: \(operation)")
      let key = "\(operation):\(input.utf8.map { String(format: "%02x", $0) }.joined())"
      XCTAssertTrue(seen.insert(key).inserted, "duplicate case: \(key)")
      switch operation {
      case "path":
        if item["error"] as? Bool == true {
          XCTAssertThrowsError(try VaultRelPath(input), key)
          XCTAssertNil(item["expected"])
        } else {
          let expected = try XCTUnwrap(item["expected"] as? String, key)
          let actual = try VaultRelPath(input).value
          XCTAssertEqual(Array(actual.utf8), Array(expected.utf8), key)
        }
      case "local", "secret", "ignored", "remote":
        XCTAssertNil(item["error"], key)
        let expected = try XCTUnwrap(item["expected"] as? Bool, key)
        let actual: Bool
        switch operation {
        case "local": actual = VaultFormat.isLocalOnlyPath(input)
        case "secret": actual = VaultFormat.isSecretPath(input)
        case "ignored": actual = VaultFormat.isInIgnoredDir(input)
        default: actual = VaultFormat.isRemote(input)
        }
        XCTAssertEqual(actual, expected, key)
      default: XCTFail("unknown operation: \(operation)")
      }
    }
    XCTAssertEqual(Set(cases.compactMap { $0["op"] as? String }), operations)
  }
}
