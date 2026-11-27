import Foundation
import ServiceManagement

func fail(_ message: String) -> Never { fputs("installer guard: \(message)\n", stderr); exit(2) }
func canonical(_ path: String) -> String { URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path }
let args = CommandLine.arguments
if args.count != 5 { fail("expected inspect|remove label artifact state") }
let mode = args[1], label = args[2], artifact = canonical(args[3]), state = canonical(args[4])
func matchingJob() -> [String: Any]? {
  guard let copied = SMCopyAllJobDictionaries(kSMDomainUserLaunchd) else { fail("launchd inspection failed") }
  let jobs = copied.takeRetainedValue() as NSArray
  let found = jobs.compactMap { $0 as? [String: Any] }.filter { ($0["Label"] as? String) == label }
  if found.count > 1 { fail("ambiguous matching jobs") }
  return found.first
}
func sanitized(_ job: [String: Any]?) -> [String: Any] {
  guard let job else { return ["present": false] }
  let allowed = ["Label", "Program", "ProgramArguments", "KeepAlive", "RunAtLoad"]
  var result: [String: Any] = ["present": true]
  for key in allowed { if let value = job[key] { result[key] = value } }
  return result
}
if mode == "inspect" { print(String(data: try! JSONSerialization.data(withJSONObject: sanitized(matchingJob())), encoding: .utf8)!); exit(0) }
guard mode == "remove" else { fail("invalid mode") }
guard let job = matchingJob() else { print("{\"present\":false,\"removed\":true}"); exit(0) }
guard let argv = job["ProgramArguments"] as? [String], argv.count >= 3 else { fail("invalid arguments") }
let framework = canonical((artifact as NSString).appendingPathComponent("Contents/Frameworks/Squirrel.framework"))
let expectedExe = canonical((framework as NSString).appendingPathComponent("Resources/ShipIt"))
guard canonical(argv[0]) == expectedExe, argv[1] == label, canonical(argv[2]) == state else { fail("job ownership mismatch") }
guard let requestData = try? Data(contentsOf: URL(fileURLWithPath: state)), let request = try? JSONSerialization.jsonObject(with: requestData) as? [String: Any], let target = request["targetBundleURL"] as? String, URL(string: target)?.isFileURL == true, canonical(URL(string: target)!.path) == artifact else { fail("state ownership mismatch") }
var error: Unmanaged<CFError>?
guard SMJobRemove(kSMDomainUserLaunchd, label as CFString, nil, true, &error) else { fail("job removal failed") }
guard matchingJob() == nil else { fail("job restarted or remains") }
print("{\"present\":false,\"removed\":true}")
