import Foundation

public struct VaultRelPath: Equatable, Hashable, Sendable, CustomStringConvertible {
  public let value: String
  public var description: String { value }

  public static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.value.utf8.elementsEqual(rhs.value.utf8)
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(value.utf8.count)
    for byte in value.utf8 { hasher.combine(byte) }
  }

  public init(_ raw: String) throws {
    let scalars = Array(raw.unicodeScalars)
    if scalars.isEmpty { throw PathError("relative path is empty") }
    if scalars.contains(where: { $0.value == 0 }) {
      throw PathError("relative path contains NUL")
    }
    if scalars.contains(where: { $0.value == 0x5c }) {
      throw PathError("path contains backslash (use '/'): \(raw)")
    }
    if scalars.first?.value == 0x2f || hasDrivePrefix(scalars) {
      throw PathError("expected relative path, got absolute: \(raw)")
    }

    let segments = splitASCII(scalars, separator: 0x2f)
      .filter { !$0.isEmpty && !isASCII($0, equalTo: ".") }
    if segments.contains(where: { isASCII($0, equalTo: "..") }) {
      throw PathError("relative path contains '..': \(raw)")
    }
    guard !segments.isEmpty else {
      throw PathError("relative path is empty after normalization: \(raw)")
    }
    value = segments.map { String(String.UnicodeScalarView($0)) }.joined(separator: "/")
  }
}

public struct PathError: Error, Equatable, CustomStringConvertible {
  public let description: String
  public init(_ description: String) { self.description = description }
}

private func splitASCII(_ scalars: [Unicode.Scalar], separator: UInt32) -> [[Unicode.Scalar]] {
  var parts: [[Unicode.Scalar]] = [[]]
  for scalar in scalars {
    if scalar.value == separator {
      parts.append([])
    } else {
      parts[parts.count - 1].append(scalar)
    }
  }
  return parts
}

private func isASCII(_ scalars: [Unicode.Scalar], equalTo ascii: String) -> Bool {
  scalars.map(\.value).elementsEqual(ascii.utf8.map(UInt32.init))
}

private func hasDrivePrefix(_ scalars: [Unicode.Scalar]) -> Bool {
  guard scalars.count >= 2 else { return false }
  let first = scalars[0].value
  return ((65...90).contains(first) || (97...122).contains(first)) && scalars[1].value == 0x3a
}

private func containsASCII(_ scalars: [Unicode.Scalar], sequence: String) -> Bool {
  let needle = Array(sequence.utf8).map(UInt32.init)
  let values = scalars.map(\.value)
  guard values.count >= needle.count else { return false }
  return (0...(values.count - needle.count)).contains { start in
    values[start..<(start + needle.count)].elementsEqual(needle)
  }
}

private func asciiLowercased(_ scalars: [Unicode.Scalar]) -> [Unicode.Scalar] {
  scalars.map { scalar in
    if (65...90).contains(scalar.value) {
      return UnicodeScalar(scalar.value + 32)!
    }
    return scalar
  }
}

public enum VaultFormat {
  public static func isSecretPath(_ path: String) -> Bool {
    for segment in splitASCII(Array(path.unicodeScalars), separator: 0x2f) {
      let name = asciiLowercased(segment)
      if isASCII(name, equalTo: ".env") || isASCII(name, equalTo: ".secrets") { return true }
      let prefixLength: Int
      if hasASCIIPrefix(name, prefix: ".env.") {
        prefixLength = 5
      } else if hasASCIIPrefix(name, prefix: ".secrets.") {
        prefixLength = 9
      } else {
        continue
      }
      let suffix = name.dropFirst(prefixLength)
      if !suffix.isEmpty
        && !suffix.contains(where: { [10, 13, 0x2028, 0x2029].contains($0.value) })
      {
        return true
      }
    }
    return false
  }

  public static func isLocalOnlyPath(_ path: String) -> Bool {
    splitASCII(Array(path.unicodeScalars), separator: 0x2f).contains {
      containsASCII($0, sequence: ".local.")
    } || isSecretPath(path)
  }

  public static func isInIgnoredDir(_ path: String) -> Bool {
    splitASCII(Array(path.unicodeScalars), separator: 0x2f).contains {
      isASCII($0, equalTo: ".git") || isASCII($0, equalTo: "node_modules")
    }
  }

  public static func isRemote(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    var separator: Int?
    for (index, byte) in bytes.enumerated() {
      if byte == 0x2f {
        guard separator == nil, index > 0 else { return false }
        separator = index
      } else if !isRemoteByte(byte) {
        return false
      }
    }
    guard let separator, separator < bytes.count - 1 else { return false }
    return !containsASCII(Array(value.unicodeScalars), sequence: "..")
  }
}

private func isRemoteByte(_ byte: UInt8) -> Bool {
  (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
    || byte == 0x2e || byte == 0x5f || byte == 0x2d
}

private func hasASCIIPrefix(_ scalars: [Unicode.Scalar], prefix: String) -> Bool {
  let values = scalars.map(\.value)
  let bytes = Array(prefix.utf8).map(UInt32.init)
  return values.count >= bytes.count && values.prefix(bytes.count).elementsEqual(bytes)
}
