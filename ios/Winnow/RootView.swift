import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var selectedTab: RootTab = .inbox
    @State private var selectedRegularEmailID: String?
    @State private var settingsPresented = false
    @State private var statsPresented = false
    @State private var askPresented = false
    @State private var askStatsPresented = false

    private enum RootTab: Hashable, CaseIterable {
        case inbox, archived, ask

        var title: String {
            switch self {
            case .inbox: "Inbox"
            case .archived: "Archived"
            case .ask: "Ask Winnow"
            }
        }

        var systemImage: String {
            switch self {
            case .inbox: "tray.full"
            case .archived: "archivebox"
            case .ask: "bubble.left.and.bubble.right.fill"
            }
        }
    }

    var body: some View {
        Group {
            if model.isConfigured {
                configuredContent.transition(.opacity)
            } else {
                OnboardingView()
                    .transition(.opacity.combined(with: .scale(scale: 0.98)))
            }
        }
        .animation(.easeOut(duration: 0.25), value: model.isConfigured)
        .task {
            await model.initialLoad()
            if scenePhase == .active {
                model.setVisibleMailbox(mailbox(for: selectedTab))
                model.startAutoRefresh()
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                model.setVisibleMailbox(mailbox(for: selectedTab))
                Task { await model.refreshAutomatically() }
                model.startAutoRefresh()
            } else {
                model.setVisibleMailbox(nil)
                model.stopAutoRefresh()
            }
        }
        .onChange(of: selectedTab) { oldTab, newTab in
            model.setVisibleMailbox(mailbox(for: newTab))
            if usesRegularLayout,
               oldTab != newTab,
               selectedRegularEmailID.flatMap(model.email(id:)).map({ mailbox(for: newTab)?.includes($0) }) != true {
                selectedRegularEmailID = nil
            }
        }
        .onChange(of: model.isConfigured) { _, isConfigured in
            if isConfigured, scenePhase == .active {
                Task { await model.refreshAutomatically() }
                model.startAutoRefresh()
            } else if !isConfigured {
                model.stopAutoRefresh()
            }
        }
        .onChange(of: model.askNavigationRequest) { _, request in
            guard let request else { return }
            presentAsk()
            model.consumeAskNavigation(request)
        }
        .onChange(of: model.navigationRequest) { _, request in
            guard usesRegularLayout, let request else { return }
            selectedTab = request.mailboxState == MailboxTab.archived.apiState ? .archived : .inbox
            selectedRegularEmailID = request.emailID
            model.consumeNavigation(request)
        }
        .onOpenURL(perform: handleDeepLink)
        .onReceive(NotificationCenter.default.publisher(for: .winnowPushOpened)) { notification in
            let userInfo = notification.userInfo ?? [:]
            let context = WinnowPushContext(userInfo: userInfo)
            let focusConversation = userInfo["winnowDestination"] as? String
                == WinnowNotificationIdentifier.conversationDestination
            open(
                emailID: context.emailID,
                mailbox: context.mailboxState,
                account: context.account,
                threadID: context.threadID,
                focusConversation: focusConversation
            )
        }
        .alert(item: $model.presentedError) { error in
            if let actionTitle = error.actionTitle, let actionURL = error.actionURL {
                Alert(
                    title: Text(error.title),
                    message: Text(error.message),
                    primaryButton: .default(Text(actionTitle)) {
                        openURL(actionURL)
                    },
                    secondaryButton: .cancel()
                )
            } else {
                Alert(title: Text(error.title), message: Text(error.message), dismissButton: .default(Text("OK")))
            }
        }
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                ToastView(toast: toast)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 82)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
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
        .sheet(isPresented: $statsPresented) {
            StatsView()
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(30)
        }
        .sheet(isPresented: $askPresented) {
            AssistantMailboxView(
                openStats: { askStatsPresented = true },
                dismiss: { askPresented = false }
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            .presentationCornerRadius(34)
            .sheet(isPresented: $askStatsPresented) {
                StatsView()
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(30)
            }
        }
    }

    @ViewBuilder
    private var configuredContent: some View {
        if usesRegularLayout {
            regularNavigation
        } else {
            configuredTabs
        }
    }

    @ViewBuilder
    private var configuredTabs: some View {
        if #available(iOS 26.0, *) {
            modernTabs
        } else if #available(iOS 18.0, *) {
            modernTabs
        } else {
            legacyTabs
        }
    }

    @ViewBuilder
    private var regularNavigation: some View {
        if selectedTab == .ask {
            NavigationSplitView {
                regularSidebar
            } detail: {
                AssistantMailboxView(openStats: openStats)
            }
            .navigationSplitViewStyle(.balanced)
        } else {
            NavigationSplitView {
                regularSidebar
            } content: {
                NavigationStack {
                    MailboxListView(
                        mailbox: selectedTab == .archived ? .archived : .inbox,
                        showsSettingsButton: false,
                        openSettings: openSettings,
                        openStats: openStats
                    ) { item in
                        selectedRegularEmailID = item.id
                    }
                    .id(selectedTab)
                }
                .navigationSplitViewColumnWidth(min: 330, ideal: 390, max: 480)
            } detail: {
                NavigationStack {
                    if let selectedRegularEmailID {
                        EmailDetailView(emailID: selectedRegularEmailID)
                            .id(selectedRegularEmailID)
                    } else {
                        ContentUnavailableView {
                            Label("Select an Email", systemImage: "envelope.open")
                        } description: {
                            Text("Choose a message to read it without losing your place.")
                        }
                    }
                }
            }
            .navigationSplitViewStyle(.balanced)
        }
    }

    private var regularSidebar: some View {
        List(selection: sidebarSelection) {
            Section {
                ForEach(RootTab.allCases, id: \.self) { tab in
                    HStack(spacing: 10) {
                        Label(tab.title, systemImage: tab.systemImage)
                        Spacer(minLength: 8)
                        if let badge = sidebarBadge(for: tab), badge > 0 {
                            Text(badge, format: .number)
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(WinnowDesign.accent, in: Capsule())
                        }
                    }
                    .tag(tab)
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Winnow")
        .toolbar {
            WinnowSettingsToolbarItem(action: openSettings)
        }
    }

    private var sidebarSelection: Binding<RootTab?> {
        Binding(
            get: { selectedTab },
            set: { newTab in
                guard let newTab else { return }
                selectedTab = newTab
            }
        )
    }

    private var usesRegularLayout: Bool {
#if targetEnvironment(macCatalyst)
        true
#else
        horizontalSizeClass == .regular
#endif
    }

    private func sidebarBadge(for tab: RootTab) -> Int? {
        switch tab {
        case .inbox: model.inboxBadgeCount
        case .archived: model.unseenArchivedItemCount
        case .ask: nil
        }
    }

    @available(iOS 18.0, *)
    private var modernTabs: some View {
        TabView(selection: tabSelection) {
            Tab("Inbox", systemImage: "tray.full", value: RootTab.inbox) {
                InboxView(
                    mailbox: .inbox,
                    openSettings: openSettings,
                    openStats: openStats
                )
            }
            .badge(model.inboxBadgeCount)

            Tab("Archived", systemImage: "archivebox", value: RootTab.archived) {
                InboxView(
                    mailbox: .archived,
                    openSettings: openSettings,
                    openStats: openStats
                )
            }
            .badge(model.unseenArchivedItemCount)

            Tab("Ask", systemImage: "bubble.left.and.bubble.right.fill", value: RootTab.ask, role: .search) {
                Color.clear
            }
        }
    }

    private var legacyTabs: some View {
        TabView(selection: tabSelection) {
            InboxView(
                mailbox: .inbox,
                openSettings: openSettings,
                openStats: openStats
            )
                .tabItem { Label("Inbox", systemImage: "tray.full") }
                .badge(model.inboxBadgeCount)
                .tag(RootTab.inbox)

            InboxView(
                mailbox: .archived,
                openSettings: openSettings,
                openStats: openStats
            )
                .tabItem { Label("Archived", systemImage: "archivebox") }
                .badge(model.unseenArchivedItemCount)
                .tag(RootTab.archived)

            Color.clear
                .tabItem { Label("Ask", systemImage: "bubble.left.and.bubble.right.fill") }
                .tag(RootTab.ask)
        }
    }

    private var tabSelection: Binding<RootTab> {
        Binding(
            get: { selectedTab },
            set: { newTab in
                if newTab == .ask {
                    presentAsk()
                } else {
                    selectedTab = newTab
                }
            }
        )
    }

    private func openSettings() {
        statsPresented = false
        settingsPresented = true
    }

    private func openStats() {
        settingsPresented = false
        statsPresented = true
    }

    private func presentAsk() {
        settingsPresented = false
        statsPresented = false
        if usesRegularLayout {
            selectedTab = .ask
        } else {
            askPresented = true
        }
    }

    private func mailbox(for tab: RootTab) -> MailboxTab? {
        switch tab {
        case .inbox: .inbox
        case .archived: .archived
        case .ask: nil
        }
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

    private func open(
        emailID: String,
        mailbox: String,
        account: String = "",
        threadID: String = "",
        focusConversation: Bool = false
    ) {
        guard !emailID.isEmpty else { return }
        Task {
            await model.refresh(silent: true)
            let resolvedItem = model.email(id: emailID) ?? model.email(account: account, threadID: threadID)
            let resolvedEmailID = resolvedItem?.id ?? emailID
            let currentMailbox = resolvedItem.map { item in
                item.isArchived ? "archived" : "inbox"
            } ?? (mailbox == "archived" ? "archived" : "inbox")
            selectedTab = currentMailbox == "archived" ? .archived : .inbox
            await Task.yield()
            model.requestNavigation(
                emailID: resolvedEmailID,
                mailboxState: currentMailbox,
                focusConversation: focusConversation
            )
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
                            Text("Spend less time in email. Winnow keeps what matters and handles the rest.")
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

                        Label("The token stays in this device’s Keychain.", systemImage: "lock.fill")
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
