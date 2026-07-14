import SwiftUI
import UIKit

struct AssistantComposerRequest: Identifiable, Equatable {
    let id = UUID()
    let text: String
}

struct AssistantMailboxView: View {
    @EnvironmentObject private var model: AppModel
    let openStats: () -> Void
    let dismiss: (() -> Void)?
    @State private var selectedAccount = ""

    init(openStats: @escaping () -> Void, dismiss: (() -> Void)? = nil) {
        self.openStats = openStats
        self.dismiss = dismiss
    }

    var body: some View {
        NavigationStack {
            AssistantConversationView(
                configuration: model.configuration,
                scope: .mailbox,
                account: selectedAccount.nilIfEmpty,
                emailItemID: nil,
                contextTitle: nil,
                onMailboxChanged: { await model.refresh(silent: true) }
            )
            .id(selectedAccount)
            .navigationTitle("Ask Winnow")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let dismiss {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(action: dismiss) {
                            Image(systemName: "xmark")
                                .font(.body.weight(.semibold))
                        }
                        .accessibilityLabel("Close Ask Winnow")
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if model.accounts.count > 1 {
                        AccountFilterMenu(
                            selection: $selectedAccount,
                            accounts: model.accounts,
                            accessibilityLabel: "Choose accounts to search"
                        )
                    }
                    WinnowStatusButton(
                        isOnline: model.isOnline,
                        isRefreshing: model.isRefreshing,
                        action: openStats
                    )
                }
            }
        }
    }
}

struct AssistantConversationView: View {
    private let configuration: ServerConfiguration
    private let scope: AssistantScope
    private let account: String?
    private let emailItemID: String?
    private let contextTitle: String?
    private let onMailboxChanged: () async -> Void

    init(
        configuration: ServerConfiguration,
        scope: AssistantScope,
        account: String?,
        emailItemID: String?,
        contextTitle: String?,
        onMailboxChanged: @escaping () async -> Void
    ) {
        self.configuration = configuration
        self.scope = scope
        self.account = account
        self.emailItemID = emailItemID
        self.contextTitle = contextTitle
        self.onMailboxChanged = onMailboxChanged
    }

    var body: some View {
        AssistantConversationHost(
            configuration: configuration,
            scope: scope,
            account: account,
            emailItemID: emailItemID,
            contextTitle: contextTitle,
            presentation: .standalone,
            onMailboxChanged: onMailboxChanged
        ) {
            EmptyView()
        }
    }
}

/// Owns the detail screen's only vertical scroll view and keeps the email-scoped
/// composer above the keyboard. Put all of the email metadata and action content
/// in `detailContent`; the persistent Winnow conversation is appended below it.
struct EmailAssistantThreadView<DetailContent: View>: View {
    private let configuration: ServerConfiguration
    private let account: String
    private let accountStatus: AccountStatus?
    private let emailItemID: String
    private let contextTitle: String?
    private let onMailboxChanged: () async -> Void
    @Binding private var composerRequest: AssistantComposerRequest?
    @Binding private var focusComposerRequest: UUID?
    private let detailContent: DetailContent

    init(
        configuration: ServerConfiguration,
        account: String,
        accountStatus: AccountStatus?,
        emailItemID: String,
        contextTitle: String?,
        composerRequest: Binding<AssistantComposerRequest?> = .constant(nil),
        focusComposerRequest: Binding<UUID?> = .constant(nil),
        onMailboxChanged: @escaping () async -> Void,
        @ViewBuilder detailContent: () -> DetailContent
    ) {
        self.configuration = configuration
        self.account = account
        self.accountStatus = accountStatus
        self.emailItemID = emailItemID
        self.contextTitle = contextTitle
        _composerRequest = composerRequest
        _focusComposerRequest = focusComposerRequest
        self.onMailboxChanged = onMailboxChanged
        self.detailContent = detailContent()
    }

    var body: some View {
        AssistantConversationHost(
            configuration: configuration,
            scope: .email,
            account: account,
            emailItemID: emailItemID,
            contextTitle: contextTitle,
            presentation: .inlineEmail,
            accountStatus: accountStatus,
            composerRequest: $composerRequest,
            focusComposerRequest: $focusComposerRequest,
            onMailboxChanged: onMailboxChanged
        ) {
            detailContent
        }
        // A detail view can be reused by a NavigationStack. This identity makes
        // the conversation StateObject follow the selected email in that case.
        .id(emailItemID)
    }
}

