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

final class NavigationStats {
  var activationSucceeded = false
  var expectedTriggerByRole = false
  var expectedTriggerByLabel = false
  var triggerTitleSeen = false
  var triggerDescriptionSeen = false
  var triggerValueSeen = false
  var settingsMenuSeen = false
  var connectionsControlSeen = false
  var connectionsHeadingSeen = false
  var googleSeen = false
  var emailSeen = false
  var emailWithinLabelSeen = false
  var disconnectSeen = false
  var disconnectDescriptionSeen = false
  var accountPressSucceeded = false
  var settingsPressSucceeded = false
  var connectionsPressSucceeded = false
  var deadlineReached = false
  var childrenReadAttempted = false
  var snapshotDeadlineReached = false
  var snapshotNodeLimitReached = false
  var snapshotDepthLimitReached = false
  var snapshotReadFailed = false
  var navigationScanStarted = false
  var windowsSeen = 0
  var visited = 0
  var windowsStatus: Int32 = 0
  var childrenStatus: Int32 = 0
  let accountNames = ["Account menu", "Open account menu", "Account menu, an update to look at", "Open account menu, an update to look at"]

  func record(_ value: String) {
    expectedTriggerByLabel = expectedTriggerByLabel || accountNames.contains(value)
    googleSeen = googleSeen || value == "Google"
    emailSeen = emailSeen || value == "holi-upgrade-fixture@example.invalid"
    emailWithinLabelSeen = emailWithinLabelSeen || value.contains("holi-upgrade-fixture@example.invalid")
    disconnectSeen = disconnectSeen || value == "Disconnect this vault"
  }

  var json: [String: Any] {
    ["activationSucceeded": activationSucceeded, "expectedTriggerByRole": expectedTriggerByRole,
      "expectedTriggerByLabel": expectedTriggerByLabel, "triggerTitleSeen": triggerTitleSeen,
      "triggerDescriptionSeen": triggerDescriptionSeen, "triggerValueSeen": triggerValueSeen,
      "settingsMenuSeen": settingsMenuSeen, "connectionsControlSeen": connectionsControlSeen,
      "connectionsHeadingSeen": connectionsHeadingSeen, "googleSeen": googleSeen,
      "emailSeen": emailSeen, "emailWithinLabelSeen": emailWithinLabelSeen,
      "disconnectSeen": disconnectSeen, "disconnectDescriptionSeen": disconnectDescriptionSeen,
      "accountPressSucceeded": accountPressSucceeded, "settingsPressSucceeded": settingsPressSucceeded,
      "connectionsPressSucceeded": connectionsPressSucceeded, "deadlineReached": deadlineReached,
      "childrenReadAttempted": childrenReadAttempted, "windowsSeen": windowsSeen,
      "visited": visited, "windowsStatus": windowsStatus, "childrenStatus": childrenStatus,
      "snapshotDeadlineReached": snapshotDeadlineReached, "snapshotNodeLimitReached": snapshotNodeLimitReached,
      "snapshotDepthLimitReached": snapshotDepthLimitReached, "snapshotReadFailed": snapshotReadFailed,
      "navigationScanStarted": navigationScanStarted]
  }
}

func readAttribute(_ element: AXUIElement, _ name: String) -> (CFTypeRef?, AXError) {
  var value: CFTypeRef?
  let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
  return (status == .success ? value : nil, status)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  readAttribute(element, name).0
}

func text(_ element: AXUIElement, _ name: String) -> String {
  attribute(element, name) as? String ?? ""
}

