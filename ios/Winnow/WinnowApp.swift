import SwiftUI

@main
struct WinnowApp: App {
    @UIApplicationDelegateAdaptor(WinnowAppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(WinnowDesign.accent)
        }
    }
}
