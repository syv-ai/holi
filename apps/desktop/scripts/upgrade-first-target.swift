import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import ScreenCaptureKit
import Security
import UniformTypeIdentifiers

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

struct Identity {
  let start: UInt64
  let uid: uid_t
}

func canonical(_ path: String) -> String {
  URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
}

func emit(_ value: [String: Any]) -> Never {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
    fputs("invalid result\n", stderr)
    exit(1)
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

func reject(_ outcome: String, _ reason: String) -> Never {
  emit(["outcome": outcome, "reason": reason])
}

func privateDirectory(_ path: String) -> Bool {
  var info = stat()
  return lstat(path, &info) == 0 && info.st_uid == getuid()
    && (info.st_mode & S_IFMT) == S_IFDIR && (info.st_mode & 0o077) == 0
}

func identity(_ r: Request, bundle: String) -> Identity? {
  var info = proc_bsdinfo()
  guard proc_pidinfo(r.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
    == MemoryLayout<proc_bsdinfo>.size, info.pbi_uid == getuid() else { return nil }
  let start = UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec)
  guard start >= r.notBeforeMicros,
    r.expectedStartMicros == nil || r.expectedStartMicros == start,
    let metadata = NSDictionary(contentsOfFile: bundle + "/Contents/Info.plist"),
    let name = metadata["CFBundleExecutable"] as? String,
    !name.isEmpty, !name.contains("/"), name != ".", name != "..",
    metadata["CFBundleIdentifier"] as? String == "ai.syv.holi" else { return nil }
  var path = [CChar](repeating: 0, count: 4096)
  guard proc_pidpath(r.pid, &path, UInt32(path.count)) > 0,
    canonical(String(cString: path)) == bundle + "/Contents/MacOS/" + name,
    r.teamIdentifier.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { return nil }
  var code: SecCode?
  let attributes = [kSecGuestAttributePid: r.pid] as CFDictionary
  guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess,
    let code else { return nil }
  let expression = "anchor apple generic and identifier \"ai.syv.holi\" and certificate leaf[subject.OU] = \"\(r.teamIdentifier)\""
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess,
    let requirement, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { return nil }
  return Identity(start: start, uid: info.pbi_uid)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
  return value
}

func text(_ element: AXUIElement, _ name: String) -> String {
  attribute(element, name) as? String ?? ""
}

func label(_ element: AXUIElement) -> String {
  if text(element, kAXSubroleAttribute) == "AXSecureTextField" { return "" }
  for key in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute] {
    let value = text(element, key).trimmingCharacters(in: .whitespacesAndNewlines)
    if !value.isEmpty { return value }
  }
  return ""
}

func nodes(_ root: AXUIElement, pid: pid_t, deadline: Date) -> [AXUIElement] {
  var stack: [(AXUIElement, Int)] = [(root, 0)]
  var result: [AXUIElement] = []
  while let (element, depth) = stack.popLast(), result.count < 1000, Date() < deadline {
    var owner: pid_t = 0
    guard depth <= 35, AXUIElementGetPid(element, &owner) == .success, owner == pid else { continue }
    result.append(element)
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
      stack.append(contentsOf: children.reversed().map { ($0, depth + 1) })
    }
  }
  return result
}

