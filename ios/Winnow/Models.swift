import Foundation

struct EmailListResponse: Decodable {
    var items: [EmailItem]
    var nextCursor: String?
}

struct EmailContentEnvelope: Decodable {
    let content: EmailContent
}

struct EmailContent: Decodable, Equatable {
    let emailItemId: String
    let account: String
    let threadId: String
    let focusedMessageId: String?
    let subject: String
    let messages: [FullEmailMessage]
    let truncated: Bool
    let fetchedAt: String

    var messagesForDisplay: [FullEmailMessage] {
        let newestFirst = Array(messages.reversed())
        guard let focusedMessageId, !focusedMessageId.isEmpty,
              let focused = newestFirst.first(where: { $0.id == focusedMessageId })
        else { return newestFirst }
        return [focused] + newestFirst.filter { $0.id != focused.id }
    }
}

struct FullEmailMessage: Decodable, Equatable, Identifiable {
    let id: String
    let from: String
    let to: String
    let cc: String
    let subject: String
    let date: String
    let body: String
}

struct EmailItem: Decodable, Identifiable, Equatable {
    let id: String
    let account: String
    let messageId: String
    let threadId: String
    let fromName: String
    let fromEmail: String
    let from: String
    let subject: String
    let snippet: String
    let summary: String
    let action: String
    let deadline: String
    let impact: String
    let handling: String
    let reason: String
    let confidence: Int?
    let ephemeral: Bool
    let lowConfidenceKept: Bool
    var triageState: String
    var mailboxState: String
    let archive: Bool
    let unsubscribeLink: String
    var unsubscribeState: String
    let createdAt: String
    let processedAt: String
    let updatedAt: String
    var readState: String
    let handlingDecision: EmailHandlingDecision?
    let undoAction: EmailAction?

    var isArchived: Bool {
        switch mailboxState {
        case "archived": true
        case "inbox": false
        default: archive
        }
    }
    var canLoadFullContent: Bool { !threadId.isEmpty || !messageId.isEmpty }
    var canUnsubscribe: Bool {
        !unsubscribeLink.isEmpty && !["succeeded", "attempted"].contains(unsubscribeState)
    }
    var isUnread: Bool { readState == "unread" }
    var meaningfulAction: String? {
        let value = action.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = value.lowercased()
        guard !value.isEmpty else { return nil }
        let noActionPhrases = ["no action", "nothing required", "none required", "not required"]
        return noActionPhrases.contains(where: normalized.contains) ? nil : value
    }

    var displaySubject: String? {
        let value = subject
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        guard !value.isEmpty, value.lowercased() != "(no subject)" else { return nil }
        return value
    }

    var senderDisplayName: String {
        let normalizedName = fromName
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        let hasUsefulName = normalizedName.unicodeScalars.contains {
            CharacterSet.alphanumerics.contains($0)
        }
        if hasUsefulName { return normalizedName }
        if !fromEmail.isEmpty { return fromEmail }
        if !from.isEmpty { return from }
        return "Unknown sender"
    }

    var senderInitials: String {
        let components = senderDisplayName
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .prefix(2)
        let initials = components.compactMap(\.first).map(String.init).joined()
        return initials.isEmpty ? "?" : initials.uppercased()
    }

    var displayDate: Date? { processedAt.winnowDate ?? createdAt.winnowDate }

