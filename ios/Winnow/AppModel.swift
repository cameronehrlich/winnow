import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var configuration: ServerConfiguration
    @Published private(set) var emails: [EmailItem] = []
    @Published private(set) var summary: DailySummary = .empty
    @Published private(set) var lifetimeSummary: LifetimeSummary = .empty
    @Published private(set) var status: RuntimeStatus?
    @Published private(set) var accounts: [AccountStatus] = []
    @Published private(set) var mailRules: [MailRule] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isRefreshing = false
    @Published private(set) var isLoadingMailRules = false
    @Published private(set) var performingEmailIDs: Set<String> = []
    @Published private(set) var performingRuleIDs: Set<String> = []
    @Published private(set) var lastRefresh: Date?
    @Published var presentedError: PresentedError?
    @Published var toast: ToastMessage?
    @Published var navigationRequest: EmailNavigationRequest?
    @Published var askNavigationRequest: UUID?

    private var hasLoaded = false
    private var autoRefreshTask: Task<Void, Never>?
    private var refreshInFlight = false
    private var refreshGeneration = 0
    private var pendingOptimisticActions: [String: EmailAction] = [:]
    private var archivedIsVisible = false
    private let archivedViewedKey = "winnow.archived-last-viewed"

    init(configuration: ServerConfiguration = ConfigurationStore.load()) {
        self.configuration = configuration
        if UserDefaults.standard.object(forKey: archivedViewedKey) == nil {
            UserDefaults.standard.set(Date(), forKey: archivedViewedKey)
        }
    }

    var isConfigured: Bool { configuration.isComplete }
    var isOnline: Bool { status?.ok == true }
    var inboxBadgeCount: Int { emails.lazy.filter { !$0.isArchived && $0.isUnread }.count }
    var archivedBadgeCount: Int {
        guard let viewedAt = UserDefaults.standard.object(forKey: archivedViewedKey) as? Date else { return 0 }
        return emails.lazy.filter { item in
            item.isArchived && (item.displayDate ?? .distantPast) > viewedAt
        }.count
    }

    func initialLoad() async {
        guard isConfigured, !hasLoaded else { return }
        hasLoaded = true
        await refresh()
        await activatePushNotifications()
    }

    func refresh(silent: Bool = false) async {
        guard isConfigured else { return }
        guard !refreshInFlight else { return }
        refreshInFlight = true
        let generation = refreshGeneration

        if !hasLoaded || emails.isEmpty {
            isLoading = !silent
        } else {
            isRefreshing = !silent
        }
        defer {
            refreshInFlight = false
            isLoading = false
            isRefreshing = false
        }

        let client = APIClient(configuration: configuration)
        do {
            async let fetchedInbox = client.emails(state: "inbox", limit: 200)
            async let fetchedArchived = client.emails(state: "archived", limit: 200)
            async let fetchedSummary = client.dailySummary()
            async let fetchedLifetimeSummary = client.lifetimeSummary()
            async let fetchedStatus = client.status()
            async let fetchedAccounts = client.accounts()

            let (inboxPage, archivedPage, dailySummary, lifetime, runtimeStatus, accountList) = try await (
                fetchedInbox,
                fetchedArchived,
                fetchedSummary,
                fetchedLifetimeSummary,
                fetchedStatus,
                fetchedAccounts
            )
            guard generation == refreshGeneration else { return }
            var refreshedEmails = inboxPage.items + archivedPage.items
            for (emailID, action) in pendingOptimisticActions {
                guard let index = refreshedEmails.firstIndex(where: { $0.id == emailID }) else { continue }
                refreshedEmails[index].applyOptimistic(action)
            }
            emails = refreshedEmails
            summary = dailySummary
            lifetimeSummary = lifetime
            status = runtimeStatus
            accounts = accountList
            lastRefresh = Date()
            WidgetSnapshotStore.save(emails: emails)
            PushNotificationManager.shared.setAppIconBadge(inboxBadgeCount)
            if archivedIsVisible { markArchivedViewed() }
        } catch {
            guard generation == refreshGeneration else { return }
            if !silent || emails.isEmpty {
                presentedError = PresentedError(title: "Couldn’t refresh", message: error.localizedDescription)
            }
            status = nil
        }
    }

    func saveAndConnect(serverURL: String, token: String) async -> Bool {
        let candidate = ServerConfiguration(serverURL: serverURL, token: token)
        guard candidate.isComplete else {
            presentedError = PresentedError(
                title: "Check your setup",
                message: APIClientError.invalidServerURL.localizedDescription
            )
            return false
        }

        isLoading = true
        do {
            let verifiedStatus = try await APIClient(configuration: candidate).status()
            try ConfigurationStore.save(candidate)
            refreshGeneration &+= 1
            configuration = candidate
            status = verifiedStatus
            hasLoaded = true
            isLoading = false
            await waitForRefreshToFinish()
            await refresh()
            await activatePushNotifications()
            toast = ToastMessage(text: "Connected to Winnow", symbol: "checkmark.circle.fill")
            return true
        } catch {
            isLoading = false
            presentedError = PresentedError(title: "Couldn’t connect", message: error.localizedDescription)
            return false
        }
    }

    func testConnection(serverURL: String, token: String) async -> Bool {
        let candidate = ServerConfiguration(serverURL: serverURL, token: token)
        guard candidate.isComplete else {
            presentedError = PresentedError(title: "Check your setup", message: APIClientError.invalidServerURL.localizedDescription)
            return false
        }
        do {
            _ = try await APIClient(configuration: candidate).status()
            toast = ToastMessage(text: "Connection looks good", symbol: "bolt.fill")
            return true
        } catch {
            presentedError = PresentedError(title: "Connection failed", message: error.localizedDescription)
            return false
        }
    }

    func disconnect() {
        let previousConfiguration = configuration
        Task { await PushNotificationManager.shared.deactivate(configuration: previousConfiguration) }
        do {
            try ConfigurationStore.clear()
            refreshGeneration &+= 1
            configuration = ServerConfiguration(serverURL: "", token: "")
            emails = []
            summary = .empty
            lifetimeSummary = .empty
            status = nil
            accounts = []
            mailRules = []
            hasLoaded = false
            stopAutoRefresh()
            WidgetSnapshotStore.clear()
            PushNotificationManager.shared.setAppIconBadge(0)
        } catch {
            presentedError = PresentedError(title: "Couldn’t clear setup", message: error.localizedDescription)
        }
    }

    func perform(_ action: EmailAction, on item: EmailItem, showsConfirmation: Bool = true) async -> Bool {
        guard !performingEmailIDs.contains(item.id) else { return false }
        let originalItem = email(id: item.id) ?? item
        let appliesOptimistically = action.supportsOptimisticUpdate

        performingEmailIDs.insert(item.id)
        defer { performingEmailIDs.remove(item.id) }

        if appliesOptimistically {
            refreshGeneration &+= 1
            pendingOptimisticActions[item.id] = action
            applyOptimistic(action, to: item.id)
            publishEmailState()
            if showsConfirmation {
                toast = ToastMessage(text: successMessage(for: action), symbol: action.systemImage)
            }
        }

        do {
            let response = try await APIClient(configuration: configuration).perform(action, emailID: item.id)
            pendingOptimisticActions.removeValue(forKey: item.id)
            refreshGeneration &+= 1
            if let updated = response.item {
                replace(updated)
            } else if !appliesOptimistically {
                applyOptimistic(action, to: item.id)
            }
            publishEmailState()

            let requiresManualUnsubscribe = action == .unsubscribe &&
                (response.requiresManualAction == true || response.outcome == "attempted")

            await waitForRefreshToFinish()
            await refresh(silent: true)

            if requiresManualUnsubscribe {
                presentedError = PresentedError(
                    title: "Manual unsubscribe required",
                    message: "This sender uses an email-based unsubscribe flow. Open the message in Gmail to finish it."
                )
                return true
            }
            if showsConfirmation && !appliesOptimistically {
                toast = ToastMessage(text: successMessage(for: action), symbol: action.systemImage)
            }
            return true
        } catch {
            if appliesOptimistically {
                pendingOptimisticActions.removeValue(forKey: item.id)
                refreshGeneration &+= 1
                replace(originalItem)
                publishEmailState()
                toast = nil
            }
            presentedError = PresentedError(title: "Action failed", message: error.localizedDescription)
            return false
        }
    }

    func markReadWhenOpened(_ item: EmailItem) async {
        guard item.isUnread else { return }
        _ = await perform(.markRead, on: item, showsConfirmation: false)
    }

    func startAutoRefresh() {
        guard autoRefreshTask == nil, isConfigured else { return }
        autoRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(30))
                } catch {
                    return
                }
                guard !Task.isCancelled else { return }
                await self?.refresh(silent: true)
            }
        }
    }

    func stopAutoRefresh() {
        autoRefreshTask?.cancel()
        autoRefreshTask = nil
    }

    func email(id: String) -> EmailItem? {
        emails.first(where: { $0.id == id })
    }

    func account(email: String) -> AccountStatus? {
        accounts.first(where: { $0.email.caseInsensitiveCompare(email) == .orderedSame })
    }

    func loadMailRules(showsError: Bool = true) async {
        guard isConfigured, !isLoadingMailRules else { return }
        isLoadingMailRules = true
        defer { isLoadingMailRules = false }
        do {
            mailRules = try await APIClient(configuration: configuration).mailRules()
        } catch {
            if showsError {
                presentedError = PresentedError(title: "Couldn’t load rules", message: error.localizedDescription)
            }
        }
    }

    func previewMailRule(_ draft: MailRuleDraft) async throws -> MailRulePreviewResponse {
        try await APIClient(configuration: configuration).previewMailRule(draft)
    }

    func saveMailRule(_ draft: MailRuleDraft, replacing rule: MailRule) async -> Bool {
        guard !performingRuleIDs.contains(rule.id) else { return false }
        performingRuleIDs.insert(rule.id)
        defer { performingRuleIDs.remove(rule.id) }
        do {
            let client = APIClient(configuration: configuration)
            if rule.belongsWithDefaults {
                _ = try await client.customizeBaselineRule(draft)
            } else {
                _ = try await client.updateMailRule(id: rule.id, candidate: draft)
            }
            await loadMailRules(showsError: false)
            toast = ToastMessage(text: rule.belongsWithDefaults ? "Default customized" : "Rule updated", symbol: "checkmark.circle.fill")
            return true
        } catch {
            presentedError = PresentedError(title: "Couldn’t save rule", message: error.localizedDescription)
            return false
        }
    }

    func setMailRuleEnabled(_ rule: MailRule, enabled: Bool) async -> Bool {
        guard rule.canToggle, !performingRuleIDs.contains(rule.id) else { return false }
        performingRuleIDs.insert(rule.id)
        defer { performingRuleIDs.remove(rule.id) }
        do {
            let client = APIClient(configuration: configuration)
            if enabled {
                var draft = MailRuleDraft(rule: rule)
                draft.enabled = true
                _ = try await client.updateMailRule(id: rule.id, candidate: draft)
            } else {
                _ = try await client.disableMailRule(id: rule.id)
            }
            await loadMailRules(showsError: false)
            toast = ToastMessage(text: enabled ? "Rule enabled" : "Rule disabled", symbol: enabled ? "checkmark.circle" : "pause.circle")
            return true
        } catch {
            presentedError = PresentedError(title: "Couldn’t update rule", message: error.localizedDescription)
            return false
        }
    }

    func resetMailRule(_ rule: MailRule) async -> Bool {
        guard rule.canReset, !performingRuleIDs.contains(rule.id) else { return false }
        performingRuleIDs.insert(rule.id)
        defer { performingRuleIDs.remove(rule.id) }
        do {
            _ = try await APIClient(configuration: configuration).resetMailRule(id: rule.id)
            await loadMailRules(showsError: false)
            toast = ToastMessage(text: "Default restored", symbol: "arrow.counterclockwise.circle")
            return true
        } catch {
            presentedError = PresentedError(title: "Couldn’t reset default", message: error.localizedDescription)
            return false
        }
    }

    func requestAskWinnow() {
        askNavigationRequest = UUID()
    }

    func consumeAskNavigation(_ request: UUID) {
        if askNavigationRequest == request { askNavigationRequest = nil }
    }

    func setArchivedVisible(_ visible: Bool) {
        archivedIsVisible = visible
        if visible { markArchivedViewed() }
    }

    func requestNavigation(emailID: String, mailboxState: String = "inbox") {
        navigationRequest = EmailNavigationRequest(emailID: emailID, mailboxState: mailboxState)
    }

    func consumeNavigation(_ request: EmailNavigationRequest) {
        if navigationRequest == request { navigationRequest = nil }
    }

    @discardableResult
    func refreshFromPush() async -> Bool {
        let previous = emails
        await refresh(silent: true)
        return emails != previous
    }

    private func activatePushNotifications() async {
        await PushNotificationManager.shared.activate(configuration: configuration) { [weak self] in
            guard let self else { return false }
            return await self.refreshFromPush()
        }
    }

    private func markArchivedViewed() {
        UserDefaults.standard.set(Date(), forKey: archivedViewedKey)
        objectWillChange.send()
    }

    private func replace(_ item: EmailItem) {
        guard let index = emails.firstIndex(where: { $0.id == item.id }) else {
            emails.insert(item, at: 0)
            return
        }
        emails[index] = item
    }

    private func applyOptimistic(_ action: EmailAction, to id: String) {
        guard let index = emails.firstIndex(where: { $0.id == id }) else { return }
        emails[index].applyOptimistic(action)
    }

    private func publishEmailState() {
        WidgetSnapshotStore.save(emails: emails)
        PushNotificationManager.shared.setAppIconBadge(inboxBadgeCount)
    }

    private func waitForRefreshToFinish() async {
        while refreshInFlight {
            do {
                try await Task.sleep(for: .milliseconds(40))
            } catch {
                return
            }
        }
    }

    private func successMessage(for action: EmailAction) -> String {
        switch action {
        case .archive: "Archived"
        case .moveToInbox: "Moved to inbox"
        case .markRead: "Marked read"
        case .markUnread: "Marked unread"
        case .unsubscribe: "Unsubscribed"
        }
    }
}

struct EmailNavigationRequest: Equatable {
    let emailID: String
    let mailboxState: String
}

struct PresentedError: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}

struct ToastMessage: Identifiable, Equatable {
    let id = UUID()
    let text: String
    let symbol: String

    static func == (lhs: ToastMessage, rhs: ToastMessage) -> Bool {
        lhs.id == rhs.id
    }
}