func press(_ element: AXUIElement) -> Bool {
  var actions: CFArray?
  guard AXUIElementCopyActionNames(element, &actions) == .success,
    (actions as? [String])?.contains(kAXPressAction) == true else { return false }
  return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func rectangle(_ window: AXUIElement) -> CGRect? {
  guard let position = attribute(window, kAXPositionAttribute),
    let size = attribute(window, kAXSizeAttribute),
    CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero
  var dimensions = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
    AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
    dimensions.width > 0, dimensions.height > 0 else { return nil }
  return CGRect(origin: point, size: dimensions)
}

func matches(_ left: CGRect, _ right: CGRect) -> Bool {
  abs(left.minX - right.minX) <= 2 && abs(left.minY - right.minY) <= 2
    && abs(left.width - right.width) <= 2 && abs(left.height - right.height) <= 2
}

func connectedPanel(_ window: AXUIElement, pid: pid_t, email: String, deadline: Date) -> Bool {
  let content = nodes(window, pid: pid, deadline: deadline)
  if content.contains(where: { [kAXSheetRole, "AXDialog"].contains(text($0, kAXRoleAttribute)) || text($0, kAXSubroleAttribute) == kAXDialogSubrole }) { return false }
  guard content.contains(where: { text($0, kAXRoleAttribute) == "AXHeading" && label($0) == "Connections" }) else { return false }
  return content.filter { [kAXGroupRole, "AXWebArea"].contains(text($0, kAXRoleAttribute)) }.contains { group in
    let scoped = nodes(group, pid: pid, deadline: deadline)
    return scoped.contains { label($0) == "Google" }
      && scoped.contains { label($0) == email }
      && scoped.contains { text($0, kAXRoleAttribute) == kAXButtonRole && label($0) == "Disconnect this vault" }
      && !scoped.contains { text($0, kAXRoleAttribute) == kAXButtonRole && label($0) == "Reconnect" }
  }
}

func confirmExit(_ r: Request) -> Never {
  guard let expected = r.expectedStartMicros, expected >= r.notBeforeMicros else { reject("ownership-refused", "missing-start-identity") }
  var info = proc_bsdinfo()
  errno = 0
  let count = proc_pidinfo(r.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
  if count == 0 && errno == ESRCH {
    emit(["outcome": "exited", "pid": r.pid, "startMicros": expected])
  }
  guard count == MemoryLayout<proc_bsdinfo>.size, info.pbi_uid == getuid(),
    UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec) == expected else {
    reject("ownership-refused", "process-changed")
  }
  emit(["outcome": "still-running", "pid": r.pid, "startMicros": expected])
}

@MainActor
func observe(_ r: Request, root: String, bundle: String, id: Identity) async -> Never {
  guard r.expectedStartMicros == id.start else { reject("ownership-refused", "missing-start-identity") }
  let screen = CGPreflightScreenCaptureAccess()
  let accessibility = AXIsProcessTrusted()
  let permissions = ["screenCapture": screen, "accessibility": accessibility]
  guard screen, accessibility else {
    emit(["outcome": "precondition-unavailable", "reason": !screen ? "screen-capture-permission" : "accessibility-permission",
      "permissions": permissions, "pid": r.pid, "startMicros": id.start, "signatureVerified": true])
  }
  guard let email = r.email, email == "holi-upgrade-fixture@example.invalid",
    let destination = r.evidenceDirectory else { reject("ownership-refused", "invalid-observation-request") }
  let directory = canonical(destination)
  guard directory.hasPrefix(root + "/"), privateDirectory(directory) else {
    reject("ownership-refused", "evidence-directory")
  }
  let output = directory + "/first-target-google-connected.png"
  guard !FileManager.default.fileExists(atPath: output) else { reject("ownership-refused", "evidence-already-exists") }
  let deadline = Date().addingTimeInterval(20)
  let app = AXUIElementCreateApplication(r.pid)
  AXUIElementSetMessagingTimeout(app, 0.3)
  NSRunningApplication(processIdentifier: r.pid)?.activate(options: [])
  var selectedWindow: AXUIElement?
  var selectedBounds: CGRect?
  var requestedSettings = false
  var accountMenuOpened = false
  var requestedConnections = false
  for _ in 0..<50 {
    guard Date() < deadline else { break }
    guard identity(r, bundle: bundle)?.start == id.start else { reject("ownership-refused", "process-changed") }
    let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    let candidates = windows.filter { text($0, kAXRoleAttribute) == kAXWindowRole && rectangle($0) != nil }
    guard candidates.count <= 1 else { reject("observation-unavailable", "ambiguous-accessibility-window") }
    if let window = candidates.first {
      let content = nodes(window, pid: r.pid, deadline: deadline)
      if content.contains(where: { [kAXSheetRole, "AXDialog"].contains(text($0, kAXRoleAttribute)) || text($0, kAXSubroleAttribute) == kAXDialogSubrole }) {
        reject("observation-unavailable", "blocking-modal")
      }
      if connectedPanel(window, pid: r.pid, email: email, deadline: deadline) {
        selectedWindow = window; selectedBounds = rectangle(window); break
      }
      if !requestedSettings {
        let triggers = content.filter {
          text($0, kAXRoleAttribute) == kAXButtonRole
            && ["Account menu", "Open account menu", "Account menu, an update to look at", "Open account menu, an update to look at"].contains(label($0))
        }
        if !accountMenuOpened, triggers.count == 1 {
          accountMenuOpened = press(triggers[0])
        } else if accountMenuOpened {
          let menuItems = nodes(window, pid: r.pid, deadline: deadline).filter {
            text($0, kAXRoleAttribute) == kAXMenuItemRole && ["Settings", "Settings ⌘,", "Settings⌘,"].contains(label($0).split(whereSeparator: \.isWhitespace).joined(separator: " "))
          }
          if menuItems.count == 1 { requestedSettings = press(menuItems[0]) }
        }
      } else if !requestedConnections {
        if let connection = content.first(where: { label($0) == "Connections" && [kAXButtonRole, "AXLink", kAXRadioButtonRole].contains(text($0, kAXRoleAttribute)) }) {
          requestedConnections = press(connection)
        }
      }
    }
    try? await Task.sleep(nanoseconds: 200_000_000)
  }
  guard let window = selectedWindow, let bounds = selectedBounds else {
    reject("observation-unavailable", "connections-panel-not-asserted")
  }
  guard identity(r, bundle: bundle)?.start == id.start else { reject("ownership-refused", "process-changed") }
  do {
    let shareable = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let title = text(window, kAXTitleAttribute)
    let candidates = shareable.windows.filter {
      $0.owningApplication?.processID == r.pid && matches($0.frame, bounds)
        && (title.isEmpty || $0.title == title)
    }
    guard candidates.count == 1 else { reject("observation-unavailable", "ambiguous-capture-window") }
    let target = candidates[0]
    let configuration = SCStreamConfiguration()
    configuration.width = max(1, min(4096, Int(bounds.width * 2)))
    configuration.height = max(1, min(4096, Int(bounds.height * 2)))
    configuration.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: SCContentFilter(desktopIndependentWindow: target), configuration: configuration)
    guard identity(r, bundle: bundle)?.start == id.start else { reject("ownership-refused", "process-changed") }
    guard let currentBounds = rectangle(window), matches(currentBounds, bounds),
      connectedPanel(window, pid: r.pid, email: email, deadline: Date().addingTimeInterval(3)) else {
      reject("assertion-failed", "connections-panel-changed")
    }
    let data = NSMutableData()
    guard let writer = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
      reject("observation-unavailable", "image-encoding")
    }
    CGImageDestinationAddImage(writer, image, nil)
    guard CGImageDestinationFinalize(writer) else { reject("observation-unavailable", "image-encoding") }
    let descriptor = open(output, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { reject("ownership-refused", "image-output") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    try handle.write(contentsOf: data as Data)
    try handle.close()
    guard identity(r, bundle: bundle)?.start == id.start else {
      unlink(output)
      reject("ownership-refused", "process-changed")
    }
    emit(["outcome": "observed", "pid": r.pid, "startMicros": id.start, "signatureVerified": true,
      "windowId": target.windowID, "googleConnectionsPanelAsserted": true,
      "screenshot": "first-target-google-connected.png", "permissions": permissions])
  } catch {
    reject("observation-unavailable", "window-capture-failed")
  }
}

@main
struct Observer {
  static func main() async {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let r = try? JSONDecoder().decode(Request.self, from: data),
      ["identify", "observe", "confirm-exit"].contains(r.action), r.pid > 0 else {
      fputs("invalid request\n", stderr)
      exit(1)
    }
    let root = canonical(r.fixtureRoot)
    let bundle = canonical(r.bundlePath)
    guard privateDirectory(root),
      URL(fileURLWithPath: root).deletingLastPathComponent().path == canonical(NSTemporaryDirectory()),
      URL(fileURLWithPath: root).lastPathComponent.hasPrefix("holi-565-native-"),
      bundle.hasPrefix(root + "/") else { reject("ownership-refused", "fixture-ownership") }
    if r.action == "confirm-exit" { confirmExit(r) }
    guard let id = identity(r, bundle: bundle) else { reject("ownership-refused", "process-identity") }
    if r.action == "identify" {
      emit(["outcome": "identified", "pid": r.pid, "startMicros": id.start, "signatureVerified": true, "uid": id.uid])
    }
    await observe(r, root: root, bundle: bundle, id: id)
  }
}
