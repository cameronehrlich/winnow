import SwiftUI
import UIKit

struct AssistantMailboxView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedAccount = ""

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
                ToolbarItem(placement: .topBarLeading) { WinnowMark(size: 32) }
                ToolbarItem(placement: .topBarTrailing) {
                    if model.accounts.count > 1 {
                        Menu {
                            Button("All Winnow Accounts") { selectedAccount = "" }
                            Divider()
                            ForEach(model.accounts) { account in
                                Button(account.email) { selectedAccount = account.email }
                            }
                        } label: {
                            Label(
                                selectedAccount.isEmpty ? "All Accounts" : selectedAccount,
                                systemImage: selectedAccount.isEmpty ? "person.2" : "person.crop.circle"
                            )
                        }
                        .accessibilityLabel("Assistant account scope")
                    }
                }
            }
        }
    }
}

struct AssistantConversationView: View {
    @StateObject private var viewModel: AssistantViewModel
    @State private var composerText = ""
    @State private var reviewedProposal: AssistantProposal?
    @FocusState private var composerFocused: Bool

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
        _viewModel = StateObject(wrappedValue: AssistantViewModel(
            configuration: configuration,
            scope: scope,
            account: account,
            emailItemID: emailItemID
        ))
        self.contextTitle = contextTitle
        self.onMailboxChanged = onMailboxChanged
    }

    var body: some View {
        ZStack {
            AppBackdrop()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 14) {
                        scopeBanner

                        if viewModel.isLoading && viewModel.messages.isEmpty {
                            loadingState
                        } else if viewModel.messages.isEmpty {
                            emptyState
                        } else {
                            ForEach(viewModel.messages) { message in
                                AssistantMessageView(
                                    message: message,
                                    isProposalWorking: viewModel.activeProposalID == message.proposal?.id,
                                    reviewProposal: { reviewedProposal = $0 },
                                    cancelProposal: cancel,
                                    reviseDraft: prepareDraftRevision
                                )
                                .id(message.id)
                            }
                        }

                        if viewModel.isSending {
                            HStack(spacing: 9) {
                                ProgressView().controlSize(.small)
                                Text("Winnow is working…")
                            }
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                            .id("assistant-working")
                        }

                        if let error = viewModel.errorMessage {
                            errorCard(error)
                        }
                    }
                    .padding(16)
                    .padding(.bottom, 8)
                }
                .onChange(of: viewModel.messages.count) { _, _ in
                    withAnimation { proxy.scrollTo(viewModel.messages.last?.id, anchor: .bottom) }
                }
                .onChange(of: viewModel.isSending) { _, sending in
                    if sending { withAnimation { proxy.scrollTo("assistant-working", anchor: .bottom) } }
                }
            }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .task { await viewModel.startIfNeeded() }
        .sheet(item: $reviewedProposal) { proposal in
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

    private var scopeBanner: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: viewModel.scope == .email ? "envelope" : "tray.2")
                .foregroundStyle(WinnowDesign.brightIndigo)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(viewModel.scope == .email ? "ASKING ABOUT THIS EMAIL" : "SEARCHING")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
                Text(scopeDescription)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                if let contextTitle, !contextTitle.isEmpty {
                    Text(contextTitle).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer()
            Image(systemName: "lock.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Private")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .winnowCard(padding: 14)
    }

    private var scopeDescription: String {
        if viewModel.scope == .email {
            return viewModel.account ?? "This email's account"
        }
        return viewModel.account ?? "All Winnow Accounts"
    }

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Starting a private conversation…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 50)
    }

    private var emptyState: some View {
        VStack(spacing: 18) {
            VStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(WinnowDesign.brightIndigo)
                Text(viewModel.scope == .email ? "Ask about this message" : "Ask across your mailbox")
                    .font(.title3.bold())
                Text(viewModel.scope == .email
                     ? "Get answers, draft a reply, archive future messages, or safely unsubscribe."
                     : "Find an order, receipt, EIN, or anything else in your connected accounts.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: 8) {
                ForEach(suggestions, id: \.self) { suggestion in
                    Button {
                        composerText = suggestion
                        composerFocused = true
                    } label: {
                        HStack {
                            Text(suggestion).multilineTextAlignment(.leading)
                            Spacer()
                            Image(systemName: "arrow.up.right")
                        }
                        .font(.subheadline.weight(.medium))
                        .padding(12)
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(WinnowDesign.indigo)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .winnowCard()
    }

    private var suggestions: [String] {
        if viewModel.scope == .email {
            return ["What do I need to know?", "Draft a reply", "Unsubscribe me from this sender"]
        }
        return ["Find my most recent order", "Where can I find my EIN?", "Show receipts from this month"]
    }

    private var composer: some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Ask Winnow…", text: $composerText, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($composerFocused)
                    .submitLabel(.send)
                    .onSubmit(send)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.headline.bold())
                        .foregroundStyle(.white)
                        .frame(width: 42, height: 42)
                        .background(WinnowDesign.heroGradient, in: Circle())
                }
                .disabled(composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.isWorking)
                .opacity(viewModel.isWorking ? 0.55 : 1)
                .accessibilityLabel("Send message")
            }
            Text("Email content is untrusted. Winnow always asks before sending or making persistent changes.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 7)
        .background(.ultraThinMaterial)
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
                Button("Dismiss") { viewModel.errorMessage = nil }
            }
            .font(.caption.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .winnowCard(padding: 14)
    }

    private func send() {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !viewModel.isWorking else { return }
        composerText = ""
        composerFocused = false
        Task {
            let succeeded = await viewModel.send(text)
            if succeeded { await onMailboxChanged() }
            else if viewModel.messages.last?.role != "user" { composerText = text }
        }
    }

    private func confirm(_ proposal: AssistantProposal) {
        Task {
            let succeeded = await viewModel.confirm(proposal)
            if succeeded {
                reviewedProposal = nil
                await onMailboxChanged()
            }
        }
    }

    private func cancel(_ proposal: AssistantProposal) {
        Task {
            let succeeded = await viewModel.cancel(proposal)
            if succeeded { reviewedProposal = nil }
        }
    }

    private func prepareDraftRevision(_ draft: AssistantDraft) {
        composerText = "Revise the \(draft.kind) draft. Change it so that: "
        composerFocused = true
    }
}

