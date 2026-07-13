import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab: RootTab = .inbox
    @State private var lastMailboxTab: MailboxTab = .inbox
    @State private var searchMailbox: MailboxTab = .inbox
    @State private var settingsPresented = false

    private enum RootTab: Hashable {
        case inbox, archived, ask, stats, search
    }

    var body: some View {
        Group {
            if model.isConfigured {
                configuredTabs.transition(.opacity)
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
        .onChange(of: selectedTab) { oldTab, newTab in
            if oldTab == .inbox { lastMailboxTab = .inbox }
            if oldTab == .archived { lastMailboxTab = .archived }
            if newTab == .inbox { lastMailboxTab = .inbox }
            if newTab == .archived { lastMailboxTab = .archived }
            if newTab == .search { searchMailbox = lastMailboxTab }
            model.setArchivedVisible(newTab == .archived)
        }
        .onChange(of: model.isConfigured) { _, isConfigured in
            if isConfigured, scenePhase == .active {
                Task { await model.refresh(silent: !model.emails.isEmpty) }
                model.startAutoRefresh()
            } else if !isConfigured {
                model.stopAutoRefresh()
            }
        }
        .onChange(of: model.askNavigationRequest) { _, request in
            guard let request else { return }
            settingsPresented = false
            selectedTab = .ask
            model.consumeAskNavigation(request)
        }
        .onOpenURL(perform: handleDeepLink)
        .onReceive(NotificationCenter.default.publisher(for: .winnowPushOpened)) { notification in
            let emailID = notification.userInfo?["emailId"] as? String ?? ""
            let mailbox = notification.userInfo?["mailboxState"] as? String ?? "inbox"
            open(emailID: emailID, mailbox: mailbox)
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
        .sheet(isPresented: $settingsPresented) {
            SettingsView()
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(30)
        }
    }

    @ViewBuilder
    private var configuredTabs: some View {
        if #available(iOS 26.0, *) {
            modernTabs
                .tabViewSearchActivation(.searchTabSelection)
        } else if #available(iOS 18.0, *) {
            modernTabs
        } else {
            legacyTabs
        }
    }

    @available(iOS 18.0, *)
    private var modernTabs: some View {
        TabView(selection: $selectedTab) {
            Tab("Inbox", systemImage: "tray.full", value: RootTab.inbox) {
                InboxView(mailbox: .inbox, openSettings: openSettings)
            }
            .badge(model.inboxBadgeCount)

            Tab("Archived", systemImage: "archivebox", value: RootTab.archived) {
                InboxView(mailbox: .archived, openSettings: openSettings)
            }
            .badge(model.archivedBadgeCount)

            Tab("Ask", systemImage: "sparkles", value: RootTab.ask) {
                AssistantMailboxView(openSettings: openSettings)
            }

            Tab("Stats", systemImage: "chart.bar.xaxis", value: RootTab.stats) {
                StatsView(openSettings: openSettings)
            }

            Tab("Search", systemImage: "magnifyingglass", value: RootTab.search, role: .search) {
                EmailSearchView(mailbox: $searchMailbox, openSettings: openSettings)
            }
        }
    }

    private var legacyTabs: some View {
        TabView(selection: $selectedTab) {
            InboxView(mailbox: .inbox, openSettings: openSettings)
                .tabItem { Label("Inbox", systemImage: "tray.full") }
                .badge(model.inboxBadgeCount)
                .tag(RootTab.inbox)

            InboxView(mailbox: .archived, openSettings: openSettings)
                .tabItem { Label("Archived", systemImage: "archivebox") }
                .badge(model.archivedBadgeCount)
                .tag(RootTab.archived)

            AssistantMailboxView(openSettings: openSettings)
                .tabItem { Label("Ask", systemImage: "sparkles") }
                .tag(RootTab.ask)

            StatsView(openSettings: openSettings)
                .tabItem { Label("Stats", systemImage: "chart.bar.xaxis") }
                .tag(RootTab.stats)

            EmailSearchView(mailbox: $searchMailbox, openSettings: openSettings)
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(RootTab.search)
        }
    }

    private func openSettings() {
        settingsPresented = true
    }

    private func handleDeepLink(_ url: URL) {
        guard url.scheme == "winnow" else { return }
        if url.host == "email" {
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let emailID = components?.queryItems?.first(where: { $0.name == "id" })?.value ?? ""
            let mailbox = components?.queryItems?.first(where: { $0.name == "mailbox" })?.value ?? "inbox"
            open(emailID: emailID, mailbox: mailbox)
        } else if url.host == "mailbox" {
            selectedTab = url.pathComponents.contains("archived") ? .archived : .inbox
        }
    }

    private func open(emailID: String, mailbox: String) {
        selectedTab = mailbox == "archived" ? .archived : .inbox
        guard !emailID.isEmpty else { return }
        Task {
            await model.refresh(silent: true)
            model.requestNavigation(emailID: emailID, mailboxState: mailbox)
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
