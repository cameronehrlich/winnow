import Foundation
import SwiftUI

struct EmailDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    let emailID: String
    @State private var confirmUnsubscribe = false
    @State private var confirmUndoHandling = false
    @State private var assistantComposerRequest: AssistantComposerRequest?
    @State private var editingRule: MailRule?
    @State private var showingCreateRule = false
    @State private var showingFullEmail = false

    private var item: EmailItem? { model.email(id: emailID) }

    private var normalizedEmptyValues: Set<String> {
        ["", "n/a", "none", "none found", "not found", "unknown"]
    }

    var body: some View {
        ZStack {
            AppBackdrop()
            if let item {
                EmailAssistantThreadView(
                    configuration: model.configuration,
                    account: item.account,
                    emailItemID: item.id,
                    contextTitle: item.displaySubject ?? "No subject",
                    composerRequest: $assistantComposerRequest,
                    onMailboxChanged: { await model.refresh(silent: true) }
                ) {
                    VStack(spacing: 16) {
                        senderHeader(item)

                        actionsCard(item)

                        if !item.summary.isEmpty {
                            InsightBlock(
                                title: "Summary",
                                symbol: "text.alignleft",
                                text: item.summary,
                                color: WinnowDesign.accent,
                                actionTitle: item.canLoadFullContent ? "View Full Email" : nil,
                                actionSymbol: "doc.text.magnifyingglass",
                                action: item.canLoadFullContent ? { showingFullEmail = true } : nil
                            )
                        }

                        if item.isConversation {
                            ConversationPreviewSection(
                                configuration: model.configuration,
                                emailID: item.id,
                                focusedMessageID: item.messageId,
                                fallbackSubject: item.displaySubject ?? "No subject",
                                account: item.account,
                                viewFullConversation: { showingFullEmail = true }
                            )
                        }

                        if let decision = item.handlingDecision {
                            HandlingDecisionCard(
                                decision: decision,
                                isBusy: model.performingEmailIDs.contains(item.id),
                                canUndo: item.undoAction != nil,
                                undo: { confirmUndoHandling = true },
                                adjust: { adjustFutureHandling(item, decision: decision) },
                                createRule: { showingCreateRule = true }
                            )
                        }

                        if hasDetails(item) {
                            detailsCard(item)
                        }

                        if !item.snippet.isEmpty, item.snippet != item.summary {
                            InsightBlock(
                                title: "Message preview",
                                symbol: "quote.opening",
                                text: item.snippet,
                                color: .secondary,
                                detectLinks: true
                            )
                        }

                        if item.unsubscribeState == "succeeded" {
                            InsightBlock(title: "Unsubscribed", symbol: "checkmark.circle.fill", text: "Winnow completed the unsubscribe request.", color: WinnowDesign.mint)
                        } else if item.unsubscribeState == "attempted" {
                            InsightBlock(title: "Manual step needed", symbol: "envelope.badge", text: "This sender requires an email-based unsubscribe that Winnow can’t complete automatically.", color: WinnowDesign.amber)
                        }
                    }
                }
                .confirmationDialog(
                    "Unsubscribe from this sender?",
                    isPresented: $confirmUnsubscribe,
                    titleVisibility: .visible
                ) {
                    Button("Unsubscribe", role: .destructive) {
                        Task { _ = await model.perform(.unsubscribe, on: item) }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Winnow will follow the sender’s unsubscribe link.")
                }
                .confirmationDialog(
                    undoConfirmationTitle(for: item),
                    isPresented: $confirmUndoHandling,
                    titleVisibility: .visible
                ) {
                    Button(undoConfirmationButton(for: item)) {
                        Task { _ = await model.undoHandling(on: item) }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text(undoConfirmationMessage(for: item))
                }
                .sheet(item: $editingRule) { rule in
                    MailRuleEditorView(rule: rule)
                        .environmentObject(model)
                }
                .sheet(isPresented: $showingCreateRule) {
                    CreateRuleFromEmailView(item: item)
                        .environmentObject(model)
                }
                .sheet(isPresented: $showingFullEmail) {
                    FullEmailView(
                        configuration: model.configuration,
                        emailID: item.id,
                        fallbackSubject: item.displaySubject ?? "No subject",
                        account: item.account
                    )
                }
            } else {
                ContentUnavailableView("Email unavailable", systemImage: "envelope.badge")
            }
        }
        .navigationTitle("Email")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: emailID) {
            guard let item = model.email(id: emailID) else { return }
            await model.markReadWhenOpened(item)
            if item.handlingDecision?.appliedRule != nil {
                await model.loadMailRules(showsError: false)
            }
        }
    }

    private func undoConfirmationTitle(for item: EmailItem) -> String {
        switch item.undoAction {
        case .moveToInbox: "Move this email to Inbox?"
        case .archive: "Archive this email?"
        default: "Undo Winnow’s handling for this email?"
        }
    }

    private func undoConfirmationButton(for item: EmailItem) -> String {
        switch item.undoAction {
        case .moveToInbox: "Move to Inbox"
        case .archive: "Archive and Mark Read"
        default: "Undo for This Email"
        }
    }

    private func undoConfirmationMessage(for item: EmailItem) -> String {
        let action = switch item.undoAction {
        case .moveToInbox: "This moves only this email to Inbox. It remains read."
        case .archive: "This archives only this email and marks it read."
        default: "This changes only this email."
        }
        return "\(action) Any rule for future messages remains unchanged."
    }

    private func senderHeader(_ item: EmailItem) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 13) {
                ZStack(alignment: .bottomTrailing) {
                    SenderAvatar(initials: item.senderInitials, seed: item.fromEmail.isEmpty ? item.senderDisplayName : item.fromEmail, size: 52)
                    AccountAvatarBadge(account: model.account(email: item.account), size: 20)
                        .offset(x: 4, y: 4)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.senderDisplayName).font(.headline)
                    if !item.fromEmail.isEmpty { Text(item.fromEmail).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                CapsuleLabel(item.isArchived ? "Archived" : "Inbox", symbol: item.isArchived ? "archivebox" : "tray", color: item.isArchived ? WinnowDesign.amber : WinnowDesign.mint)
            }
            if let subject = item.displaySubject {
                Text(subject)
                    .font(.title2.bold())
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                AccountAvatarBadge(account: model.account(email: item.account), size: 18)
                Text(item.account)
                Spacer()
                if let date = item.displayDate { Text(date.formatted(date: .abbreviated, time: .shortened)) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .winnowCard()
    }

    @ViewBuilder
    private func detailsCard(_ item: EmailItem) -> some View {
        let rows = detailRows(item)
        VStack(spacing: 0) {
            ForEach(rows.indices, id: \.self) { index in
                if index > 0 { DetailDivider() }
                let row = rows[index]
                DetailRow(
                    label: row.label,
                    value: row.value,
                    symbol: row.symbol,
                    color: row.color,
                    trailingValue: row.trailingValue,
                    trailingAccessibilityLabel: row.trailingAccessibilityLabel
                )
            }
        }
        .winnowCard(padding: 4)
    }

    private func actionsCard(_ item: EmailItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ACTIONS")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)

            AdaptiveActionPair {
                Button {
                    performPrimaryMailboxAction(on: item)
                } label: {
                    DetailActionLabel(
                        title: item.isArchived ? "Move to Inbox" : "Archive",
                        symbol: item.isArchived ? "tray.and.arrow.down" : "archivebox"
                    )
                }
                .buttonStyle(.borderedProminent)
                .tint(WinnowDesign.accent)
            } trailing: {
                Button {
                    Task { _ = await model.perform(item.isUnread ? .markRead : .markUnread, on: item) }
                } label: {
                    DetailActionLabel(
                        title: item.isUnread ? "Mark Read" : "Mark Unread",
                        symbol: item.isUnread ? "envelope.open" : "envelope.badge"
                    )
                }
                .buttonStyle(.bordered)
                .tint(WinnowDesign.accent)
            }

            if item.canUnsubscribe {
                unsubscribeButton
            }

            if item.canLoadFullContent, item.summary.isEmpty {
                Button { showingFullEmail = true } label: {
                    DetailActionLabel(title: "View Full Email", symbol: "doc.text.magnifyingglass")
                }
                .buttonStyle(.bordered)
                .tint(WinnowDesign.accent)
                .accessibilityHint("Loads the complete message securely from Gmail.")
            }

            if item.handlingDecision == nil {
                Button {
                    showingCreateRule = true
                } label: {
                    DetailActionLabel(title: "Create Rule from This Email", symbol: "checklist")
                }
                .buttonStyle(.bordered)
                .tint(WinnowDesign.accent)
            }
        }
        .font(.subheadline.weight(.semibold))
        .winnowCard(padding: 14)
        .disabled(model.performingEmailIDs.contains(item.id))
    }

    private func performPrimaryMailboxAction(on item: EmailItem) {
        let action: EmailAction = item.isArchived ? .moveToInbox : .archive
        if action == .archive {
            dismiss()
        }
        Task { _ = await model.perform(action, on: item) }
    }

    private var unsubscribeButton: some View {
        Button(role: .destructive) { confirmUnsubscribe = true } label: {
            DetailActionLabel(title: "Unsubscribe", symbol: "person.crop.circle.badge.minus")
        }
        .buttonStyle(.bordered)
        .tint(WinnowDesign.rose)
    }

    private func adjustFutureHandling(_ item: EmailItem, decision: EmailHandlingDecision) {
        Task {
            if model.mailRules.isEmpty { await model.loadMailRules(showsError: false) }
            if let reference = decision.appliedRule,
               let rule = model.mailRule(referencing: reference, account: item.account),
               rule.editable || rule.belongsWithDefaults {
                editingRule = rule
                return
            }
            assistantComposerRequest = AssistantComposerRequest(
                text: "Adjust how future messages like this email are handled. Propose the smallest safe rule change, test it against representative mail, and ask before saving."
            )
        }
    }

    private func hasDetails(_ item: EmailItem) -> Bool {
        !detailRows(item).isEmpty
    }

    private func detailRows(_ item: EmailItem) -> [DetailValue] {
        var rows: [DetailValue] = []
        if let action = item.meaningfulAction {
            rows.append(DetailValue(
                label: "Next step",
                value: action,
                symbol: "arrow.turn.down.right",
                color: WinnowDesign.brightIndigo
            ))
        }
        if let deadline = meaningfulDeadline(item.deadline) {
            rows.append(DetailValue(label: "Deadline", value: deadline, symbol: "clock", color: WinnowDesign.amber))
        }
        if let impact = meaningfulImpact(item.impact) {
            rows.append(DetailValue(label: "Impact", value: impact, symbol: "bolt", color: WinnowDesign.rose))
        }
        if item.handlingDecision == nil, let handling = meaningfulValue(item.handling) {
            rows.append(DetailValue(
                label: "Handling",
                value: humanizedHandling(handling),
                symbol: "hand.raised",
                color: WinnowDesign.mint,
                trailingValue: item.confidence.map { "\($0)%" },
                trailingAccessibilityLabel: item.confidence.map { "\($0) percent confidence" }
            ))
        }
        return rows
    }

    private func meaningfulDeadline(_ value: String) -> String? {
        meaningfulValue(value, additionallyIgnoring: ["no deadline", "no deadline found"])
    }

    private func meaningfulImpact(_ value: String) -> String? {
        meaningfulValue(value, additionallyIgnoring: ["no impact", "no impact found"])
    }

    private func meaningfulValue(_ value: String, additionallyIgnoring ignored: Set<String> = []) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.lowercased()
        guard !normalizedEmptyValues.union(ignored).contains(normalized) else { return nil }
        return trimmed
    }

    private func humanizedHandling(_ value: String) -> String {
        switch value.lowercased() {
        case "archive": "Archive"
        case "keep": "Keep in Inbox"
        case "reply": "Reply"
        case "task": "Follow up as a task"
        case "calendar": "Add to calendar"
        case "read later": "Read later"
        default:
            value
                .replacingOccurrences(of: "_", with: " ")
                .replacingOccurrences(of: "-", with: " ")
                .capitalized
        }
    }
}