// One bounded AX traversal per observation iteration. Attribute values are cached only for this
// snapshot; after a press the next iteration must observe a fresh tree. Every cold
// role/subrole/label read shares the traversal deadline and can invalidate the tree;
// completeness is rechecked before any press or connected-panel assertion.
final class ObservedNode {
  let element: AXUIElement
  let parent: Int?
  unowned let snapshot: WindowSnapshot
  init(_ element: AXUIElement, parent: Int?, snapshot: WindowSnapshot) {
    self.element = element; self.parent = parent; self.snapshot = snapshot
  }
  func label(_ attribute: String, required: Bool = false) -> String {
    guard let value = snapshot.read(element, attribute, optional: !required) else { return "" }
    guard let string = value as? String else {
      if attribute != kAXValueAttribute { snapshot.valid = false }
      return ""
    }
    return string
  }
  lazy var role = label(kAXRoleAttribute, required: true)
  lazy var subrole = label(kAXSubroleAttribute)
  lazy var title = label(kAXTitleAttribute)
  lazy var value = label(kAXValueAttribute)
  lazy var description = label(kAXDescriptionAttribute)
  lazy var name: String = {
    if subrole == "AXSecureTextField" { return "" }
    let titleLabel = title.trimmingCharacters(in: .whitespacesAndNewlines)
    if !titleLabel.isEmpty { return titleLabel }
    let valueLabel = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if !valueLabel.isEmpty { return valueLabel }
    return description.trimmingCharacters(in: .whitespacesAndNewlines)
  }()
}

final class WindowSnapshot {
  var content: [ObservedNode] = []
  var valid = true
  var traversed = false
  let deadline: Date
  let stats: NavigationStats?
  init(deadline: Date, stats: NavigationStats? = nil) { self.deadline = deadline; self.stats = stats }
  var complete: Bool { traversed && valid && Date() < deadline }

  func read(_ element: AXUIElement, _ name: String, optional: Bool = false) -> CFTypeRef? {
    guard valid, Date() < deadline else { valid = false; return nil }
    let (value, status) = readAttribute(element, name)
    if name == kAXWindowsAttribute { stats?.windowsStatus = status.rawValue }
    if name == kAXChildrenAttribute, let stats {
      if !stats.childrenReadAttempted || status != .success {
        stats.childrenStatus = status.rawValue
      }
      stats.childrenReadAttempted = true
    }
    guard Date() < deadline else { valid = false; return nil }
    // AXError.h defines these as unsupported attribute / supported but no value.
    // AXChildren is required only for elements containing subelements
    // (AXAttributeConstants.h): these two statuses, or a successful empty array,
    // are legitimate leaves. Messaging/owner errors and malformed success are not.
    if optional && (status == .attributeUnsupported || status == .noValue) { return nil }
    guard status == .success, let value else {
      valid = false
      stats?.snapshotReadFailed = true
      return nil
    }
    return value
  }
}

func nodes(_ root: AXUIElement, pid: pid_t, deadline: Date, stats: NavigationStats? = nil) -> WindowSnapshot {
  let snapshot = WindowSnapshot(deadline: deadline, stats: stats)
  var stack: [(AXUIElement, Int, Int?)] = [(root, 0, nil)]
  var depthLimited = false
  while !stack.isEmpty, snapshot.content.count < 1000, snapshot.valid, Date() < deadline {
    let (element, depth, parent) = stack.removeLast()
    if depth > 35 { depthLimited = true; break }
    var owner: pid_t = 0
    guard AXUIElementGetPid(element, &owner) == .success, owner == pid, Date() < deadline else {
      snapshot.valid = false
      stats?.snapshotReadFailed = true
      break
    }
    let index = snapshot.content.count
    let node = ObservedNode(element, parent: parent, snapshot: snapshot)
    snapshot.content.append(node)
    if let stats { stats.visited = min(10000, stats.visited + 1) }
    let childValue = snapshot.read(element, kAXChildrenAttribute, optional: true)
    if let childValue {
      guard let children = childValue as? [AXUIElement] else { snapshot.valid = false; break }
      stack.append(contentsOf: children.reversed().map { ($0, depth + 1, index) })
    }
  }
  if let stats {
    stats.snapshotDeadlineReached = stats.snapshotDeadlineReached || Date() >= deadline
    stats.snapshotNodeLimitReached = stats.snapshotNodeLimitReached || (!stack.isEmpty && snapshot.content.count >= 1000)
    stats.snapshotDepthLimitReached = stats.snapshotDepthLimitReached || depthLimited
    stats.snapshotReadFailed = stats.snapshotReadFailed || (!snapshot.valid && Date() < deadline)
  }
  snapshot.traversed = stack.isEmpty && !depthLimited
  return snapshot
}

