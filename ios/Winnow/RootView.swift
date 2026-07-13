import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab = 0

    var body: some View {
        Group {
            if model.isConfigured {
                TabView(selection: $selectedTab) {
                    InboxView()
                        .tabItem { Label("Inbox", systemImage: "tray.full") }
                        .tag(0)

                    TodayView()
                        .tabItem { Label("Today", systemImage: "sparkles") }
                        .tag(1)

                    SettingsView()
                        .tabItem { Label("Settings", systemImage: "gearshape") }
                        .tag(2)
                }
                .transition(.opacity)
            } else {
                OnboardingView()
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))
            }
        }
        .animation(.easeOut(duration: 0.25), value: model.isConfigured)
        .task {
            await model.initialLoad()
            if scenePhase == .active { model.startAutoRefresh() }
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                Task { await model.refresh(silent: !model.emails.isEmpty) }
                model.startAutoRefresh()
            } else {
                model.stopAutoRefresh()
            }
        }
        .onChange(of: model.isConfigured) { _, isConfigured in
            if isConfigured, scenePhase == .active {
                Task { await model.refresh(silent: !model.emails.isEmpty) }
                model.startAutoRefresh()
            } else if !isConfigured {
                model.stopAutoRefresh()
            }
        }
        .alert(item: $model.presentedError) { error in
            Alert(title: Text(error.title), message: Text(error.message), dismissButton: .default(Text("OK")))
        }
        .overlay(alignment: .top) {
            if let toast = model.toast {
                ToastView(toast: toast)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: toast.id) {
                        try? await Task.sleep(for: .seconds(2.2))
                        guard model.toast?.id == toast.id else { return }
                        withAnimation { model.toast = nil }
                    }
            }
        }
    }
}

private struct OnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @State private var serverURL = ""
    @State private var token = ""
    @FocusState private var focusedField: Field?

    private enum Field { case url, token }

    var body: some View {
        ZStack {
            AppBackdrop()
            ScrollView {
                VStack(spacing: 28) {
                    Spacer(minLength: 40)

                    VStack(spacing: 18) {
                        WinnowMark(size: 82)
                        VStack(spacing: 8) {
                            Text("Your inbox, distilled.")
                                .font(.largeTitle.bold())
                                .multilineTextAlignment(.center)
                            Text("Fast private triage without Slack in the way.")
                                .font(.title3)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                    }

                    VStack(alignment: .leading, spacing: 16) {
                        Text("Connect to Winnow")
                            .font(.headline)

                        VStack(alignment: .leading, spacing: 7) {
                            Text("SERVER URL").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                            TextField("https://your-winnow-host", text: $serverURL)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                                .textContentType(.URL)
                                .focused($focusedField, equals: .url)
                                .submitLabel(.next)
                                .onSubmit { focusedField = .token }
                                .padding(14)
                                .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        }

                        VStack(alignment: .leading, spacing: 7) {
                            Text("BEARER TOKEN").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                            SecureField("API token", text: $token)
                                .textContentType(.password)
                                .focused($focusedField, equals: .token)
                                .submitLabel(.go)
                                .onSubmit { connect() }
                                .padding(14)
                                .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        }

                        Button(action: connect) {
                            HStack {
                                if model.isLoading { ProgressView().tint(.white) }
                                Text(model.isLoading ? "Connecting…" : "Connect")
                                if !model.isLoading { Image(systemName: "arrow.right") }
                            }
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .foregroundStyle(.white)
                            .background(WinnowDesign.heroGradient, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                        .disabled(model.isLoading || serverURL.isEmpty || token.isEmpty)

                        Label("The token stays in your iPhone Keychain.", systemImage: "lock.fill")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .winnowCard(padding: 20)

                    Spacer(minLength: 28)
                }
                .padding(.horizontal, 20)
            }
        }
        .onAppear {
            serverURL = model.configuration.serverURL
            token = model.configuration.token
        }
    }

    private func connect() {
        focusedField = nil
        Task { _ = await model.saveAndConnect(serverURL: serverURL, token: token) }
    }
}