private enum AssistantPresentation {
    case standalone
    case inlineEmail
}

private struct AssistantConversationHost<LeadingContent: View>: View {
    @StateObject private var viewModel: AssistantViewModel
    private let contextTitle: String?
    private let presentation: AssistantPresentation
    private let accountStatus: AccountStatus?
    @Binding private var composerRequest: AssistantComposerRequest?
    @Binding private var focusComposerRequest: UUID?
    private let onMailboxChanged: () async -> Void
    private let leadingContent: LeadingContent

    init(
        configuration: ServerConfiguration,
        scope: AssistantScope,
        account: String?,
        emailItemID: String?,
        contextTitle: String?,
        presentation: AssistantPresentation,
        accountStatus: AccountStatus? = nil,
        composerRequest: Binding<AssistantComposerRequest?> = .constant(nil),
        focusComposerRequest: Binding<UUID?> = .constant(nil),
        onMailboxChanged: @escaping () async -> Void,
        @ViewBuilder leadingContent: () -> LeadingContent
    ) {
        _viewModel = StateObject(wrappedValue: AssistantViewModel(
            configuration: configuration,
            scope: scope,
            account: account,
            emailItemID: emailItemID
        ))
        self.contextTitle = contextTitle
        self.presentation = presentation
        self.accountStatus = accountStatus
        _composerRequest = composerRequest
        _focusComposerRequest = focusComposerRequest
        self.onMailboxChanged = onMailboxChanged
        self.leadingContent = leadingContent()
    }

    var body: some View {
        AssistantConversationLayout(
            viewModel: viewModel,
            contextTitle: contextTitle,
            presentation: presentation,
            accountStatus: accountStatus,
            composerRequest: $composerRequest,
            focusComposerRequest: $focusComposerRequest,
            onMailboxChanged: onMailboxChanged
        ) {
            leadingContent
        }
    }
}

private struct AssistantConversationLayout<LeadingContent: View>: View {
    @ObservedObject var viewModel: AssistantViewModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var composerText = ""
    @State private var reviewedProposal: AssistantProposal?
    @State private var inlineThreadActivated = false
    @FocusState private var composerFocused: Bool

    let contextTitle: String?
    let presentation: AssistantPresentation
    let accountStatus: AccountStatus?
    @Binding var composerRequest: AssistantComposerRequest?
    @Binding var focusComposerRequest: UUID?
    let onMailboxChanged: () async -> Void
    let leadingContent: LeadingContent

