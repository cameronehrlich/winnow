import SwiftUI

@main
struct WinnowApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(WinnowDesign.indigo)
        }
    }
}
