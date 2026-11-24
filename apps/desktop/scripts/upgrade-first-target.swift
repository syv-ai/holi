import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Security
import ScreenCaptureKit
import Darwin

struct Request: Decodable {
  let action: String
  let fixtureRoot: String
  let bundlePath: String
  let teamIdentifier: String
  let pid: Int32
  let notBeforeMicros: UInt64
  let expectedStartMicros: UInt64?
  let email: String?
  let evidenceDirectory: String?
}

struct Identity { let start: UInt64; let uid: uid_t; let bundle: String }
func canonical(_ path: String) -> String { URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path }
func emit(_ value: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data("\n".utf8)); exit(0)
}
func unavailable(_ reason: String) -> Never { emit(["outcome":"observation-unavailable", "reason":reason]) }
func refused(_ reason: String) -> Never { emit(["outcome":"ownership-refused", "reason":reason]) }
func micros(_ tv: timeval) -> UInt64 { UInt64(tv.tv_sec) * 1_000_000 + UInt64(tv.tv_usec) }
func identity(_ r: Request, root: String, bundle: String) -> Identity? {
  var info = proc_bsdinfo()
  guard proc_pidinfo(r.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size else { return nil }
  guard info.pbi_uid == getuid() else { return nil }
  let start = UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec)
  guard start >= r.notBeforeMicros, r.expectedStartMicros == nil || r.expectedStartMicros == start else { return nil }
  var path = [CChar](repeating: 0, count: 4096)
  guard proc_pidpath(r.pid, &path, UInt32(path.count)) > 0 else { return nil }
  let executable = canonical(String(cString: path))
  guard executable.hasPrefix(bundle + "/Contents/") else { return nil }
  var attributes = [CFString: Any]()
  attributes[kSecGuestAttributePid] = r.pid
  var code: SecCode?
  guard SecCodeCopyGuestWithAttributes(nil, attributes as CFDictionary, [], &code) == errSecSuccess, let code else { return nil }
  let requirement = "anchor apple generic and identifier \"ai.syv.holi\" and certificate leaf[subject.OU] = \"\(r.teamIdentifier)\""
  guard r.teamIdentifier.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { return nil }
  var req: SecRequirement?
  guard SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess,
        let req, SecCodeCheckValidity(code, [], req) == errSecSuccess else { return nil }
  return Identity(start: start, uid: info.pbi_uid, bundle: bundle)
}
func main() {
  guard let data = FileHandle.standardInput.readDataToEndOfFile() as Data?, let r = try? JSONDecoder().decode(Request.self, from: data), ["identify", "observe"].contains(r.action) else {
    fputs("invalid request\n", stderr); exit(1)
  }
  guard r.pid > 0 else { refused("invalid-path") }
  let root = canonical(r.fixtureRoot), bundle = canonical(r.bundlePath)
  var st = stat()
  guard lstat(root, &st) == 0, st.st_uid == getuid(), (st.st_mode & S_IFMT) == S_IFDIR,
        URL(fileURLWithPath: root).lastPathComponent.hasPrefix("holi-565-native-"),
        bundle.hasPrefix(root + "/"), FileManager.default.fileExists(atPath: bundle + "/Contents/Info.plist") else { refused("fixture-ownership") }
  guard let id = identity(r, root: root, bundle: bundle) else { refused("process-identity") }
  if r.action == "identify" { emit(["outcome":"identified", "pid":r.pid, "startMicros":id.start, "signatureVerified":true, "uid":id.uid]) }
  let screen = CGPreflightScreenCaptureAccess(), accessibility = AXIsProcessTrusted()
  guard screen, accessibility else { emit(["outcome":"precondition-unavailable", "reason": !screen ? "screen-capture-permission" : "accessibility-permission", "permissions":["screenCapture":screen,"accessibility":accessibility], "pid":r.pid,"startMicros":id.start,"signatureVerified":true]) }
  guard identity(r, root: root, bundle: bundle)?.start == id.start else { refused("process-changed") }
  let app = AXUIElementCreateApplication(r.pid)
  var windowsValue: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsValue) == .success,
        let windows = windowsValue as? [AXUIElement], !windows.isEmpty else { unavailable("accessibility-windows") }
  // Only bounded, public AX operations are allowed. Never expose AX text or paths.
  guard let email = r.email, !email.isEmpty else { unavailable("fixture-email-missing") }
  _ = windows
  _ = SCShareableContent.self
  guard identity(r, root: root, bundle: bundle)?.start == id.start else { refused("process-changed") }
  unavailable("connections-panel-not-asserted")
}
main()