private struct HandlingDecisionCard: View {
    let decision: EmailHandlingDecision
    let isBusy: Bool
    let canUndo: Bool
    let undo: () -> Void
    let adjust: () -> Void
    let createRule: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                Label(
                    headline,
                    systemImage: decision.effect == .archive ? "archivebox.fill" : "tray.fill"
                )
                    .font(.headline)
                    .foregroundStyle(decision.effect == .archive ? WinnowDesign.accent : WinnowDesign.mint)
                Spacer()
                if let confidence = decision.confidence {
                    CapsuleLabel("\(confidence)%", color: WinnowDesign.accent)
                }
            }

            if !decision.explanation.isEmpty {
                Text(decision.explanation)
                    .font(.subheadline)
            }

            if let rule = decision.appliedRule {
                VStack(alignment: .leading, spacing: 3) {
                    Text("RULE BASIS")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                    Text(rule.displayTitle)
                        .font(.caption.weight(.semibold))
                    Text(rule.attributionDescription)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if let basis = decision.basis {
                Text(basis.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if canUndo {
                AdaptiveActionPair {
                    Button(action: undo) {
                        DetailActionLabel(title: "Undo This Email", symbol: "arrow.uturn.backward")
                    }
                    .buttonStyle(.bordered)
                    .tint(WinnowDesign.accent)
                } trailing: {
                    Button(action: adjust) {
                        DetailActionLabel(title: "Adjust Future", symbol: "slider.horizontal.3")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(WinnowDesign.accent)
                }
            } else {
                Button(action: adjust) {
                    Label("Adjust Future Handling", systemImage: "slider.horizontal.3")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(WinnowDesign.accent)
            }

            Button(action: createRule) {
                Label("Create a New Rule from This Email", systemImage: "plus.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(WinnowDesign.accent)
        }
        .winnowCard(padding: 14)
        .disabled(isBusy)
    }

    private var headline: String {
        switch (decision.effect, canUndo) {
        case (.archive, true): "Winnow archived this"
        case (.keep, true): "Winnow kept this in the inbox"
        case (.archive, false): "Winnow originally archived this"
        case (.keep, false): "Winnow originally kept this in the inbox"
        }
    }
}

private enum EmailRuleSeedKind: String, CaseIterable, Identifiable {
    case sender
    case domain
    case similar

    var id: String { rawValue }
    var title: String {
        switch self {
        case .sender: "Same Sender"
        case .domain: "Same Domain"
        case .similar: "Similar Messages"
        }
    }
}

private struct CreateRuleFromEmailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let item: EmailItem

    @State private var kind: EmailRuleSeedKind
    @State private var effect: String
    @State private var semanticMatch: String
    @State private var description: String
    @State private var preview: MailRulePreviewResponse?
    @State private var isPreviewing = false
    @State private var isSaving = false
    @State private var showingReview = false
    @State private var localError: String?

    init(item: EmailItem) {
        self.item = item
        let initialKind: EmailRuleSeedKind = item.fromEmail.isEmpty ? .similar : .sender
        let initialEffect = item.isArchived ? "archive" : "keep"
        _kind = State(initialValue: initialKind)
        _effect = State(initialValue: initialEffect)
        _semanticMatch = State(initialValue: Self.semanticSeed(from: item.summary))
        _description = State(initialValue: Self.defaultDescription(kind: initialKind, item: item))
    }

    private var sender: String? {
        let value = item.fromEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return value.isEmpty ? nil : value
    }

    private var domain: String? {
        guard let sender, let value = sender.split(separator: "@").last, value.contains(".") else { return nil }
        return String(value)
    }

    private var availableKinds: [EmailRuleSeedKind] {
        EmailRuleSeedKind.allCases.filter { kind in
            switch kind {
            case .sender: sender != nil
            case .domain: domain != nil
            case .similar: true
            }
        }
    }

    private var draft: MailRuleDraft {
        switch kind {
        case .sender:
            MailRuleDraft(
                account: item.account, type: "exact", effect: effect,
                matcherKind: "sender", matcherValue: sender,
                description: description, sourceEmailItemId: item.id
            )
        case .domain:
            MailRuleDraft(
                account: item.account, type: "exact", effect: effect,
                matcherKind: "domain", matcherValue: domain,
                description: description, sourceEmailItemId: item.id
            )
        case .similar:
            MailRuleDraft(
                account: item.account, type: "semantic", effect: effect,
                match: semanticMatch, description: description,
                sourceEmailItemId: item.id
            )
        }
    }

    private var canTest: Bool {
        !item.account.isEmpty
            && !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (kind != .similar || !semanticMatch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            && (kind != .sender || sender != nil)
            && (kind != .domain || domain != nil)
            && !isPreviewing && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Match") {
                    Picker("Future messages from", selection: $kind) {
                        ForEach(availableKinds) { option in
                            Text(option.title).tag(option)
                        }
                    }

                    switch kind {
                    case .sender:
                        LabeledContent("Sender", value: sender ?? "Unavailable")
                    case .domain:
                        LabeledContent("Domain", value: domain ?? "Unavailable")
                    case .similar:
                        TextField("Describe similar messages", text: $semanticMatch, axis: .vertical)
                            .lineLimit(3...7)
                        Text("Start from Winnow’s stored summary, then narrow the wording to the behavior you actually want.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Behavior") {
                    Picker("Action", selection: $effect) {
                        Text("Archive").tag("archive")
                        Text("Keep in Inbox").tag("keep")
                    }
                    .pickerStyle(.segmented)
                    LabeledContent("Account", value: item.account)
                }

                Section("Label") {
                    TextField("Rule description", text: $description, axis: .vertical)
                }

                Section {
                    Button(action: testRule) {
                        HStack {
                            Label("Test & Review Rule", systemImage: "checklist")
                            Spacer()
                            if isPreviewing { ProgressView() }
                        }
                    }
                    .disabled(!canTest)
                } footer: {
                    Text("Winnow tests representative recent messages. Nothing is created until you review and confirm.")
                }
            }
            .navigationTitle("Create Rule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .onChange(of: kind) { _, newKind in
                preview = nil
                description = Self.defaultDescription(kind: newKind, item: item)
            }
            .onChange(of: effect) { _, _ in preview = nil }
            .onChange(of: semanticMatch) { _, _ in preview = nil }
            .onChange(of: description) { _, _ in preview = nil }
            .sheet(isPresented: $showingReview) {
                if let preview {
                    MailRuleReviewView(
                        draft: draft,
                        preview: preview,
                        isSaving: isSaving,
                        allowsSave: preview.conflict == nil || preview.replacementBinding != nil,
                        title: "Review New Rule",
                        saveTitle: preview.conflict == nil ? "Create Rule" : "Replace Existing Rule",
                        cancel: { showingReview = false },
                        save: saveRule
                    )
                }
            }
            .alert("Couldn’t test rule", isPresented: Binding(
                get: { localError != nil },
                set: { if !$0 { localError = nil } }
            )) {
                Button("OK") { localError = nil }
            } message: {
                Text(localError ?? "Unknown error")
            }
        }
    }

    private func testRule() {
        let candidate = draft
        Task {
            isPreviewing = true
            defer { isPreviewing = false }
            do {
                preview = try await model.previewMailRule(candidate)
                showingReview = true
            } catch {
                localError = error.localizedDescription
            }
        }
    }

    private func saveRule() {
        guard let reviewedPreview = preview else { return }
        let candidate = draft.bindingExpectedGuards(from: reviewedPreview)
        Task {
            isSaving = true
            let saved = await model.createMailRule(candidate)
            isSaving = false
            if saved {
                showingReview = false
                dismiss()
            } else {
                showingReview = false
                preview = nil
            }
        }
    }

    private static func semanticSeed(from summary: String) -> String {
        let normalized = summary.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        guard !normalized.isEmpty else { return "Messages similar in purpose to this email" }
        return "Messages whose purpose is similar to: \(normalized.prefix(500))"
    }

    private static func defaultDescription(kind: EmailRuleSeedKind, item: EmailItem) -> String {
        switch kind {
        case .sender: "Messages from \(item.senderDisplayName)"
        case .domain:
            "Messages from \(item.fromEmail.split(separator: "@").last.map(String.init) ?? "this domain")"
        case .similar: "Messages similar to this email"
        }
    }
}

private struct DetailValue {
    let label: String
    let value: String
    let symbol: String
    let color: Color
    var trailingValue: String? = nil
    var trailingAccessibilityLabel: String? = nil
}

private struct InsightBlock: View {
    let title: String
    let symbol: String
    let text: String
    let color: Color
    let actionTitle: String?
    let actionSymbol: String?
    let action: (() -> Void)?
    let detectLinks: Bool

    init(
        title: String,
        symbol: String,
        text: String,
        color: Color,
        actionTitle: String? = nil,
        actionSymbol: String? = nil,
        action: (() -> Void)? = nil,
        detectLinks: Bool = false
    ) {
        self.title = title
        self.symbol = symbol
        self.text = text
        self.color = color
        self.actionTitle = actionTitle
        self.actionSymbol = actionSymbol
        self.action = action
        self.detectLinks = detectLinks
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Label(title.uppercased(), systemImage: symbol)
                .font(.caption2.weight(.bold))
                .foregroundStyle(color)
            Group {
                if detectLinks {
                    Text(EmailBodyLinks.render(text))
                } else {
                    Text(text)
                }
            }
                .font(.body)
                .tint(WinnowDesign.accent)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let actionTitle, let action {
                Button(action: action) {
                    if let actionSymbol {
                        Label(actionTitle, systemImage: actionSymbol)
                    } else {
                        Text(actionTitle)
                    }
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(WinnowDesign.accent)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .buttonStyle(.plain)
                .accessibilityHint("Loads the complete message securely from Gmail.")
            }
        }
        .winnowCard()
    }
}

enum EmailBodyLinks {
    private static let detector = try? NSDataDetector(
        types: NSTextCheckingResult.CheckingType.link.rawValue
            | NSTextCheckingResult.CheckingType.phoneNumber.rawValue
    )
    private static let allowedSchemes = Set(["http", "https", "mailto", "tel"])

    static func render(_ source: String) -> AttributedString {
        var rendered = AttributedString(source)
        guard let detector else { return rendered }

        let fullRange = NSRange(source.startIndex..<source.endIndex, in: source)
        for match in detector.matches(in: source, range: fullRange) {
            guard let url = safeURL(for: match),
                  let sourceRange = Range(match.range, in: source),
                  let lowerBound = AttributedString.Index(sourceRange.lowerBound, within: rendered),
                  let upperBound = AttributedString.Index(sourceRange.upperBound, within: rendered) else {
                continue
            }
            rendered[lowerBound..<upperBound].link = url
        }
        return rendered
    }

    private static func safeURL(for match: NSTextCheckingResult) -> URL? {
        let url: URL?
        if match.resultType == .phoneNumber, let phoneNumber = match.phoneNumber {
            let normalized = phoneNumber.filter { $0.isNumber || $0 == "+" }
            url = normalized.isEmpty ? nil : URL(string: "tel:\(normalized)")
        } else {
            url = match.url
        }

        guard let url,
              let scheme = url.scheme?.lowercased(),
              allowedSchemes.contains(scheme) else { return nil }
        return url
    }
}

private struct ConversationPreviewSection: View {
    let configuration: ServerConfiguration
    let emailID: String
    let focusedMessageID: String
    let fallbackSubject: String
    let account: String
    let viewFullConversation: () -> Void

    @State private var content: EmailContent?
    @State private var isLoading = true
    @State private var loadFailed = false

    private var previousMessages: [FullEmailMessage] {
        guard let content else { return [] }
        return content.messagesForDisplay.filter { $0.id != focusedMessageID }
    }

    var body: some View {
        Group {
            if let content, !previousMessages.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Label("EARLIER IN THIS CONVERSATION", systemImage: "bubble.left.and.bubble.right")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(WinnowDesign.accent)
                        Spacer(minLength: 8)
                        Text("\(content.messages.count) messages")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 11)

                    ForEach(Array(previousMessages.prefix(4).enumerated()), id: \.element.id) { index, message in
                        if index > 0 { DetailDivider() }
                        NavigationLink {
                            ConversationMessageDetailView(
                                message: message,
                                fallbackSubject: fallbackSubject,
                                account: account
                            )
                        } label: {
                            ConversationMessageRow(message: message, account: account)
                        }
                        .buttonStyle(.plain)
                    }

                    if previousMessages.count > 4 {
                        DetailDivider()
                        Button(action: viewFullConversation) {
                            Label(
                                "View \(previousMessages.count - 4) more messages",
                                systemImage: "ellipsis.message"
                            )
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(WinnowDesign.accent)
                    }
                }
                .winnowCard(padding: 4)
            } else if isLoading {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Loading conversation…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .winnowCard(padding: 14)
            } else if loadFailed {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.bubble")
                        .foregroundStyle(WinnowDesign.amber)
                    Text("Earlier messages couldn’t be loaded.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button("Retry") { Task { await load() } }
                        .font(.subheadline.weight(.semibold))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .winnowCard(padding: 14)
            }
        }
        .task(id: emailID) { await load() }
    }

    @MainActor
    private func load() async {
        isLoading = true
        loadFailed = false
        do {
            content = try await APIClient(configuration: configuration).emailContent(emailID: emailID)
        } catch {
            content = nil
            loadFailed = true
        }
        isLoading = false
    }
}

private struct ConversationMessageRow: View {
    let message: FullEmailMessage
    let account: String

    private var sender: String {
        message.from.localizedCaseInsensitiveContains(account) ? "You" : (message.from.isEmpty ? "Unknown sender" : message.from)
    }

    private var preview: String {
        message.body
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: sender == "You" ? "arrowshape.turn.up.left.fill" : "arrowshape.turn.up.left.2.fill")
                .font(.subheadline)
                .foregroundStyle(WinnowDesign.accent)
                .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(sender)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if !message.date.isEmpty {
                        Text(message.date)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                Text(preview.isEmpty ? "No message preview available." : preview)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(.tertiary)
                .padding(.top, 4)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens this earlier message")
    }
}

private struct ConversationMessageDetailView: View {
    let message: FullEmailMessage
    let fallbackSubject: String
    let account: String

    var body: some View {
        ZStack {
            AppBackdrop()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(message.subject.isEmpty ? fallbackSubject : message.subject)
                            .font(.title2.bold())
                            .fixedSize(horizontal: false, vertical: true)
                        Label(account, systemImage: "person.crop.circle")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .winnowCard()

                    FullEmailMessageCard(
                        message: message,
                        position: 0,
                        count: 1,
                        isSelectedMessage: false,
                        initiallyExpanded: true
                    )
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        }
        .navigationTitle("Message")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct FullEmailView: View {
    @Environment(\.dismiss) private var dismiss
    let configuration: ServerConfiguration
    let emailID: String
    let fallbackSubject: String
    let account: String

    @State private var content: EmailContent?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackdrop()
                Group {
                    if let content {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 14) {
                                conversationHeader(content)
                                let messages = content.messagesForDisplay
                                ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                                    FullEmailMessageCard(
                                        message: message,
                                        position: index,
                                        count: messages.count,
                                        isSelectedMessage: message.id == content.focusedMessageId,
                                        initiallyExpanded: index == 0
                                    )
                                }
                                if content.truncated {
                                    Label("This unusually long conversation was shortened for display.", systemImage: "scissors")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .winnowCard(padding: 14)
                                }
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                        }
                    } else if isLoading {
                        VStack(spacing: 12) {
                            ProgressView()
                            Text("Loading from Gmail…")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        ContentUnavailableView {
                            Label("Email unavailable", systemImage: "exclamationmark.triangle")
                        } description: {
                            Text(errorMessage ?? "Winnow couldn’t load this message from Gmail.")
                        } actions: {
                            Button("Try Again") { Task { await load() } }
                                .buttonStyle(.borderedProminent)
                                .tint(WinnowDesign.accent)
                        }
                    }
                }
            }
            .navigationTitle("Full Email")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task(id: emailID) { await load() }
        }
    }

    private func conversationHeader(_ content: EmailContent) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(content.subject.isEmpty ? fallbackSubject : content.subject)
                .font(.title2.bold())
                .fixedSize(horizontal: false, vertical: true)
            Label(content.account.isEmpty ? account : content.account, systemImage: "person.crop.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
            if content.messages.count > 1 {
                Text("\(content.messages.count) messages")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(WinnowDesign.accent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .winnowCard()
    }

    @MainActor
    private func load() async {
        isLoading = true
        errorMessage = nil
        do {
            content = try await APIClient(configuration: configuration).emailContent(emailID: emailID)
        } catch {
            content = nil
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

private struct FullEmailMessageCard: View {
    let message: FullEmailMessage
    let position: Int
    let count: Int
    let isSelectedMessage: Bool
    @State private var isExpanded: Bool

    init(
        message: FullEmailMessage,
        position: Int,
        count: Int,
        isSelectedMessage: Bool,
        initiallyExpanded: Bool
    ) {
        self.message = message
        self.position = position
        self.count = count
        self.isSelectedMessage = isSelectedMessage
        _isExpanded = State(initialValue: initiallyExpanded)
    }

    var body: some View {
        Group {
            if count == 1 {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    messageDetails
                }
            } else {
                DisclosureGroup(isExpanded: $isExpanded) {
                    messageDetails
                        .padding(.top, 12)
                } label: {
                    header
                }
                .tint(WinnowDesign.accent)
            }
        }
        .winnowCard()
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(EmailBodyLinks.render(message.from.isEmpty ? "Unknown sender" : message.from))
                    .font(.headline)
                    .tint(WinnowDesign.accent)
                    .lineLimit(2)
                if !message.date.isEmpty {
                    Text(message.date)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if isSelectedMessage {
                Text("Selected")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(WinnowDesign.accent)
            } else if count > 1 {
                Text("\(position + 1) of \(count)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var messageDetails: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                if !message.to.isEmpty { metadataLine("To", message.to) }
                if !message.cc.isEmpty { metadataLine("Cc", message.cc) }
            }
            Divider()
            if message.body.isEmpty {
                Text("This message has no displayable text body.")
                    .italic()
                    .foregroundStyle(.secondary)
            } else {
                Text(EmailBodyLinks.render(message.body))
                    .font(.body)
                    .tint(WinnowDesign.accent)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func metadataLine(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 5) {
            Text("\(label):").foregroundStyle(.tertiary)
            Text(EmailBodyLinks.render(value))
                .foregroundStyle(.secondary)
                .tint(WinnowDesign.accent)
        }
        .font(.caption)
    }
}

private struct DetailRow: View {
    let label: String
    let value: String
    let symbol: String
    let color: Color
    var trailingValue: String? = nil
    var trailingAccessibilityLabel: String? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                Text(value).font(.subheadline.weight(.medium))
            }
            Spacer()
            if let trailingValue {
                Text(trailingValue)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel(trailingAccessibilityLabel ?? trailingValue)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}

private struct DetailDivider: View {
    var body: some View {
        Divider().padding(.leading, 46)
    }
}

private struct DetailActionLabel: View {
    let title: String
    let symbol: String

    var body: some View {
        Label(title, systemImage: symbol)
            .lineLimit(1)
            .minimumScaleFactor(0.82)
            .frame(maxWidth: .infinity, minHeight: 34)
    }
}

private struct AdaptiveActionPair<Leading: View, Trailing: View>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private let leading: Leading
    private let trailing: Trailing

    init(
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.leading = leading()
        self.trailing = trailing()
    }

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(spacing: 10) {
                leading
                trailing
            }
        } else {
            HStack(spacing: 10) {
                leading
                trailing
            }
        }
    }
}