    init(
        viewModel: AssistantViewModel,
        contextTitle: String?,
        presentation: AssistantPresentation,
        accountStatus: AccountStatus? = nil,
        composerRequest: Binding<AssistantComposerRequest?> = .constant(nil),
        focusComposerRequest: Binding<UUID?> = .constant(nil),
        onMailboxChanged: @escaping () async -> Void,
        @ViewBuilder leadingContent: () -> LeadingContent
    ) {
        self.viewModel = viewModel
        self.contextTitle = contextTitle
        self.presentation = presentation
        self.accountStatus = accountStatus
        _composerRequest = composerRequest
        _focusComposerRequest = focusComposerRequest
        self.onMailboxChanged = onMailboxChanged
        self.leadingContent = leadingContent()
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    // Conversation threads are bounded. A lazy stack here can enter
                    // a SwiftUI placement loop when the inline email detail contains
                    // the wrapping suggestion cloud and begins moving.
                    VStack(spacing: presentation == .inlineEmail ? 16 : 14) {
                        leadingContent

                        scopeLabel

                        if viewModel.isLoading && viewModel.messages.isEmpty {
                            loadingState
                        } else if viewModel.messages.isEmpty {
                            emptyState
                        } else {
                            ForEach(viewModel.messages) { message in
                                AssistantMessageView(
                                    message: message,
                                    accountStatus: accountStatus,
                                    showsDraft: message.id == latestDraftMessageID,
                                    isProposalWorking: viewModel.isProposalWorking(message.proposal),
                                    reviewProposal: { reviewedProposal = $0 },
                                    cancelProposal: cancel,
                                    sendDraft: { sendDraft(message) }
                                )
                                .id(message.id)
                                .transition(messageTransition)
                            }
                        }

                        if presentation == .inlineEmail,
                           !viewModel.isLoading,
                           viewModel.messages.isEmpty {
                            suggestionCloud
                        }

                        if viewModel.isSending {
                            workingState
                                .id("assistant-working")
                                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
                        }

                        if let error = viewModel.errorMessage {
                            errorCard(error)
                        }

                        Color.clear
                            .frame(height: 1)
                            .id("assistant-bottom")
                    }
                    .padding(16)
                    .padding(.bottom, 8)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: viewModel.canonicalResponseRevision)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: viewModel.isSending)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: viewModel.messages.count) { _, _ in
                    // Opening an email should show its header rather than jump
                    // past it to restored history. The first send activates the
                    // thread before its response arrives, so new messages still
                    // scroll immediately even when the initial history was empty.
                    if presentation == .inlineEmail, !inlineThreadActivated { return }
                    scrollToBottom(proxy)
                }
                .onChange(of: viewModel.isSending) { _, sending in
                    if sending { scrollToBottom(proxy) }
                }
                .onChange(of: composerFocused) { _, focused in
                    guard focused else { return }
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(180))
                        scrollToBottom(proxy)
                    }
                }
                .onChange(of: composerRequest) { _, request in
                    guard let request else { return }
                    composerRequest = nil
                    send(request.text)
                }
            }

            composer
        }
        .background { AppBackdrop() }
        .task { await viewModel.startIfNeeded() }
        .task {
            guard presentation == .standalone else { return }
            // Let the sheet finish presenting before requesting focus so the
            // keyboard appears reliably when Ask Winnow opens from the tab bar.
            try? await Task.sleep(for: .milliseconds(350))
            composerFocused = true
        }
        .task(id: focusComposerRequest) {
            guard presentation == .inlineEmail, let request = focusComposerRequest else { return }
            inlineThreadActivated = true
            // Let navigation and restored conversation layout settle before
            // focusing; the focus observer then scrolls to the composer.
            try? await Task.sleep(for: .milliseconds(250))
            guard focusComposerRequest == request else { return }
            composerFocused = true
            focusComposerRequest = nil
        }
        .sheet(item: $reviewedProposal) { proposal in
            if proposal.isDeviceAction {
                DeviceProposalReviewView(
                    proposal: proposal,
                    isWorking: viewModel.activeProposalID == proposal.id,
                    complete: { completeClientAction(proposal) },
                    cancel: { cancel(proposal) },
                    selectedContact: { name, email in selectContact(name: name, email: email, for: proposal) }
                )
            } else {
                ProposalConfirmationView(
                    proposal: proposal,
                    scopeTitle: scopeDescription,
                    isWorking: viewModel.activeProposalID == proposal.id,
                    confirm: { confirm(proposal) },
                    cancel: { cancel(proposal) }
                )
                .presentationDetents([.medium, .large])
            }
        }
    }

    private var scopeLabel: some View {
        Group {
            if presentation != .inlineEmail {
                VStack(alignment: .leading, spacing: 2) {
                    Text(viewModel.scope == .email ? "Asking about this email · \(scopeDescription)" : "Searching \(scopeDescription)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if let contextTitle, !contextTitle.isEmpty {
                        Text(contextTitle).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    private var scopeDescription: String {
        if viewModel.scope == .email {
            return viewModel.account ?? "This email's account"
        }
        return viewModel.account ?? "all accounts"
    }

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text(presentation == .inlineEmail ? "Loading conversation…" : "Starting a private conversation…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, presentation == .inlineEmail ? 24 : 50)
    }

    private var workingState: some View {
        HStack(spacing: 9) {
            if reduceMotion {
                Image(systemName: "sparkles")
                    .foregroundStyle(WinnowDesign.accent)
            } else {
                ProgressView().controlSize(.small)
            }
            Text(viewModel.progress?.label ?? "Winnow is working…")
                .contentTransition(.opacity)
                .animation(
                    reduceMotion ? nil : .easeInOut(duration: 0.16),
                    value: viewModel.progress?.stage
                )
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color.primary.opacity(0.045), in: Capsule())
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(viewModel.progress?.label ?? "Winnow is working")
    }

    private var messageTransition: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .opacity.combined(with: .move(edge: .bottom)),
                removal: .opacity
            )
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        if reduceMotion {
            proxy.scrollTo("assistant-bottom", anchor: .bottom)
        } else {
            withAnimation { proxy.scrollTo("assistant-bottom", anchor: .bottom) }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if presentation != .inlineEmail {
            VStack(spacing: 18) {
                VStack(spacing: 8) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 34, weight: .semibold))
                        .foregroundStyle(WinnowDesign.brightIndigo)
                    Text(viewModel.scope == .email ? "Ask about this message" : "Ask across your mailbox")
                        .font(.title3.bold())
                }

                suggestionCloud
            }
            .frame(maxWidth: .infinity)
            .winnowCard()
        }
    }

    private var suggestionCloud: some View {
        SuggestionCloudLayout(spacing: 7) {
            ForEach(suggestions, id: \.self) { suggestion in
                Button(suggestion) {
                    send(suggestion)
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .tint(WinnowDesign.accent)
                .fixedSize(horizontal: true, vertical: false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
        .padding(.bottom, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggested messages")
    }

    private var suggestions: [String] {
        if viewModel.scope == .email {
            return [
                "What should I do?",
                "Draft a reply",
                "Key takeaway?",
                "Unsubscribe",
                "Always archive",
                "Always keep",
                "Why handled?",
            ]
        }
        return [
            "What needs attention?",
            "Find an order",
            "Find a receipt",
            "Recent payments",
            "Find my EIN",
        ]
    }

    private var composer: some View {
        Group {
            if #available(iOS 26.0, *) {
                GlassEffectContainer(spacing: 10) {
                    composerControls
                }
            } else {
                composerControls
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }

    private var composerControls: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Ask Winnow…", text: $composerText, axis: .vertical)
                .lineLimit(1...5)
                .focused($composerFocused)
                .submitLabel(.return)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .modifier(AssistantComposerFieldStyle())

            composerSendButton
        }
    }

    @ViewBuilder
    private var composerSendButton: some View {
        if #available(iOS 26.0, *) {
            sendButton
                .buttonStyle(.plain)
                .glassEffect(.regular.tint(WinnowDesign.indigo).interactive(), in: Circle())
        } else {
            sendButton
                .buttonStyle(.plain)
                .background(WinnowDesign.heroGradient, in: Circle())
        }
    }

    private var sendButton: some View {
        Button(action: { send() }) {
            Image(systemName: "arrow.up")
                .font(.headline.bold())
                .foregroundStyle(.white)
                .frame(width: 42, height: 42)
                .contentShape(Circle())
        }
        .disabled(composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.isWorking)
        .opacity(viewModel.isWorking ? 0.55 : 1)
        .accessibilityLabel("Send message")
    }

    private func errorCard(_ error: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Winnow couldn't finish", systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(WinnowDesign.rose)
            Text(error).font(.caption).foregroundStyle(.secondary)
            HStack {
                if viewModel.conversation == nil {
                    Button("Try again") { Task { await viewModel.startIfNeeded() } }
                }
                if viewModel.hasIndeterminateMessageAttempt {
                    Button("Retry response") {
                        Task {
                            let succeeded = await viewModel.retryIndeterminateMessage()
                            if succeeded { await onMailboxChanged() }
                        }
                    }
                }
                if !viewModel.hasIndeterminateMessageAttempt {
                    Button("Dismiss") { viewModel.errorMessage = nil }
                }
            }
            .font(.caption.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .winnowCard(padding: 14)
    }

    private func send(_ requestedText: String? = nil) {
        let text = (requestedText ?? composerText).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !viewModel.isWorking else { return }
        inlineThreadActivated = true
        composerText = ""
        composerFocused = false
        Task {
            let succeeded = await viewModel.send(text)
            if succeeded { await onMailboxChanged() }
            else if viewModel.shouldRestoreFailedComposerText || viewModel.conversation == nil { composerText = text }
        }
    }

    private var latestDraftMessageID: String? {
        viewModel.messages.last(where: { $0.draft != nil })?.id
    }

    private func sendDraft(_ message: AssistantMessage) {
        guard message.draft != nil, !viewModel.isWorking else { return }
        inlineThreadActivated = true
        composerFocused = false
        Task {
            if let proposal = await viewModel.proposeDraftSend(messageID: message.id) {
                reviewedProposal = proposal
            }
        }
    }

    private func confirm(_ proposal: AssistantProposal) {
        inlineThreadActivated = true
        Task {
            let succeeded = await viewModel.confirm(proposal)
            if succeeded {
                reviewedProposal = nil
                await onMailboxChanged()
            }
        }
    }

    private func cancel(_ proposal: AssistantProposal) {
        inlineThreadActivated = true
        Task {
            let succeeded = await viewModel.cancel(proposal)
            if succeeded { reviewedProposal = nil }
        }
    }

    private func completeClientAction(_ proposal: AssistantProposal) {
        inlineThreadActivated = true
        Task {
            let succeeded = await viewModel.completeClientAction(proposal)
            if succeeded {
                reviewedProposal = nil
                await onMailboxChanged()
            }
        }
    }

    private func selectContact(name: String, email: String, for proposal: AssistantProposal) {
        inlineThreadActivated = true
        Task {
            guard await viewModel.completeClientAction(proposal) else { return }
            reviewedProposal = nil
            let cleanName = name.replacingOccurrences(of: "[\\r\\n<>]", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleanEmail.isEmpty else { return }
            _ = await viewModel.send("Forward this email to \(cleanName) <\(cleanEmail)>.")
        }
    }

}

private struct SuggestionCloudLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let fallbackWidth = subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
        let availableWidth = proposal.width ?? fallbackWidth
        let result = arrangement(maxWidth: availableWidth, subviews: subviews)
        return CGSize(width: proposal.width ?? result.size.width, height: result.size.height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let result = arrangement(maxWidth: bounds.width, subviews: subviews)
        for (subview, origin) in zip(subviews, result.origins) {
            subview.place(
                at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
                anchor: .topLeading,
                proposal: .unspecified
            )
        }
    }

    private func arrangement(maxWidth: CGFloat, subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var contentWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }

            origins.append(CGPoint(x: x, y: y))
            contentWidth = max(contentWidth, x + size.width)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }

        return (CGSize(width: contentWidth, height: y + rowHeight), origins)
    }
}

private struct AssistantComposerFieldStyle: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .glassEffect(
                    .regular.interactive(),
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
        } else {
            content
                .background(
                    .regularMaterial,
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
        }
    }
}

private struct AssistantMessageView: View {
    let message: AssistantMessage
    let accountStatus: AccountStatus?
    let showsDraft: Bool
    let isProposalWorking: Bool
    let reviewProposal: (AssistantProposal) -> Void
    let cancelProposal: (AssistantProposal) -> Void
    let sendDraft: () -> Void

    private var isUser: Bool { message.role == "user" }
    private var isResult: Bool { message.kind == "result" || message.role == "tool" }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 10) {
            if !message.text.isEmpty {
                messageBubble
            }

            if !message.evidence.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("SOURCES").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                    ForEach(message.evidence) { evidence in
                        AssistantEvidenceCard(evidence: evidence)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if showsDraft, let draft = message.draft {
                AssistantDraftCard(
                    draft: draft,
                    isWorking: isProposalWorking,
                    allowsSend: message.proposal?.status != "pending" && message.proposal?.status != "completed",
                    send: sendDraft
                )
            }

            if let proposal = message.proposal {
                AssistantProposalCard(
                    proposal: proposal,
                    isWorking: isProposalWorking,
                    review: { reviewProposal(proposal) },
                    cancel: { cancelProposal(proposal) }
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }

    private var messageBubble: some View {
        Text(message.formattedText)
            .font(.body)
            .foregroundStyle(isUser ? Color.white : Color.primary)
            .textSelection(.enabled)
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(bubbleBackground, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(alignment: .bottomTrailing) {
                if showsAccountAvatar {
                    AccountAvatarBadge(account: accountStatus, size: 22)
                        .offset(x: 8, y: 6)
                }
            }
            // The badge straddles the corner instead of consuming text width.
            // Reserve its outside footprint so multiline bubbles and the next
            // message remain aligned and never overlap it.
            .padding(.trailing, showsAccountAvatar ? 8 : 0)
            .padding(.bottom, showsAccountAvatar ? 6 : 0)
            .frame(maxWidth: isUser ? 318 : .infinity, alignment: isUser ? .trailing : .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(messageAccessibilityLabel)
    }

    private var showsAccountAvatar: Bool {
        isUser && accountStatus != nil
    }

    private var messageAccessibilityLabel: String {
        guard showsAccountAvatar, let account = accountStatus else {
            return message.text
        }
        return "You, from \(account.email): \(message.text)"
    }

    private var bubbleBackground: AnyShapeStyle {
        if isUser { return AnyShapeStyle(WinnowDesign.indigo) }
        if isResult { return AnyShapeStyle(WinnowDesign.mint.opacity(0.13)) }
        return AnyShapeStyle(Color(uiColor: .secondarySystemBackground))
    }
}

private struct AssistantEvidenceCard: View {
    let evidence: AssistantEvidence

    var body: some View {
        Group {
            if let url = evidence.gmailURL {
                Link(destination: url) { content }
            } else {
                content
            }
        }
        .buttonStyle(.plain)
    }

    private var content: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: "envelope.fill")
                .foregroundStyle(WinnowDesign.accent)
                .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(evidence.subject).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text(evidence.from).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if !evidence.snippet.isEmpty {
                    Text(evidence.snippet).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: 6) {
                    Text(evidence.account).lineLimit(1)
                    if let date = evidence.date, !date.isEmpty {
                        Text("•")
                        Text(date).lineLimit(1)
                    }
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 4)
            if evidence.gmailURL != nil {
                Image(systemName: "arrow.up.right.square").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.06)))
    }
}

private struct AssistantDraftCard: View {
    let draft: AssistantDraft
    let isWorking: Bool
    let allowsSend: Bool
    let send: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label(draft.kind.capitalized + " draft", systemImage: "square.and.pencil")
                    .font(.subheadline.weight(.bold))
                Spacer()
                CapsuleLabel("Not sent", symbol: "lock.fill", color: WinnowDesign.amber)
            }
            if !draft.to.isEmpty { draftRow("To", draft.to.joined(separator: ", ")) }
            if !draft.cc.isEmpty { draftRow("Cc", draft.cc.joined(separator: ", ")) }
            if !draft.bcc.isEmpty { draftRow("Bcc", draft.bcc.joined(separator: ", ")) }
            if !draft.subject.isEmpty { draftRow("Subject", draft.subject) }
            Divider()
            Text(draft.body).font(.subheadline).textSelection(.enabled)
            HStack {
                Button {
                    UIPasteboard.general.string = draft.body
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                Spacer()
                if allowsSend {
                    Button(action: send) {
                        if isWorking {
                            ProgressView()
                        } else {
                            Label("Send", systemImage: "paperplane.fill")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(WinnowDesign.indigo)
                    .disabled(isWorking)
                }
            }
            .font(.caption.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .winnowCard(padding: 14)
    }

    private func draftRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label).foregroundStyle(.secondary).frame(width: 50, alignment: .leading)
            Text(value).textSelection(.enabled)
        }
        .font(.caption)
    }
}

