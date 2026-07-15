import Foundation
import QuickLook
import SwiftUI
import WebKit

struct EmailDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var model: AppModel
    let emailID: String
    @State private var confirmUnsubscribe = false
    @State private var assistantComposerRequest: AssistantComposerRequest?
    @State private var assistantFocusRequest: UUID?
    @State private var editingRule: MailRule?
    @State private var showingCreateRule = false
    @State private var showingFullEmail = false
    @State private var fetchedAttachments: [EmailAttachment]?
    @State private var downloadingAttachmentID: String?
    @State private var attachmentPreviewURL: URL?
    @State private var attachmentError: String?

    private var item: EmailItem? { model.email(id: emailID) }

    var body: some View {
        ZStack {
            AppBackdrop()
            if let item {
                EmailAssistantThreadView(
                    configuration: model.configuration,
                    account: item.account,
                    accountStatus: model.account(email: item.account),
                    emailItemID: item.id,
                    contextTitle: item.displaySubject ?? "No subject",
                    composerRequest: $assistantComposerRequest,
                    focusComposerRequest: $assistantFocusRequest,
                    onMailboxChanged: { await model.refresh(silent: true) }
                ) {
                    VStack(spacing: 16) {
                        senderHeader(item)

                        if let decision = item.handlingDecision {
                            HandlingDecisionCard(
                                decision: decision,
                                isBusy: model.performingEmailIDs.contains(item.id),
                                canUndo: item.undoAction != nil,
                                undoConfirmationTitle: undoConfirmationTitle(for: item),
                                undoConfirmationButton: undoConfirmationButton(for: item),
                                undoConfirmationMessage: undoConfirmationMessage(for: item),
                                undo: { Task { _ = await model.undoHandling(on: item) } },
                                adjust: { adjustFutureHandling(item, decision: decision) },
                                createRule: { showingCreateRule = true }
                            )
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

                        ConversationPrelude(
                            configuration: model.configuration,
                            showsEarlierMessages: item.isConversation,
                            emailID: item.id,
                            focusedMessageID: item.messageId,
                            fallbackSubject: item.displaySubject ?? "No subject",
                            account: item.account,
                            summary: item.summary,
                            attachments: fetchedAttachments ?? item.attachments,
                            downloadingAttachmentID: downloadingAttachmentID,
                            canLoadFullEmail: item.canLoadFullContent,
                            openAttachment: { openAttachment($0, from: item) },
                            viewFullEmail: { showingFullEmail = true }
                        )
                    }
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
        .quickLookPreview($attachmentPreviewURL)
        .alert(
            "Couldn’t Open Attachment",
            isPresented: Binding(
                get: { attachmentError != nil },
                set: { if !$0 { attachmentError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(attachmentError ?? "The attachment couldn’t be opened.")
        }
        .task(id: emailID) {
            guard let item = model.email(id: emailID) else { return }
            focusConversationIfRequested()
            await model.markReadWhenOpened(item)
            if item.handlingDecision?.appliedRule != nil {
                await model.loadMailRules(showsError: false)
            }
        }
        .onChange(of: model.conversationFocusRequest) { _, _ in
            focusConversationIfRequested()
        }
        .task(id: "attachments-\(emailID)") {
            fetchedAttachments = nil
            guard let item = model.email(id: emailID), item.canLoadFullContent else { return }
            fetchedAttachments = try? await APIClient(configuration: model.configuration)
                .emailAttachments(emailID: item.id)
        }
        .onDisappear {
            if let attachmentPreviewURL {
                AttachmentPreviewFile.remove(attachmentPreviewURL)
            }
        }
    }

    private func focusConversationIfRequested() {
        guard let request = model.conversationFocusRequest, request.emailID == emailID else { return }
        assistantFocusRequest = request.id
        model.consumeConversationFocus(request)
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
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                ZStack(alignment: .bottomTrailing) {
                    SenderAvatar(
                        initials: item.senderInitials,
                        seed: item.fromEmail.isEmpty ? item.senderDisplayName : item.fromEmail,
                        size: 40
                    )
                    AccountAvatarBadge(account: model.account(email: item.account), size: 16)
                        .offset(x: 3, y: 3)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.senderDisplayName)
                        .font(.headline)
                        .lineLimit(1)
                    if !item.fromEmail.isEmpty {
                        Text(item.fromEmail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 4) {
                    CapsuleLabel(
                        item.isArchived ? "Archived" : "Inbox",
                        symbol: item.isArchived ? "archivebox" : "tray",
                        color: item.isArchived ? WinnowDesign.amber : WinnowDesign.mint
                    )
                    if let date = item.displayDate {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
            }
            if let subject = item.displaySubject {
                Text(subject)
                    .font(.title3.bold())
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()
            actionsRow(item)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .winnowCard(padding: 14)
    }

    private func actionsRow(_ item: EmailItem) -> some View {
        HStack(alignment: .top, spacing: 8) {
            CompactDetailActionButton(
                title: item.isArchived ? "Inbox" : "Archive",
                symbol: item.isArchived ? "tray.and.arrow.down" : "archivebox",
                color: item.isArchived ? WinnowDesign.mint : WinnowDesign.amber
            ) {
                performPrimaryMailboxAction(on: item)
            }
            .accessibilityLabel(item.isArchived ? "Move to Inbox" : "Archive")

            CompactDetailActionButton(
                title: item.isUnread ? "Mark Read" : "Unread",
                symbol: item.isUnread ? "envelope.open" : "envelope.badge",
                color: WinnowDesign.accent
            ) {
                Task { _ = await model.perform(item.isUnread ? .markRead : .markUnread, on: item) }
            }
            .accessibilityLabel(item.isUnread ? "Mark as read" : "Mark as unread")

            if item.canUnsubscribe {
                CompactDetailActionButton(
                    title: "Unsubscribe",
                    symbol: "person.crop.circle.badge.minus",
                    color: WinnowDesign.rose
                ) {
                    confirmUnsubscribe = true
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
            }

            if item.canLoadFullContent, item.summary.isEmpty {
                CompactDetailActionButton(
                    title: "Full Email",
                    symbol: "doc.text.magnifyingglass",
                    color: WinnowDesign.accent
                ) {
                    showingFullEmail = true
                }
                .accessibilityHint("Loads the complete message securely from Gmail.")
            }

            if item.handlingDecision == nil {
                CompactDetailActionButton(
                    title: "New Rule",
                    symbol: "checklist",
                    color: WinnowDesign.mint
                ) {
                    showingCreateRule = true
                }
            }
        }
        .disabled(model.performingEmailIDs.contains(item.id))
    }

    private func performPrimaryMailboxAction(on item: EmailItem) {
        let action: EmailAction = item.isArchived ? .moveToInbox : .archive
        if action == .archive {
            dismiss()
        }
        Task { _ = await model.perform(action, on: item) }
    }

    private func openAttachment(_ attachment: EmailAttachment, from item: EmailItem) {
        guard downloadingAttachmentID == nil else { return }
        guard !attachment.attachmentId.isEmpty else {
            openAttachmentFallback(for: item)
            return
        }

        downloadingAttachmentID = attachment.id
        Task {
            defer { downloadingAttachmentID = nil }
            do {
                let data = try await APIClient(configuration: model.configuration).attachmentData(
                    emailID: item.id,
                    attachmentID: attachment.attachmentId
                )
                if let attachmentPreviewURL {
                    AttachmentPreviewFile.remove(attachmentPreviewURL)
                }
                attachmentPreviewURL = try AttachmentPreviewFile.write(
                    data,
                    filename: attachment.displayName,
                    mimeType: attachment.mimeType
                )
            } catch let APIClientError.server(status, _) where [404, 413, 415].contains(status) {
                openAttachmentFallback(for: item)
            } catch {
                attachmentError = error.localizedDescription
            }
        }
    }

    private func openAttachmentFallback(for item: EmailItem) {
        if let gmailURL = item.gmailURL {
            openURL(gmailURL)
        } else {
            showingFullEmail = true
        }
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

}

private enum AttachmentPreviewFile {
    static func write(_ data: Data, filename: String, mimeType: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("WinnowAttachmentPreviews", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let suppliedName = (filename as NSString).lastPathComponent
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let safeName = sanitizedFilename(suppliedName, mimeType: mimeType)
        let url = directory.appendingPathComponent(safeName, isDirectory: false)
        try data.write(to: url, options: [.atomic])
        return url
    }

    static func remove(_ fileURL: URL) {
        try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
    }

    private static func fallbackFilename(for mimeType: String) -> String {
        switch mimeType.lowercased() {
        case "application/pdf": "Attachment.pdf"
        case "image/jpeg": "Attachment.jpg"
        case "image/png": "Attachment.png"
        case "text/plain": "Attachment.txt"
        default: "Attachment"
        }
    }

    private static func sanitizedFilename(_ suppliedName: String, mimeType: String) -> String {
        guard !suppliedName.isEmpty, suppliedName != ".", suppliedName != ".." else {
            return fallbackFilename(for: mimeType)
        }
        let value = suppliedName as NSString
        let stem = String(value.deletingPathExtension.prefix(48))
        let fileExtension = String(value.pathExtension.prefix(10))
        return fileExtension.isEmpty ? stem : "\(stem).\(fileExtension)"
    }
}

private struct HandlingDecisionCard: View {
    let decision: EmailHandlingDecision
    let isBusy: Bool
    let canUndo: Bool
    let undoConfirmationTitle: String
    let undoConfirmationButton: String
    let undoConfirmationMessage: String
    let undo: () -> Void
    let adjust: () -> Void
    let createRule: () -> Void
    @State private var isExpanded = false
    @State private var confirmUndo = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: decision.effect == .archive ? "archivebox.fill" : "tray.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(effectColor)
                        .frame(width: 34, height: 34)
                        .background(effectColor.opacity(0.14), in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(headline)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                        Text("Why Winnow handled this")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 6)
                    if let confidence = decision.confidence {
                        Text("\(confidence)%")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(effectColor)
                    }
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(headline). Why Winnow handled this")
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")

            if isExpanded {
                Divider()
                    .padding(.vertical, 12)

                VStack(alignment: .leading, spacing: 12) {
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

                    HStack(alignment: .top, spacing: 8) {
                        if canUndo {
                            CompactDetailActionButton(
                                title: "Undo Email",
                                symbol: "arrow.uturn.backward",
                                color: WinnowDesign.amber,
                                action: { confirmUndo = true }
                            )
                            .confirmationDialog(
                                undoConfirmationTitle,
                                isPresented: $confirmUndo,
                                titleVisibility: .visible
                            ) {
                                Button(undoConfirmationButton, action: undo)
                                Button("Cancel", role: .cancel) {}
                            } message: {
                                Text(undoConfirmationMessage)
                            }
                        }

                        CompactDetailActionButton(
                            title: "Adjust Future",
                            symbol: "slider.horizontal.3",
                            color: WinnowDesign.accent,
                            action: adjust
                        )

                        CompactDetailActionButton(
                            title: "New Rule",
                            symbol: "plus.circle",
                            color: WinnowDesign.mint,
                            action: createRule
                        )
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .winnowCard(padding: 12)
        .disabled(isBusy)
    }

    private var effectColor: Color {
        decision.effect == .archive ? WinnowDesign.accent : WinnowDesign.mint
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

private struct ConversationPrelude: View {
    let configuration: ServerConfiguration
    let showsEarlierMessages: Bool
    let emailID: String
    let focusedMessageID: String
    let fallbackSubject: String
    let account: String
    let summary: String
    let attachments: [EmailAttachment]
    let downloadingAttachmentID: String?
    let canLoadFullEmail: Bool
    let openAttachment: (EmailAttachment) -> Void
    let viewFullEmail: () -> Void
    @State private var showingAttachmentChoices = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if showsEarlierMessages {
                ConversationPreviewSection(
                    configuration: configuration,
                    emailID: emailID,
                    focusedMessageID: focusedMessageID,
                    fallbackSubject: fallbackSubject,
                    account: account,
                    viewFullConversation: viewFullEmail
                )
            }

            if !summary.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Label("WINNOW'S SUMMARY", systemImage: "text.alignleft")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(WinnowDesign.accent)

                    Text(summary)
                        .font(.body)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if !attachments.isEmpty || canLoadFullEmail {
                        HStack(spacing: 12) {
                            if let attachment = attachments.first {
                                Button {
                                    if attachments.count == 1 {
                                        openAttachment(attachment)
                                    } else {
                                        showingAttachmentChoices = true
                                    }
                                } label: {
                                    HStack(spacing: 5) {
                                        if downloadingAttachmentID != nil {
                                            ProgressView()
                                                .controlSize(.mini)
                                        } else {
                                            Image(systemName: "paperclip")
                                        }
                                        Text(attachmentTitle)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                    .contentShape(Rectangle())
                                }
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(WinnowDesign.accent)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .buttonStyle(.plain)
                                .disabled(downloadingAttachmentID != nil)
                                .accessibilityLabel(attachmentAccessibilityLabel)
                                .accessibilityHint(attachments.count == 1
                                    ? "Opens the attachment for preview."
                                    : "Shows the attachment list.")
                                .confirmationDialog(
                                    "Attachments",
                                    isPresented: $showingAttachmentChoices,
                                    titleVisibility: .visible
                                ) {
                                    ForEach(attachments) { choice in
                                        Button(choice.displayName) { openAttachment(choice) }
                                    }
                                    Button("Cancel", role: .cancel) {}
                                }
                            }

                            if canLoadFullEmail {
                                Button(action: viewFullEmail) {
                                    Label("View Full Email", systemImage: "doc.text.magnifyingglass")
                                        .fixedSize(horizontal: true, vertical: false)
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint("Loads the complete message securely from Gmail.")
                            }
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(WinnowDesign.accent)
                    }
                }
                .winnowCard()
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Winnow's summary")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var attachmentTitle: String {
        guard attachments.count == 1, let attachment = attachments.first else {
            return "\(attachments.count) attachments"
        }
        return attachment.displayName
    }

    private var attachmentAccessibilityLabel: String {
        guard attachments.count == 1, let attachment = attachments.first else {
            return "Open \(attachments.count) attachments"
        }
        return "Open attachment, \(attachment.accessibilityDescription)"
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
    @AppStorage(WinnowPreferences.preferHTMLEmailKey) private var preferHTMLEmail = false

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
                                        initiallyExpanded: index == 0,
                                        displayMode: displayMode
                                    )
                                }
                                if content.truncated {
                                    Label("This unusually long conversation was shortened for display.", systemImage: "scissors")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .winnowCard(padding: 14)
                                        .padding(.horizontal, displayMode == .html ? 16 : 0)
                                }
                            }
                            .padding(.horizontal, displayMode == .html ? 0 : 16)
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

    private var displayMode: FullEmailDisplayMode {
        preferHTMLEmail ? .html : .plain
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
        .padding(.horizontal, displayMode == .html ? 16 : 0)
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
    let displayMode: FullEmailDisplayMode
    @State private var isExpanded: Bool
    @State private var htmlHeight: CGFloat = 180

    init(
        message: FullEmailMessage,
        position: Int,
        count: Int,
        isSelectedMessage: Bool,
        initiallyExpanded: Bool,
        displayMode: FullEmailDisplayMode = .plain
    ) {
        self.message = message
        self.position = position
        self.count = count
        self.isSelectedMessage = isSelectedMessage
        self.displayMode = displayMode
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
            if displayMode == .html, message.hasHTMLBody {
                SafeEmailHTMLView(html: message.htmlBody, contentHeight: $htmlHeight)
                    .frame(height: htmlHeight)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, -16)
                    .accessibilityLabel("HTML email body")
            } else if message.body.isEmpty {
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

private enum FullEmailDisplayMode {
    case plain
    case html
}

enum SafeEmailHTML {
    static let contentSecurityPolicy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'"

    static func document(for source: String) -> String {
        """
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
            <meta http-equiv="Content-Security-Policy" content="\(contentSecurityPolicy)">
            <style>
              :root { color-scheme: light dark; }
              html, body { margin: 0; padding: 0; background: transparent; }
              body {
                color: #1c1c1e;
                font: -apple-system-body;
                overflow-wrap: anywhere;
                word-break: normal;
              }
              img, video, table { max-width: 100% !important; }
              img { height: auto !important; }
              img:not([src^="data:" i]) { display: none !important; }
              pre { white-space: pre-wrap; overflow-wrap: anywhere; }
              a { color: #6657e8; }
              @media (prefers-color-scheme: dark) {
                body { color: #f2f2f7; }
                a { color: #9b8cff; }
              }
            </style>
          </head>
          <body>\(source)</body>
        </html>
        """
    }
}

private struct SafeEmailHTMLView: UIViewRepresentable {
    let html: String
    @Binding var contentHeight: CGFloat

    private static let maximumHeight: CGFloat = 12_000

    func makeCoordinator() -> Coordinator {
        Coordinator(contentHeight: $contentHeight)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsAirPlayForMediaPlayback = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        context.coordinator.observeContentSize(of: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loadedHTML != html else { return }
        context.coordinator.loadedHTML = html
        webView.loadHTMLString(SafeEmailHTML.document(for: html), baseURL: nil)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        @Binding private var contentHeight: CGFloat
        var loadedHTML = ""
        private var contentSizeObservation: NSKeyValueObservation?

        init(contentHeight: Binding<CGFloat>) {
            _contentHeight = contentHeight
        }

        func observeContentSize(of webView: WKWebView) {
            contentSizeObservation = webView.scrollView.observe(\.contentSize, options: [.new]) { [weak self, weak webView] _, change in
                guard let self, let webView, let measuredHeight = change.newValue?.height,
                      measuredHeight.isFinite, measuredHeight > 0 else { return }
                let boundedHeight = min(max(measuredHeight, 120), SafeEmailHTMLView.maximumHeight)
                DispatchQueue.main.async {
                    self.contentHeight = boundedHeight
                    webView.scrollView.isScrollEnabled = measuredHeight > SafeEmailHTMLView.maximumHeight
                }
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            let isInitialDocument = navigationAction.navigationType == .other
                && navigationAction.targetFrame?.isMainFrame == true
                && navigationAction.request.url?.scheme == "about"
            decisionHandler(isInitialDocument ? .allow : .cancel)
        }
    }
}

private struct DetailDivider: View {
    var body: some View {
        Divider().padding(.leading, 46)
    }
}

private struct CompactDetailActionButton: View {
    let title: String
    let symbol: String
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(color)
                    .frame(width: 36, height: 36)
                    .background(color.opacity(0.14), in: Circle())
                Text(title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 58, alignment: .top)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }
}
