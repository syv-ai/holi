import Foundation
import UserNotifications

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    fputs("expected fixture bundle identifier\n", stderr)
    exit(2)
}
let expected = arguments[1]
guard let actual = Bundle.main.bundleIdentifier, actual == expected else {
    fputs("owned app bundle identity mismatch\n", stderr)
    exit(3)
}
UNUserNotificationCenter.current().getNotificationSettings { settings in
    var evidence: [String: Any] = [
        "bundleIdentifier": actual,
        "authorizationStatus": settings.authorizationStatus.rawValue,
        "alertStyle": settings.alertStyle.rawValue,
        "alertSetting": settings.alertSetting.rawValue,
        "notificationCenterSetting": settings.notificationCenterSetting.rawValue
    ]
    if #available(macOS 13.0, *) {
        evidence["scheduledDeliverySetting"] = settings.scheduledDeliverySetting.rawValue
        evidence["timeSensitiveSetting"] = settings.timeSensitiveSetting.rawValue
    }
    do {
        let data = try JSONSerialization.data(withJSONObject: evidence, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        exit(0)
    } catch {
        fputs("could not encode notification settings\n", stderr)
        exit(4)
    }
}
RunLoop.current.run()