private struct AssistantProposalCard: View {
    let proposal: AssistantProposal
    let isWorking: Bool
    let review: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack {
                Label("Action requires approval", systemImage: "checkmark.shield.fill")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(WinnowDesign.amber)
                Spacer()
                CapsuleLabel(proposal.risk.capitalized, color: WinnowDesign.amber)
            }
            Text(proposal.summary).font(.subheadline)
            Text(proposal.tool).font(.caption2.monospaced()).foregroundStyle(.secondary)

            if proposal.isPending {
                HStack {
                    Button("Review & Confirm", action: review)
                        .buttonStyle(.borderedProminent)
                        .tint(WinnowDesign.accent)
                    Button("Cancel", role: .cancel, action: cancel)
                        .buttonStyle(.bordered)
                }
                .font(.caption.weight(.semibold))
                .disabled(isWorking)
                .overlay(alignment: .trailing) { if isWorking { ProgressView().controlSize(.small) } }
            } else {
                CapsuleLabel(
                    proposal.status.capitalized,
                    symbol: ["completed", "confirmed", "executed", "succeeded"].contains(proposal.status) ? "checkmark" : "xmark",
                    color: ["completed", "confirmed", "executed", "succeeded"].contains(proposal.status) ? WinnowDesign.mint : WinnowDesign.rose
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .winnowCard(padding: 14)
    }
}

private struct ProposalConfirmationView: View {
    @Environment(\.dismiss) private var dismiss
    let proposal: AssistantProposal
    let scopeTitle: String
    let isWorking: Bool
    let confirm: () -> Void
    let cancel: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Label(
                        isOutbound ? "Review before sending" : "Confirm this exact action",
                        systemImage: isOutbound ? "paperplane.fill" : "checkmark.shield.fill"
                    )
                        .font(.title2.bold())
                        .foregroundStyle(WinnowDesign.accent)
                    Text(isOutbound
                         ? "Verify the recipients and final draft. Nothing is sent until you tap Send Email below."
                         : "Nothing is approved until you tap Confirm below.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 12) {
                        confirmationRow("Scope", scopeTitle)
                        confirmationRow("Action", proposal.summary)
                        if isOutbound, let draft = proposal.arguments["draft"]?.objectValue {
                            confirmationRow("From", proposal.arguments["account"]?.displayString ?? "")
                            if let to = draft["to"] { confirmationRow("To", to.displayString) }
                            if let cc = draft["cc"], !cc.displayString.isEmpty { confirmationRow("Cc", cc.displayString) }
                            if let bcc = draft["bcc"], !bcc.displayString.isEmpty { confirmationRow("Bcc", bcc.displayString) }
                            if let subject = draft["subject"], !subject.displayString.isEmpty {
                                confirmationRow("Subject", subject.displayString)
                            }
                            confirmationRow("Message", draft["body"]?.displayString ?? draft["note"]?.displayString ?? "")
                            if proposal.tool == "mail.send_forward" {
                                confirmationRow(
                                    "Attachments",
                                    draft["skipAttachments"]?.boolValue == true ? "Excluded" : "Included"
                                )
                            }
                        } else {
                            confirmationRow("Tool", proposal.tool)
                            confirmationRow("Risk", proposal.risk.capitalized)
                            ForEach(proposal.arguments.keys.sorted(), id: \.self) { key in
                                confirmationRow(key.humanizedAssistantKey, proposal.arguments[key]?.displayString ?? "")
                            }
                        }
                    }
                    .winnowCard()

