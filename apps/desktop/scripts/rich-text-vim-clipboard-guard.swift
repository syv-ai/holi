import AppKit
import Darwin
import Foundation

struct GuardStatus: Codable {
  let event: String
  let itemCount: Int
  let typeCount: Int
  let restored: Bool?
  let verified: Bool?
  let preservedExternalChange: Bool?
  let unchanged: Bool?
}

struct SavedItem {
  let values: [(NSPasteboard.PasteboardType, Data)]
}

// The guard must outlive runner SIGINT/SIGTERM long enough to process restore on stdin.
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let pasteboard = NSPasteboard.general
let fixtureTexts: Set<String> = ["alpha"]

func snapshot() throws -> [SavedItem] {
  try (pasteboard.pasteboardItems ?? []).map { item in
    let values = try item.types.map { type -> (NSPasteboard.PasteboardType, Data) in
      guard let data = item.data(forType: type) else {
        throw NSError(domain: "ClipboardGuard", code: 1)
      }
      return (type, data)
    }
    return SavedItem(values: values)
  }
}

func countTypes(_ items: [SavedItem]) -> Int {
  items.reduce(0) { $0 + $1.values.count }
}

func currentItems() -> [NSPasteboardItem] {
  pasteboard.pasteboardItems ?? []
}

func isFixtureOwned() -> Bool {
  let items = currentItems()
  guard items.count == 1,
        let text = items[0].string(forType: .string),
        fixtureTexts.contains(text)
  else { return false }
  return true
}

func matches(_ saved: [SavedItem]) -> Bool {
  let current = currentItems()
  guard current.count == saved.count else { return false }
  for (index, savedItem) in saved.enumerated() {
    let item = current[index]
    guard Set(item.types) == Set(savedItem.values.map(\.0)) else { return false }
    for (type, bytes) in savedItem.values {
      guard item.data(forType: type) == bytes else { return false }
    }
  }
  return true
}

func emit(_ status: GuardStatus) {
  let encoder = JSONEncoder()
  if let data = try? encoder.encode(status), let line = String(data: data, encoding: .utf8) {
    print(line)
    fflush(stdout)
  }
}

let saved = try snapshot()
let baselineChangeCount = pasteboard.changeCount
emit(GuardStatus(event: "ready", itemCount: saved.count, typeCount: countTypes(saved), restored: nil, verified: nil, preservedExternalChange: nil, unchanged: nil))

func restore() -> Bool {
  if pasteboard.changeCount == baselineChangeCount {
    emit(GuardStatus(event: "restored", itemCount: saved.count, typeCount: countTypes(saved), restored: false, verified: true, preservedExternalChange: false, unchanged: true))
    return true
  }
  guard isFixtureOwned() else {
    emit(GuardStatus(event: "restored", itemCount: saved.count, typeCount: countTypes(saved), restored: false, verified: true, preservedExternalChange: true, unchanged: false))
    return true
  }

  let restoredItems = saved.map { savedItem -> NSPasteboardItem in
    let item = NSPasteboardItem()
    for (type, bytes) in savedItem.values { item.setData(bytes, forType: type) }
    return item
  }
  pasteboard.clearContents()
  let wrote = restoredItems.isEmpty || pasteboard.writeObjects(restoredItems)
  let verified = wrote && matches(saved)
  emit(GuardStatus(event: "restored", itemCount: saved.count, typeCount: countTypes(saved), restored: wrote, verified: verified, preservedExternalChange: false, unchanged: false))
  return verified
}

while let line = readLine() {
  if line == "restore" {
    exit(restore() ? 0 : 2)
  }
}
// A closed runner pipe is also a best-effort restoration path.
exit(restore() ? 0 : 2)
