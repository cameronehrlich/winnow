import Foundation
import UIKit
import UserNotifications

extension Notification.Name {
    static let winnowPushOpened = Notification.Name("winnow.push.opened")
}

final class WinnowAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushNotificationManager.shared.didReceiveDeviceToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        PushNotificationManager.shared.didFailToRegister(error)
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        PushNotificationManager.shared.handleBackgroundPush(userInfo, completion: completionHandler)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound, .badge]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let content = response.notification.request.content.userInfo
        await MainActor.run {
            NotificationCenter.default.post(name: .winnowPushOpened, object: nil, userInfo: content)
        }
    }
}

@MainActor
final class PushNotificationManager {
    static let shared = PushNotificationManager()

    private let installationIDKey = "winnow.push.installation-id"
    private let registeredDeviceIDKey = "winnow.push.registered-device-id"
    private var configuration: ServerConfiguration?
    private var token: String?
    private var refreshHandler: (() async -> Bool)?

    private init() {}

    func activate(configuration: ServerConfiguration, refreshHandler: @escaping () async -> Bool) async {
        self.configuration = configuration
        self.refreshHandler = refreshHandler
        let center = UNUserNotificationCenter.current()
        do {
            let settings = await center.notificationSettings()
            if settings.authorizationStatus == .notDetermined {
                _ = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            }
            let updated = await center.notificationSettings()
            guard updated.authorizationStatus == .authorized || updated.authorizationStatus == .provisional else { return }
            UIApplication.shared.registerForRemoteNotifications()
            if token != nil { await registerCurrentToken() }
        } catch {
            // Notification permission is optional; foreground refresh remains available.
        }
    }

    func deactivate(configuration: ServerConfiguration) async {
        if let id = UserDefaults.standard.string(forKey: registeredDeviceIDKey), !id.isEmpty {
            try? await APIClient(configuration: configuration).unregisterPushDevice(id: id)
        }
        UserDefaults.standard.removeObject(forKey: registeredDeviceIDKey)
        self.configuration = nil
        refreshHandler = nil
    }

    func didReceiveDeviceToken(_ data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        Task { await registerCurrentToken() }
    }

    func didFailToRegister(_ error: Error) {
        // The simulator and unsigned builds can land here; do not interrupt app use.
    }

    func handleBackgroundPush(
        _ userInfo: [AnyHashable: Any],
        completion: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard let refreshHandler else {
            completion(.noData)
            return
        }
        Task {
            let changed = await refreshHandler()
            completion(changed ? .newData : .noData)
        }
    }

    func setAppIconBadge(_ count: Int) {
        UNUserNotificationCenter.current().setBadgeCount(max(0, count))
    }

    private func registerCurrentToken() async {
        guard let configuration, configuration.isComplete, let token, !token.isEmpty else { return }
        do {
            let device = try await APIClient(configuration: configuration).registerPushDevice(
                token: token,
                installationID: installationID,
                environment: apnsEnvironment,
                bundleID: Bundle.main.bundleIdentifier ?? "com.cameronehrlich.Winnow",
                appVersion: appVersion
            )
            UserDefaults.standard.set(device.id, forKey: registeredDeviceIDKey)
        } catch {
            // Registration retries on every app activation and APNs token callback.
        }
    }

    private var installationID: String {
        if let existing = UserDefaults.standard.string(forKey: installationIDKey), !existing.isEmpty { return existing }
        let created = UUID().uuidString
        UserDefaults.standard.set(created, forKey: installationIDKey)
        return created
    }

    private var apnsEnvironment: String {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        return build.isEmpty ? version : "\(version) (\(build))"
    }
}