                    if isOutbound {
                        Label("This sends email as you. Verify every recipient and the final draft before confirming.", systemImage: "paperplane.fill")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(WinnowDesign.rose)
                    } else if proposal.risk == "persistent" {
                        Label("This changes how future messages are handled.", systemImage: "arrow.triangle.2.circlepath")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(WinnowDesign.amber)
                    }

                    Button(action: confirm) {
                        HStack {
                            if isWorking { ProgressView().tint(.white) }
                            Text(isWorking ? (isOutbound ? "Sending…" : "Confirming…") : (isOutbound ? "Send Email" : "Confirm Action"))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(WinnowDesign.accent)
                    .disabled(isWorking || proposal.confirmationDigest.isEmpty)

                    Button("Cancel proposal", role: .cancel, action: cancel)
                        .frame(maxWidth: .infinity)
                        .disabled(isWorking)
                }
                .padding(18)
            }
            .background(AppBackdrop())
            .navigationTitle(isOutbound ? "Review Email" : "Review Action")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close") { dismiss() }.disabled(isWorking)
                }
            }
        }
        .interactiveDismissDisabled(isWorking)
    }

    private var isOutbound: Bool {
        proposal.tool.contains("send") || proposal.risk == "outbound"
    }

    private func confirmationRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
            Text(value).font(.subheadline).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
    var humanizedAssistantKey: String {
        replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression)
            .capitalized
    }
}