    private enum CodingKeys: String, CodingKey {
        case id, account, messageId, threadId, fromName, fromEmail, from, subject, snippet
        case summary, action, deadline, impact, handling, reason, confidence, ephemeral
        case lowConfidenceKept, triageState, mailboxState, archive, unsubscribeLink
        case createdAt, processedAt, updatedAt, readState, isRead, unsubscribeState, handlingDecision, undoAction
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        account = try values.decodeIfPresent(String.self, forKey: .account) ?? ""
        messageId = try values.decodeIfPresent(String.self, forKey: .messageId) ?? ""
        threadId = try values.decodeIfPresent(String.self, forKey: .threadId) ?? ""
        fromName = try values.decodeIfPresent(String.self, forKey: .fromName) ?? ""
        fromEmail = try values.decodeIfPresent(String.self, forKey: .fromEmail) ?? ""
        from = try values.decodeIfPresent(String.self, forKey: .from) ?? ""
        subject = try values.decodeIfPresent(String.self, forKey: .subject) ?? ""
        snippet = try values.decodeIfPresent(String.self, forKey: .snippet) ?? ""
        summary = try values.decodeIfPresent(String.self, forKey: .summary) ?? ""
        action = try values.decodeIfPresent(String.self, forKey: .action) ?? ""
        deadline = try values.decodeIfPresent(String.self, forKey: .deadline) ?? ""
        impact = try values.decodeIfPresent(String.self, forKey: .impact) ?? ""
        handling = try values.decodeIfPresent(String.self, forKey: .handling) ?? ""
        reason = try values.decodeIfPresent(String.self, forKey: .reason) ?? ""
        confidence = try values.decodeIfPresent(Int.self, forKey: .confidence)
        ephemeral = try values.decodeIfPresent(Bool.self, forKey: .ephemeral) ?? false
        lowConfidenceKept = try values.decodeIfPresent(Bool.self, forKey: .lowConfidenceKept) ?? false
        triageState = try values.decodeIfPresent(String.self, forKey: .triageState) ?? "kept"
        mailboxState = try values.decodeIfPresent(String.self, forKey: .mailboxState) ?? "unknown"
        archive = try values.decodeIfPresent(Bool.self, forKey: .archive) ?? (mailboxState == "archived")
        unsubscribeLink = try values.decodeIfPresent(String.self, forKey: .unsubscribeLink) ?? ""
        unsubscribeState = try values.decodeIfPresent(String.self, forKey: .unsubscribeState)
            ?? (unsubscribeLink.isEmpty ? "unavailable" : "available")
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        processedAt = try values.decodeIfPresent(String.self, forKey: .processedAt) ?? ""
        updatedAt = try values.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
        // Decision metadata is additive. A future server basis/action must not
        // make the core email unreadable to an older client.
        handlingDecision = (try? values.decodeIfPresent(EmailHandlingDecision.self, forKey: .handlingDecision)) ?? nil
        undoAction = (try? values.decodeIfPresent(EmailAction.self, forKey: .undoAction)) ?? nil

        if let state = try values.decodeIfPresent(String.self, forKey: .readState) {
            readState = state
        } else if let isRead = try values.decodeIfPresent(Bool.self, forKey: .isRead) {
            readState = isRead ? "read" : "unread"
        } else {
            readState = "unknown"
        }
    }
}

enum MailHandlingEffect: String, Decodable, Equatable {
    case archive
    case keep

    var title: String { self == .archive ? "Archived" : "Kept in Inbox" }
    var actionTitle: String { self == .archive ? "Archive" : "Keep in Inbox" }
}

enum MailHandlingBasis: String, Decodable, Equatable {
    case exactRule = "exact_rule"
    case semanticRule = "semantic_rule"
    case baseline
    case serverAutomation = "server_automation"
    case classifier
    case ephemeral
    case manual

    var title: String {
        switch self {
        case .exactRule: "Exact rule"
        case .semanticRule: "Semantic rule"
        case .baseline: "Winnow default"
        case .serverAutomation: "Server automation"
        case .classifier: "Winnow classifier"
        case .ephemeral: "Ephemeral message handling"
        case .manual: "Manual action"
        }
    }
}

struct AppliedRuleReference: Decodable, Equatable {
    let id: String
    let description: String
    let scope: String
    let source: String
    let editable: Bool
    let attribution: String

    var displayTitle: String { description.isEmpty ? "Rule \(id)" : description }

    var attributionDescription: String {
        switch attribution {
        case "deterministic": return "Deterministic rule match"
        case "model_cited": return "Classifier-cited rule"
        default: return "Applied rule"
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, description, scope, source, editable, attribution
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        description = try values.decodeIfPresent(String.self, forKey: .description) ?? ""
        scope = try values.decodeIfPresent(String.self, forKey: .scope) ?? "user"
        source = try values.decodeIfPresent(String.self, forKey: .source) ?? "api"
        editable = try values.decodeIfPresent(Bool.self, forKey: .editable) ?? false
        attribution = try values.decodeIfPresent(String.self, forKey: .attribution) ?? ""
    }
}

struct EmailHandlingDecision: Decodable, Equatable {
    let effect: MailHandlingEffect
    let basis: MailHandlingBasis?
    let explanation: String
    let confidence: Int?
    let handledAt: String?
    let appliedRule: AppliedRuleReference?

