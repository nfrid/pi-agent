import AppKit
import UserNotifications
import Darwin

let dashboardOrigin = "http://127.0.0.1:4174"
let dashboardBundle = "com.google.Chrome.app.famamklipjamakjadikolcemgkfbbpek"
let dashboardApp = URL(fileURLWithPath: "/Applications/Pi Dashboard.app")

func clickPath(_ value: String) -> String? {
    guard let url = URLComponents(string: value), url.scheme == "http", url.host == "127.0.0.1", url.port == 4174,
          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return nil }
    if url.percentEncodedPath == "/" { return "/" }
    let parts = url.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 3, parts[0].isEmpty, ["sessions", "runtimes"].contains(String(parts[1])), let id = String(parts[2]).removingPercentEncoding,
          !id.isEmpty, !id.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
    return url.percentEncodedPath
}

// A helper-local preference, independent of the daemon environment, also works
// when macOS cold-launches the helper for a delivered notification.
enum DashboardOpenMode: String {
    case chromePWA = "chrome-pwa"
    case defaultBrowser = "default-browser"
}

// Keep validation and side-effect selection shared by diagnostics and OS clicks.
// Browser navigation must not enqueue a PWA click: an open PWA could consume it.
@discardableResult func openDashboardClick(
    _ value: String,
    mode: String?,
    pwaIsValid: () -> Bool,
    sendClick: (String) -> Void,
    activatePWA: () -> Void,
    openBrowser: (URL) -> Bool
) -> Bool {
    guard let path = clickPath(value),
          let selected = DashboardOpenMode(rawValue: mode ?? DashboardOpenMode.chromePWA.rawValue),
          let url = URL(string: dashboardOrigin + path) else { return false }
    switch selected {
    case .chromePWA:
        guard pwaIsValid() else { return false }
        sendClick(value)
        activatePWA()
        return true
    case .defaultBrowser:
        return openBrowser(url)
    }
}

struct NotificationPayload {
    let id: String
    let title: String
    let subtitle: String
    let body: String
    let url: String
    init?(_ message: [String: Any]) {
        guard message["type"] as? String == "notify", let id = message["id"] as? String, !id.isEmpty,
              let title = message["title"] as? String, let subtitle = message["subtitle"] as? String,
              let body = message["body"] as? String, let url = message["url"] as? String, clickPath(url) != nil else { return nil }
        self.id = id; self.title = title; self.subtitle = subtitle; self.body = body; self.url = url
    }
}

if CommandLine.arguments.contains("--self-test") {
    precondition(clickPath(dashboardOrigin + "/sessions/a%2Fb") != nil)
    precondition(clickPath(dashboardOrigin + "/runtimes/runtime%2Fone") == "/runtimes/runtime%2Fone")
    precondition(clickPath(dashboardOrigin + "/") == "/")
    precondition(clickPath(dashboardOrigin + "/runtimes") == nil)
    for invalid in ["https://pi.nfrid.me/sessions/a", dashboardOrigin + "/api/sessions/a", dashboardOrigin + "/sessions/a?x=1", "http://user@127.0.0.1:4174/sessions/a", dashboardOrigin + "/sessions/%00"] {
        precondition(clickPath(invalid) == nil)
    }
    let wire = "{\"type\":\"notify\",\"id\":\"done\",\"title\":\"Project · literal\",\"subtitle\":\"Thread\",\"body\":\"Plain preview\",\"url\":\"http://127.0.0.1:4174/sessions/a%2Fb\"}"
    let decoded = try! JSONSerialization.jsonObject(with: Data(wire.utf8)) as! [String: Any]
    let payload = NotificationPayload(decoded)!
    precondition(payload.title == "Project · literal" && payload.subtitle == "Thread" && payload.body == "Plain preview")
    precondition(NotificationPayload(["type": "notify", "id": "bad", "url": "https://pi.nfrid.me/sessions/a"]) == nil)
    // Exercise the actual dispatcher with recorded effects, never real apps.
    let target = dashboardOrigin + "/sessions/a%2Fb"
    var effects: [String] = []
    func dispatch(_ value: String, _ mode: String?, validPWA: Bool = true, browserAccepted: Bool = true) -> Bool {
        effects = []
        return openDashboardClick(value, mode: mode, pwaIsValid: {
            effects.append("validate-pwa")
            return validPWA
        }, sendClick: { effects.append("socket:" + $0) }, activatePWA: {
            effects.append("activate-pwa")
        }, openBrowser: {
            effects.append("browser:" + $0.absoluteString)
            return browserAccepted
        })
    }
    for mode in [nil, "chrome-pwa"] as [String?] {
        precondition(dispatch(target, mode))
        precondition(effects == ["validate-pwa", "socket:" + target, "activate-pwa"])
        precondition(!dispatch(target, mode, validPWA: false))
        precondition(effects == ["validate-pwa"]) // no implicit browser fallback
    }
    for path in ["/", "/sessions/a%2Fb", "/runtimes/runtime%2Fone"] {
        let url = dashboardOrigin + path
        precondition(dispatch(url, "default-browser", validPWA: false))
        precondition(effects == ["browser:" + url]) // no bundle lookup or socket click
    }
    precondition(!dispatch(target, "default-browser", browserAccepted: false))
    precondition(effects == ["browser:" + target])
    precondition(!dispatch(target, "unknown"))
    precondition(effects.isEmpty)
    for mode in [nil, "chrome-pwa", "default-browser"] as [String?] {
        for invalid in [
            "https://pi.nfrid.me/sessions/a", "http://localhost:4174/sessions/a",
            "http://127.0.0.1:4173/sessions/a", "https://127.0.0.1:4174/sessions/a",
            "file:///sessions/a", "http://user@127.0.0.1:4174/sessions/a",
            dashboardOrigin + "/api/sessions/a", dashboardOrigin + "/sessions/a/b",
            dashboardOrigin + "/sessions/", dashboardOrigin + "/sessions/%00",
            dashboardOrigin + "/runtimes/%7F", dashboardOrigin + "/sessions/a?token=secret",
            dashboardOrigin + "/sessions/a#secret", dashboardOrigin + "/?x=1"
        ] {
            precondition(!dispatch(invalid, mode))
            precondition(effects.isEmpty)
        }
    }
    print("Native click, opening modes, and notification protocol validation passed")
    exit(0)
}

