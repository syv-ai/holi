import Foundation

public struct VaultRelPath: Equatable, Hashable, Sendable, CustomStringConvertible {
  public let value: String
  public var description: String { value }

  public init(_ raw: String) throws {
    if raw.isEmpty { throw PathError("relative path is empty") }
    if raw.unicodeScalars.contains(where: { $0.value == 0 }) {
      throw PathError("relative path contains NUL")
    }
    if raw.contains("\\") { throw PathError("path contains backslash (use '/'): \(raw)") }
    if raw.hasPrefix("/") || raw.range(of: "^[A-Za-z]:", options: .regularExpression) != nil {
      throw PathError("expected relative path, got absolute: \(raw)")
    }
    let segments = raw.split(separator: "/").map(String.init).filter { $0 != "." }
    if segments.contains("..") { throw PathError("relative path contains '..': \(raw)") }
    guard !segments.isEmpty else {
      throw PathError("relative path is empty after normalization: \(raw)")
    }
    value = segments.joined(separator: "/")
  }
}

public struct PathError: Error, Equatable, CustomStringConvertible {
  public let description: String
  public init(_ description: String) { self.description = description }
}

public enum VaultFormat {
  private static let remote = try! NSRegularExpression(
    pattern: "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", options: [])

  public static func isSecretPath(_ path: String) -> Bool {
    for segment in path.split(separator: "/", omittingEmptySubsequences: false) {
      let name = asciiLowercased(String(segment))
      if name == ".env" || name == ".secrets" { return true }
      let suffix: Substring
      if name.hasPrefix(".env.") {
        suffix = name.dropFirst(5)
      } else if name.hasPrefix(".secrets.") {
        suffix = name.dropFirst(9)
      } else {
        continue
      }
      if !suffix.isEmpty
        && !suffix.unicodeScalars.contains(where: { [10, 13, 0x2028, 0x2029].contains($0.value) })
      {
        return true
      }
    }
    return false
  }

  private static func asciiLowercased(_ value: String) -> String {
    var scalars = String.UnicodeScalarView()
    for scalar in value.unicodeScalars {
      if (65...90).contains(scalar.value) {
        scalars.append(UnicodeScalar(scalar.value + 32)!)
      } else {
        scalars.append(scalar)
      }
    }
    return String(scalars)
  }

  public static func isLocalOnlyPath(_ path: String) -> Bool {
    path.split(separator: "/", omittingEmptySubsequences: false).contains {
      $0.range(of: ".local.") != nil
    } || isSecretPath(path)
  }

  public static func isInIgnoredDir(_ path: String) -> Bool {
    path.split(separator: "/", omittingEmptySubsequences: false).contains {
      $0 == ".git" || $0 == "node_modules"
    }
  }

  public static func isRemote(_ value: String) -> Bool {
    let range = NSRange(value.startIndex..., in: value)
    return remote.firstMatch(in: value, range: range)?.range == range && !value.contains("..")
  }
}