private struct AssistantMessageView: View {
    let message: AssistantMessage
    let isProposalWorking: Bool
    let reviewProposal: (AssistantProposal) -> Void
    let cancelProposal: (AssistantProposal) -> Void
    let reviseDraft: (AssistantDraft) -> Void

    private var isUser: Bool { message.role == "user" }
    private var isResult: Bool { message.kind == "result" || message.role == "tool" }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 10) {
            if !message.text.isEmpty {
                Text(message.text)
                    .font(.body)
                    .foregroundStyle(isUser ? Color.white : Color.primary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(bubbleBackground, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .frame(maxWidth: isUser ? 310 : .infinity, alignment: isUser ? .trailing : .leading)
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

            if let draft = message.draft {
                AssistantDraftCard(draft: draft, revise: { reviseDraft(draft) })
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
                .foregroundStyle(WinnowDesign.indigo)
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
    let revise: () -> Void

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
            if !draft.subject.isEmpty { draftRow("Subject", draft.subject) }
            Divider()
            Text(draft.body).font(.subheadline).textSelection(.enabled)
            HStack {
                Button("Revise with Winnow", action: revise)
                Spacer()
                Button {
                    UIPasteboard.general.string = draft.body
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.bordered)
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
                        .tint(WinnowDesign.indigo)
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
                    Label("Confirm this exact action", systemImage: "checkmark.shield.fill")
                        .font(.title2.bold())
                        .foregroundStyle(WinnowDesign.indigo)
                    Text("Nothing is approved until you tap Confirm below.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 12) {
                        confirmationRow("Scope", scopeTitle)
                        confirmationRow("Action", proposal.summary)
                        confirmationRow("Tool", proposal.tool)
                        confirmationRow("Risk", proposal.risk.capitalized)
                        ForEach(proposal.arguments.keys.sorted(), id: \.self) { key in
                            confirmationRow(key.humanizedAssistantKey, proposal.arguments[key]?.displayString ?? "")
                        }
                    }
                    .winnowCard()

                    if proposal.tool.contains("send") || proposal.risk == "outbound" {
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
                            Text(isWorking ? "Confirming…" : "Confirm action")
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(WinnowDesign.indigo)
                    .disabled(isWorking || proposal.confirmationDigest.isEmpty)

                    Button("Cancel proposal", role: .cancel, action: cancel)
                        .frame(maxWidth: .infinity)
                        .disabled(isWorking)
                }
                .padding(18)
            }
            .background(AppBackdrop())
            .navigationTitle("Review Action")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close") { dismiss() }.disabled(isWorking)
                }
            }
        }
        .interactiveDismissDisabled(isWorking)
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