@MainActor final class Notifications: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var channel: FileHandle?
    private var input = Data()
    private let center = UNUserNotificationCenter.current()
    private func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        try? channel?.write(contentsOf: data + Data([10]))
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        center.delegate = self
        let arguments = CommandLine.arguments
        let defaults = UserDefaults.standard
        if let index = arguments.firstIndex(of: "--socket"), arguments.count > index + 1 {
            defaults.set(arguments[index + 1], forKey: "dashboardSocket")
        }
        guard let socketPath = defaults.string(forKey: "dashboardSocket") else { NSApp.terminate(nil); return }
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { NSApp.terminate(nil); return }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8) + [0]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { Darwin.close(fd); NSApp.terminate(nil); return }
        withUnsafeMutableBytes(of: &address.sun_path) { destination in destination.copyBytes(from: bytes) }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else { Darwin.close(fd); NSApp.terminate(nil); return }
        channel = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        channel?.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async { self?.receive(data) }
        }
    }
    private func receive(_ data: Data) {
        if data.isEmpty { channel?.readabilityHandler = nil; NSApp.terminate(nil); return }
        input.append(data)
        if input.count > 65536 { NSApp.terminate(nil); return }
        while let end = input.firstIndex(of: 10) {
            let line = input.prefix(upTo: end)
            input.removeSubrange(...end)
            if let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] { command(message) }
        }
    }
    private func status(_ id: String) {
        center.getNotificationSettings { settings in
            let permission: String
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: permission = "authorized"
            case .denied: permission = "denied"
            default: permission = "notDetermined"
            }
            DispatchQueue.main.async { self.send(["type": "status", "id": id, "permission": permission]) }
        }
    }
    private func command(_ message: [String: Any]) {
        guard let type = message["type"] as? String, let id = message["id"] as? String else { return }
        if type == "status" { status(id); return }
        if type == "click", let url = message["url"] as? String { let accepted = click(url); send(["type": "status", "id": id, "permission": accepted ? "diagnostic" : "invalidTarget"]); return }
        if type == "authorize" {
            center.requestAuthorization(options: [.alert]) { _, _ in DispatchQueue.main.async { self.status(id) } }
            return
        }
        guard let payload = NotificationPayload(message) else { return }
        let content = UNMutableNotificationContent()
        content.title = payload.title
        content.subtitle = payload.subtitle
        content.body = payload.body
        content.userInfo = ["url": payload.url]
        center.add(UNNotificationRequest(identifier: payload.id, content: content, trigger: nil)) { _ in }
    }
    // The diagnostic and OS callbacks deliberately share this handler.
    @discardableResult private func click(_ value: String) -> Bool {
        openDashboardClick(value, mode: UserDefaults.standard.string(forKey: "dashboardOpenMode"), pwaIsValid: {
            guard let bundle = Bundle(url: dashboardApp), bundle.bundleIdentifier == dashboardBundle,
                  let shortcut = bundle.object(forInfoDictionaryKey: "CrAppModeShortcutURL") as? String else { return false }
            return shortcut == dashboardOrigin + "/"
        }, sendClick: { self.send(["type": "click", "url": $0]) }, activatePWA: {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            NSWorkspace.shared.openApplication(at: dashboardApp, configuration: configuration) { _, _ in }
        }, openBrowser: { NSWorkspace.shared.open($0) })
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let value = response.notification.request.content.userInfo["url"] as? String
        let isClick = response.actionIdentifier == UNNotificationDefaultActionIdentifier
        DispatchQueue.main.async {
            if isClick, let value { self.click(value) }
            completionHandler()
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }
    func applicationWillTerminate(_ notification: Notification) { channel?.readabilityHandler = nil; try? channel?.close() }
}
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = Notifications()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
}