func press(_ element: AXUIElement, snapshot: WindowSnapshot) -> Bool {
  guard snapshot.complete else { return false }
  var actions: CFArray?
  guard AXUIElementCopyActionNames(element, &actions) == .success,
    snapshot.complete, (actions as? [String])?.contains(kAXPressAction) == true else { return false }
  return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func rectangle(_ window: AXUIElement, snapshot: WindowSnapshot) -> CGRect? {
  guard let position = snapshot.read(window, kAXPositionAttribute),
    let size = snapshot.read(window, kAXSizeAttribute),
    CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else {
    snapshot.valid = false
    return nil
  }
  var point = CGPoint.zero
  var dimensions = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
    AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
    dimensions.width > 0, dimensions.height > 0 else {
    snapshot.valid = false
    return nil
  }
  return CGRect(origin: point, size: dimensions)
}

func matches(_ left: CGRect, _ right: CGRect) -> Bool {
  abs(left.minX - right.minX) <= 2 && abs(left.minY - right.minY) <= 2
    && abs(left.width - right.width) <= 2 && abs(left.height - right.height) <= 2
}

func connectedPanel(_ snapshot: WindowSnapshot, email: String, deadline: Date, stats: NavigationStats? = nil) -> Bool {
  guard snapshot.complete, Date() < deadline else { return false }
  let content = snapshot.content
  if content.contains(where: { Date() < deadline && ([kAXSheetRole, "AXDialog"].contains($0.role) || $0.subrole == kAXDialogSubrole) }) { return false }
  let heading = content.contains(where: { Date() < deadline && $0.role == "AXHeading" && $0.name == "Connections" })
  if heading { stats?.connectionsHeadingSeen = true }
  guard heading else { return false }
  // Accumulate descendant facts bottom-up instead of re-reading every group's
  // subtree through AX (quadratic work for nested groups). Each scope still
  // requires Google + the exact fixture email + Disconnect and forbids Reconnect.
  var facts = [Int](repeating: 0, count: content.count)
  var connected = false
  for index in content.indices.reversed() {
    guard Date() < deadline else { return false }
    let node = content[index]
    let name = node.name
    stats?.record(name)
    if name == "Google" { facts[index] |= 1 }
    if name == email { facts[index] |= 2 }
    if node.role == kAXButtonRole && name == "Disconnect this vault" { facts[index] |= 4 }
    if node.role == kAXButtonRole && name == "Reconnect" { facts[index] |= 8 }
    if [kAXGroupRole, "AXWebArea"].contains(node.role), facts[index] == 7 { connected = true }
    if let parent = node.parent { facts[parent] |= facts[index] }
  }
  return connected && snapshot.complete
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
  let stats = NavigationStats()
  stats.activationSucceeded = NSRunningApplication(processIdentifier: r.pid)?.activate(options: []) ?? false
  var selectedWindow: AXUIElement?
  var selectedBounds: CGRect?
  var requestedSettings = false
  var accountMenuOpened = false
  var requestedConnections = false
  while Date() < deadline {
    guard identity(r, bundle: bundle)?.start == id.start else { reject("ownership-refused", "process-changed") }
    let discovery = WindowSnapshot(deadline: deadline, stats: stats)
    discovery.traversed = true
    let windowValue = discovery.read(app, kAXWindowsAttribute)
    let windows = windowValue as? [AXUIElement] ?? []
    if !(windowValue is [AXUIElement]) { discovery.valid = false }
    stats.windowsSeen = max(stats.windowsSeen, min(10000, windows.count))
    var candidates: [AXUIElement] = []
    for window in windows {
      guard discovery.complete else { break }
      guard let role = discovery.read(window, kAXRoleAttribute) as? String else {
        discovery.valid = false
        break
      }
      if role == kAXWindowRole, rectangle(window, snapshot: discovery) != nil { candidates.append(window) }
    }
    guard discovery.complete else {
      try? await Task.sleep(nanoseconds: 200_000_000)
      continue
    }
    guard candidates.count <= 1 else { reject("observation-unavailable", "ambiguous-accessibility-window") }
    if let window = candidates.first {
      let snapshot = nodes(window, pid: r.pid, deadline: deadline, stats: stats)
      guard snapshot.complete else {
        try? await Task.sleep(nanoseconds: 200_000_000)
        continue
      }
      let content = snapshot.content
      if content.contains(where: { Date() < deadline && ([kAXSheetRole, "AXDialog"].contains($0.role) || $0.subrole == kAXDialogSubrole) }) {
        reject("observation-unavailable", "blocking-modal")
      }
      if connectedPanel(snapshot, email: email, deadline: deadline, stats: stats) {
        selectedWindow = window; selectedBounds = rectangle(window, snapshot: snapshot); break
      }
      guard snapshot.complete else { continue }
      stats.navigationScanStarted = true
      if !requestedSettings {
        let connectionsControls = content.filter {
          Date() < deadline && [kAXButtonRole, "AXLink", kAXRadioButtonRole].contains($0.role) && $0.name == "Connections"
        }
        if connectionsControls.count == 1 {
          stats.connectionsControlSeen = true
          requestedSettings = Date() < deadline && press(connectionsControls[0].element, snapshot: snapshot)
          requestedConnections = requestedSettings
          stats.connectionsPressSucceeded = stats.connectionsPressSucceeded || requestedSettings
          if requestedSettings { continue }
        }
        let triggers = content.filter { element in
          guard Date() < deadline, [kAXButtonRole, kAXPopUpButtonRole].contains(element.role) else { return false }
          let name = element.name
          stats.record(name)
          let matched = stats.accountNames.contains(name)
          stats.expectedTriggerByRole = stats.expectedTriggerByRole || matched
          stats.triggerTitleSeen = stats.triggerTitleSeen || stats.accountNames.contains(element.title)
          stats.triggerDescriptionSeen = stats.triggerDescriptionSeen || stats.accountNames.contains(element.description)
          stats.triggerValueSeen = stats.triggerValueSeen || stats.accountNames.contains(element.value)
          if name == "Disconnect" {
            stats.disconnectDescriptionSeen = stats.disconnectDescriptionSeen || element.description == "Disconnect this vault"
          }
          if name == "Connections" { stats.connectionsControlSeen = true }
          return matched
        }
        if !requestedSettings, !accountMenuOpened, triggers.count == 1 {
          accountMenuOpened = Date() < deadline && press(triggers[0].element, snapshot: snapshot)
          stats.accountPressSucceeded = stats.accountPressSucceeded || accountMenuOpened
        } else if !requestedSettings, accountMenuOpened {
          let menuItems = content.filter {
            Date() < deadline && $0.role == kAXMenuItemRole && ["Settings", "Settings ⌘,", "Settings⌘,"].contains($0.name.split(whereSeparator: \.isWhitespace).joined(separator: " "))
          }
          stats.settingsMenuSeen = stats.settingsMenuSeen || !menuItems.isEmpty
          if menuItems.count == 1 { requestedSettings = Date() < deadline && press(menuItems[0].element, snapshot: snapshot) }
          stats.settingsPressSucceeded = stats.settingsPressSucceeded || requestedSettings
        }
      } else if !requestedConnections {
        let connections = content.filter { Date() < deadline && [kAXButtonRole, "AXLink", kAXRadioButtonRole].contains($0.role) && $0.name == "Connections" }
        if connections.count == 1 {
          stats.connectionsControlSeen = true
          requestedConnections = Date() < deadline && press(connections[0].element, snapshot: snapshot)
          stats.connectionsPressSucceeded = stats.connectionsPressSucceeded || requestedConnections
        }
      }
    }
    try? await Task.sleep(nanoseconds: 200_000_000)
  }
  guard let window = selectedWindow, let bounds = selectedBounds else {
    stats.deadlineReached = Date() >= deadline
    guard identity(r, bundle: bundle)?.start == id.start else { reject("ownership-refused", "process-changed") }
    emit(["outcome": "observation-unavailable", "reason": "connections-panel-not-asserted",
      "pid": r.pid, "startMicros": id.start, "signatureVerified": true,
      "googleConnectionsPanelAsserted": false, "permissions": permissions,
      "navigationStats": stats.json])
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
    let assertionDeadline = Date().addingTimeInterval(3)
    let assertion = nodes(window, pid: r.pid, deadline: assertionDeadline)
    guard let currentBounds = rectangle(window, snapshot: assertion), matches(currentBounds, bounds),
      connectedPanel(assertion, email: email, deadline: assertionDeadline) else {
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
