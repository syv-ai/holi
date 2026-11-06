import Foundation
import XCTest

@testable import HoliVaultFormat

private enum Operation: String, Decodable, CaseIterable {
  case path, local, secret, ignored, remote
}

private enum Expected: Decodable, Equatable {
  case string(String)
  case bool(Bool)

  init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer()
    if let string = try? value.decode(String.self) {
      self = .string(string)
    } else if let bool = try? value.decode(Bool.self) {
      self = .bool(bool)
    } else {
      throw DecodingError.typeMismatch(
        Expected.self,
        .init(codingPath: decoder.codingPath, debugDescription: "expected string or boolean"))
    }
  }
}

private struct DynamicKey: CodingKey, Hashable {
  let stringValue: String
  let intValue: Int?

  init?(stringValue: String) {
    self.stringValue = stringValue
    intValue = nil
  }

  init?(intValue: Int) {
    stringValue = String(intValue)
    self.intValue = intValue
  }
}

private struct Fixture: Decodable {
  let op: Operation
  let input: String
  let expected: Expected?
  let error: Bool?

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case op, input, expected, error
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let keys = try decoder.container(keyedBy: DynamicKey.self).allKeys.map(\.stringValue)
    guard Set(keys).isSubset(of: ["op", "input", "expected", "error"]) else {
      throw FixtureError("case has unknown fields")
    }
    op = try container.decode(Operation.self, forKey: .op)
    input = try container.decode(String.self, forKey: .input)
    expected =
      try container.contains(.expected) ? container.decode(Expected.self, forKey: .expected) : nil
    error = try container.contains(.error) ? container.decode(Bool.self, forKey: .error) : nil
  }
}

private struct Corpus: Decodable {
  let version: Int
  let cases: [Fixture]

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case version, cases
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let keys = try decoder.container(keyedBy: DynamicKey.self).allKeys.map(\.stringValue)
    guard Set(keys).isSubset(of: ["version", "cases"]) else {
      throw FixtureError("corpus has unknown fields")
    }
    version = try container.decode(Int.self, forKey: .version)
    cases = try container.decode([Fixture].self, forKey: .cases)
  }
}

private func decodeCorpus(_ data: Data) throws -> Corpus {
  let corpus = try JSONDecoder().decode(Corpus.self, from: data)
  guard corpus.version == 1 else { throw FixtureError("unsupported corpus version") }
  guard !corpus.cases.isEmpty else { throw FixtureError("corpus has no cases") }

  var seen = Set<String>()
  var operations = Set<Operation>()
  for item in corpus.cases {
    operations.insert(item.op)
    let key = "\(item.op.rawValue):\(item.input.utf8.map { String(format: "%02x", $0) }.joined())"
    guard seen.insert(key).inserted else { throw FixtureError("duplicate case: \(key)") }
    switch item.op {
    case .path:
      if item.error == true {
        guard item.expected == nil else { throw FixtureError("error case has expected value") }
      } else {
        guard item.error == nil, case .string? = item.expected else {
          throw FixtureError("path case requires a string expected value or true error")
        }
      }
    case .local, .secret, .ignored, .remote:
      guard item.error == nil, case .bool? = item.expected else {
        throw FixtureError("predicate case requires a boolean expected value and no error")
      }
    }
  }
  guard operations == Set(Operation.allCases) else {
    throw FixtureError("corpus is missing operation coverage")
  }
  return corpus
}

private struct FixtureError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

final class VaultFormatTests: XCTestCase {
  func testSharedCompatibilityCorpus() throws {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "vault-paths", withExtension: "json"))
    let corpus = try decodeCorpus(Data(contentsOf: url))
    for item in corpus.cases {
      switch item.op {
      case .path:
        if item.error == true {
          XCTAssertThrowsError(try VaultRelPath(item.input), item.input)
        } else if case .string(let expected)? = item.expected {
          let actual = try VaultRelPath(item.input).value
          XCTAssertEqual(Array(actual.utf8), Array(expected.utf8), item.input)
        } else {
          XCTFail("validated path case lost its expectation")
        }
      case .local, .secret, .ignored, .remote:
        guard case .bool(let expected)? = item.expected else {
          XCTFail("validated predicate case lost its expectation")
          continue
        }
        let actual: Bool
        switch item.op {
        case .local: actual = VaultFormat.isLocalOnlyPath(item.input)
        case .secret: actual = VaultFormat.isSecretPath(item.input)
        case .ignored: actual = VaultFormat.isInIgnoredDir(item.input)
        default: actual = VaultFormat.isRemote(item.input)
        }
        XCTAssertEqual(actual, expected, "\(item.op.rawValue):\(item.input)")
      }
    }
  }

  func testPathIdentityIsByteExactThroughPublicHashCollections() throws {
    let composed = try VaultRelPath("café/note.md")
    let decomposed = try VaultRelPath("café/note.md")
    XCTAssertNotEqual(composed, decomposed)
    XCTAssertEqual(Set([composed, decomposed]).count, 2)
    var dictionary: [VaultRelPath: String] = [:]
    dictionary[composed] = "composed"
    dictionary[decomposed] = "decomposed"
    XCTAssertEqual(dictionary.count, 2)
    XCTAssertEqual(try VaultRelPath("a/./b"), try VaultRelPath("a//b"))
    XCTAssertEqual(Set([try VaultRelPath("a/./b"), try VaultRelPath("a//b")]).count, 1)
  }

  func testMalformedCorporaAreRejected() throws {
    let validCases: [[String: Any]] = [
      ["op": "path", "input": "a", "expected": "a"],
      ["op": "local", "input": "a", "expected": false],
      ["op": "secret", "input": "a", "expected": false],
      ["op": "ignored", "input": "a", "expected": false],
      ["op": "remote", "input": "a", "expected": false],
    ]
    func encoded(_ version: Any = 1, _ cases: [[String: Any]]) throws -> Data {
      try JSONSerialization.data(withJSONObject: ["version": version, "cases": cases])
    }
    var malformed: [Data] = [try encoded(true, validCases), try encoded(2, validCases)]
    malformed.append(
      try JSONSerialization.data(
        withJSONObject: ["version": 1, "cases": validCases, "unexpected": true]))

    var wrongExpected = validCases
    wrongExpected[1]["expected"] = 1
    malformed.append(try encoded(1, wrongExpected))

    var wrongPathExpected = validCases
    wrongPathExpected[0]["expected"] = true
    malformed.append(try encoded(1, wrongPathExpected))

    var malformedError = validCases
    malformedError[0]["error"] = "false"
    malformed.append(try encoded(1, malformedError))

    var malformedPredicateError = validCases
    malformedPredicateError[1]["error"] = "unexpected"
    malformed.append(try encoded(1, malformedPredicateError))

    var unknownField = validCases
    unknownField[0]["extra"] = true
    malformed.append(try encoded(1, unknownField))

    var missingExpected = validCases
    missingExpected[0].removeValue(forKey: "expected")
    malformed.append(try encoded(1, missingExpected))
    malformed.append(try encoded(1, Array(validCases.dropLast())))

    var duplicate = validCases
    duplicate.append(validCases[0])
    malformed.append(try encoded(1, duplicate))

    var missingFields = validCases
    missingFields[1].removeValue(forKey: "input")
    malformed.append(try encoded(1, missingFields))

    for data in malformed {
      XCTAssertThrowsError(try decodeCorpus(data))
    }
  }
}