    private enum CodingKeys: String, CodingKey {
        case effect, basis, explanation, reason, confidence, handledAt, appliedRule
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        effect = try values.decode(MailHandlingEffect.self, forKey: .effect)
        let rawBasis = try values.decodeIfPresent(String.self, forKey: .basis)
        basis = rawBasis.flatMap(MailHandlingBasis.init(rawValue:))
        explanation = try values.decodeIfPresent(String.self, forKey: .explanation)
            ?? values.decodeIfPresent(String.self, forKey: .reason)
            ?? ""
        confidence = try values.decodeIfPresent(Int.self, forKey: .confidence)
        handledAt = try values.decodeIfPresent(String.self, forKey: .handledAt)
        appliedRule = try values.decodeIfPresent(AppliedRuleReference.self, forKey: .appliedRule)
    }
}

struct DailySummary: Decodable, Equatable {
    let date: String
    let timeZone: String
    let account: String
    let counters: SummaryCounters
    let lists: SummaryLists

    static let empty = DailySummary(
        date: "",
        timeZone: "America/Los_Angeles",
        account: "all",
        counters: .empty,
        lists: .empty
    )
}

struct LifetimeSummary: Decodable, Equatable {
    let scope: String
    let timeZone: String
    let account: String
    let counters: SummaryCounters
    let recentActivity: [SummaryItem]

    static let empty = LifetimeSummary(
        scope: "lifetime",
        timeZone: "America/Los_Angeles",
        account: "all",
        counters: .empty,
        recentActivity: []
    )
}

struct SummaryCounters: Decodable, Equatable {
    let processed: Int
    let kept: Int
    let autoArchived: Int
    let manualArchived: Int
    let restoredToInbox: Int
    let unsubscribedSucceeded: Int
    let unsubscribedFailed: Int
    let unsubscribedAttempted: Int
    let ephemeral: Int
    let lowConfidenceKept: Int

    static let empty = SummaryCounters(
        processed: 0,
        kept: 0,
        autoArchived: 0,
        manualArchived: 0,
        restoredToInbox: 0,
        unsubscribedSucceeded: 0,
        unsubscribedFailed: 0,
        unsubscribedAttempted: 0,
        ephemeral: 0,
        lowConfidenceKept: 0
    )

    var totalArchived: Int { autoArchived + manualArchived }
}

struct SummaryLists: Decodable, Equatable {
    let actedOn: [SummaryItem]
    let archived: [SummaryItem]
    let kept: [SummaryItem]
    let restored: [SummaryItem]
    let unsubscribed: [SummaryItem]

    static let empty = SummaryLists(actedOn: [], archived: [], kept: [], restored: [], unsubscribed: [])
}

struct SummaryItem: Decodable, Equatable, Identifiable {
    let eventId: Int
    let emailItemId: String
    let timestamp: String
    let account: String
    let threadId: String
    let messageId: String
    let from: String
    let subject: String
    let summary: String
    let actionType: String
    let source: String
    let reason: String
    let confidence: Int?

    var id: Int { eventId }
    var displayDate: Date? { timestamp.winnowDate }

    private enum CodingKeys: String, CodingKey {
        case eventId, emailItemId, timestamp, account, threadId, messageId, from
        case subject, summary, actionType, source, reason, confidence
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        eventId = try values.decode(Int.self, forKey: .eventId)
        emailItemId = try values.decodeIfPresent(String.self, forKey: .emailItemId) ?? ""
        timestamp = try values.decodeIfPresent(String.self, forKey: .timestamp) ?? ""
        account = try values.decodeIfPresent(String.self, forKey: .account) ?? ""
        threadId = try values.decodeIfPresent(String.self, forKey: .threadId) ?? ""
        messageId = try values.decodeIfPresent(String.self, forKey: .messageId) ?? ""
        from = try values.decodeIfPresent(String.self, forKey: .from) ?? ""
        subject = try values.decodeIfPresent(String.self, forKey: .subject) ?? ""
        summary = try values.decodeIfPresent(String.self, forKey: .summary) ?? ""
        actionType = try values.decodeIfPresent(String.self, forKey: .actionType) ?? ""
        source = try values.decodeIfPresent(String.self, forKey: .source) ?? ""
        reason = try values.decodeIfPresent(String.self, forKey: .reason) ?? ""
        confidence = try values.decodeIfPresent(Int.self, forKey: .confidence)
    }

    func resolvedEmailID(in emails: [EmailItem]) -> String? {
        if !emailItemId.isEmpty, emails.contains(where: { $0.id == emailItemId }) {
            return emailItemId
        }
        if !messageId.isEmpty,
           let match = emails.first(where: { $0.account == account && $0.messageId == messageId }) {
            return match.id
        }
        if !threadId.isEmpty,
           let match = emails.first(where: { $0.account == account && $0.threadId == threadId }) {
            return match.id
        }
        return nil
    }
}

struct RuntimeStatus: Decodable, Equatable {
    let ok: Bool
    let timestamp: String
    let process: RuntimeProcess
    let scans: RuntimeScans
    let accounts: [AccountStatus]
}

struct RuntimeProcess: Decodable, Equatable {
    let pid: Int
    let uptimeSeconds: Int
    let node: String
}

struct RuntimeScans: Decodable, Equatable {
    let lastScanTime: String?
    let lastScanByAccount: [String: String]
}

struct AccountListResponse: Decodable {
    let accounts: [AccountStatus]
}

struct AccountStatus: Decodable, Equatable, Identifiable {
    let email: String
    let avatarUrl: String?
    let gmailAppAccountId: Int?
    let scan: AccountScan
    let latestEvent: LatestEvent?

    var id: String { email }
    var avatarURL: URL? { avatarUrl.flatMap(URL.init(string:)) }
}

struct AccountScan: Decodable, Equatable {
    let lastScanAt: String?
    let lastScanFound: Int?
    let lastScanProcessed: Int?
}

struct LatestEvent: Decodable, Equatable {
    let id: Int
    let eventType: String
    let timestamp: String
    let subject: String
}

struct ActionResponse: Decodable {
    let ok: Bool
    let action: String?
    let item: EmailItem?
    let outcome: String?
    let requiresManualAction: Bool?
}

struct PushDeviceResponse: Decodable {
    let device: PushDevice
}

struct PushDevice: Decodable, Equatable {
    let id: String
    let platform: String
    let installationId: String
    let environment: String
    let bundleId: String
    let appVersion: String
    let enabled: Bool
}

struct PushDeviceDeleteResponse: Decodable {
    let ok: Bool
}

enum EmailAction: String, CaseIterable, Codable {
    case archive = "archive"
    case moveToInbox = "move-to-inbox"
    case markRead = "mark-read"
    case markUnread = "mark-unread"
    case unsubscribe = "unsubscribe"

    var label: String {
        switch self {
        case .archive: "Archive"
        case .moveToInbox: "Move to Inbox"
        case .markRead: "Mark Read"
        case .markUnread: "Mark Unread"
        case .unsubscribe: "Unsubscribe"
        }
    }

    var systemImage: String {
        switch self {
        case .archive: "archivebox"
        case .moveToInbox: "tray.and.arrow.down"
        case .markRead: "envelope.open"
        case .markUnread: "envelope.badge"
        case .unsubscribe: "person.crop.circle.badge.minus"
        }
    }

    var supportsOptimisticUpdate: Bool {
        switch self {
        case .archive, .moveToInbox, .markRead, .markUnread: true
        case .unsubscribe: false
        }
    }
}

struct UndoHandlingResponse: Decodable {
    let ok: Bool
    let action: String
    let item: EmailItem?

    private enum CodingKeys: String, CodingKey { case ok, action, item }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        ok = try values.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        action = try values.decodeIfPresent(String.self, forKey: .action) ?? "undo-handling"
        item = try values.decodeIfPresent(EmailItem.self, forKey: .item)
    }
}

extension EmailItem {
    mutating func applyOptimistic(_ action: EmailAction) {
        switch action {
        case .archive:
            mailboxState = "archived"
            triageState = "manual_archived"
        case .moveToInbox:
            mailboxState = "inbox"
            triageState = "restored"
        case .markRead:
            readState = "read"
        case .markUnread:
            readState = "unread"
        case .unsubscribe:
            break
        }
    }
}

extension String {
    fileprivate var winnowDate: Date? {
        if let date = Self.preciseISO8601.date(from: self) { return date }
        return Self.basicISO8601.date(from: self)
    }

    private static let preciseISO8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let basicISO8601 = ISO8601DateFormatter()
}
