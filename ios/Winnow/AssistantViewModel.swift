import Foundation

@MainActor
final class AssistantViewModel: ObservableObject {
    @Published private(set) var conversation: AssistantConversation?
    @Published private(set) var messages: [AssistantMessage] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published private(set) var progress: AssistantStreamProgress?
    @Published private(set) var hasIndeterminateMessageAttempt = false
    @Published private(set) var canonicalResponseRevision = 0
    @Published private(set) var activeProposalID: String?
    @Published var errorMessage: String?

    let scope: AssistantScope
    let account: String?
    let emailItemID: String?

    private let service: any AssistantService
    private var generation = 0
    private var failedMessageAttempt: FailedMessageAttempt?

    private struct FailedMessageAttempt {
        let text: String
        let idempotencyKey: String
        let optimisticMessageID: String
        let accepted: AssistantStreamAccepted?
    }

    init(
        configuration: ServerConfiguration,
        scope: AssistantScope,
        account: String? = nil,
        emailItemID: String? = nil,
        service: (any AssistantService)? = nil
    ) {
        self.service = service ?? APIClient(configuration: configuration)
        self.scope = scope
        self.account = account?.isEmpty == true ? nil : account
        self.emailItemID = emailItemID
    }

    var isWorking: Bool { isLoading || isSending || activeProposalID != nil || hasIndeterminateMessageAttempt }

    func startIfNeeded() async {
        guard conversation == nil, !isLoading else { return }
        await createConversation()
    }

    func newConversation() async {
        generation &+= 1
        conversation = nil
        messages = []
        isLoading = false
        isSending = false
        activeProposalID = nil
        errorMessage = nil
        progress = nil
        hasIndeterminateMessageAttempt = false
        canonicalResponseRevision = 0
        failedMessageAttempt = nil
        await createConversation()
    }

    @discardableResult
    func send(_ rawText: String) async -> Bool {
        await send(rawText, permitsIndeterminateRetry: false)
    }

    private func send(_ rawText: String, permitsIndeterminateRetry: Bool) async -> Bool {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isLoading, !isSending, activeProposalID == nil else { return false }
        if hasIndeterminateMessageAttempt {
            guard permitsIndeterminateRetry, failedMessageAttempt?.text == text else { return false }
        }
        if conversation == nil { await createConversation() }
        guard let conversation else { return false }

        let previousAttempt = failedMessageAttempt?.text == text ? failedMessageAttempt : nil
        let idempotencyKey = previousAttempt?.idempotencyKey ?? UUID().uuidString
        var optimisticMessageID = previousAttempt?.optimisticMessageID ?? "optimistic-user-\(idempotencyKey)"
        let canonicalMessages = messages.filter { $0.id != optimisticMessageID }
        if !messages.contains(where: { $0.id == optimisticMessageID }) {
            messages.append(AssistantMessage(
                id: optimisticMessageID,
                conversationId: conversation.id,
                role: "user",
                text: text
            ))
        }

        isSending = true
        progress = nil
        hasIndeterminateMessageAttempt = false
        errorMessage = nil
        let currentGeneration = generation
        var accepted = previousAttempt?.accepted
        defer {
            if currentGeneration == generation {
                isSending = false
                progress = nil
            }
        }

        do {
            let stream = service.sendAssistantMessageStream(
                conversationID: conversation.id,
                text: text,
                idempotencyKey: idempotencyKey
            )
            for try await event in stream {
                guard currentGeneration == generation else { return false }
                switch event {
                case let .accepted(details):
                    accepted = details
                    if let userMessageID = details.userMessageId?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !userMessageID.isEmpty,
                       userMessageID != optimisticMessageID {
                        reconcileOptimisticMessage(from: optimisticMessageID, to: userMessageID)
                        optimisticMessageID = userMessageID
                    }
                case let .progress(update):
                    if progress != update { progress = update }
                case let .complete(envelope):
                    failedMessageAttempt = nil
                    hasIndeterminateMessageAttempt = false
                    apply(envelope, animatesResponse: true)
                    return true
                }
            }
            throw APIClientError.assistantStream(
                message: accepted == nil
                    ? "Winnow’s response ended before it completed. Please try again."
                    : "Winnow accepted this message, but the response connection ended early. Retry safely to retrieve the result.",
                retryable: true
            )
        } catch {
            guard currentGeneration == generation else { return false }
            if let accepted {
                let recovered = try? await service.assistantConversation(id: conversation.id)
                guard currentGeneration == generation else { return false }
                if let recovered,
                   hasNewAssistantResponse(recovered, after: accepted, excluding: canonicalMessages) {
                    failedMessageAttempt = nil
                    hasIndeterminateMessageAttempt = false
                    apply(recovered, animatesResponse: true)
                    return true
                }
            }

            let attempt = FailedMessageAttempt(
                text: text,
                idempotencyKey: idempotencyKey,
                optimisticMessageID: optimisticMessageID,
                accepted: accepted
            )
            failedMessageAttempt = attempt
            hasIndeterminateMessageAttempt = accepted != nil
            if accepted == nil { messages = canonicalMessages }
            errorMessage = error.localizedDescription
            return false
        }
    }

    var shouldRestoreFailedComposerText: Bool {
        failedMessageAttempt != nil && !hasIndeterminateMessageAttempt
    }

    @discardableResult
    func retryIndeterminateMessage() async -> Bool {
        guard
            let attempt = failedMessageAttempt,
            attempt.accepted != nil,
            !isLoading,
            !isSending,
            activeProposalID == nil
        else { return false }
        return await send(attempt.text, permitsIndeterminateRetry: true)
    }

    @discardableResult
    func confirm(_ proposal: AssistantProposal) async -> Bool {
        guard proposal.isPending, activeProposalID == nil else { return false }
        activeProposalID = proposal.id
        errorMessage = nil
        let currentGeneration = generation
        defer { if currentGeneration == generation { activeProposalID = nil } }

        do {
            let envelope = try await service.confirmAssistantProposal(
                id: proposal.id,
                confirmationDigest: proposal.confirmationDigest
            )
            guard currentGeneration == generation else { return false }
            apply(envelope)
            return true
        } catch {
            guard currentGeneration == generation else { return false }
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func cancel(_ proposal: AssistantProposal) async -> Bool {
        guard proposal.isPending, activeProposalID == nil else { return false }
        activeProposalID = proposal.id
        errorMessage = nil
        let currentGeneration = generation
        defer { if currentGeneration == generation { activeProposalID = nil } }

        do {
            let envelope = try await service.cancelAssistantProposal(id: proposal.id)
            guard currentGeneration == generation else { return false }
            apply(envelope)
            return true
        } catch {
            guard currentGeneration == generation else { return false }
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func createConversation() async {
        isLoading = true
        errorMessage = nil
        let currentGeneration = generation
        defer { if currentGeneration == generation { isLoading = false } }

        do {
            let envelope = try await service.createAssistantConversation(
                scope: scope,
                account: account,
                emailItemID: emailItemID
            )
            guard currentGeneration == generation else { return }
            apply(envelope)
        } catch {
            guard currentGeneration == generation else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func apply(_ envelope: AssistantConversationEnvelope, animatesResponse: Bool = false) {
        conversation = envelope.conversation
        messages = envelope.messages
        if animatesResponse { canonicalResponseRevision &+= 1 }
    }

    private func reconcileOptimisticMessage(from oldID: String, to serverID: String) {
        guard let index = messages.firstIndex(where: { $0.id == oldID }) else { return }
        let optimistic = messages[index]
        messages[index] = AssistantMessage(
            id: serverID,
            conversationId: optimistic.conversationId,
            runId: optimistic.runId,
            role: optimistic.role,
            text: optimistic.text,
            kind: optimistic.kind,
            createdAt: optimistic.createdAt,
            evidence: optimistic.evidence,
            draft: optimistic.draft,
            proposal: optimistic.proposal
        )
    }

    private func hasNewAssistantResponse(
        _ envelope: AssistantConversationEnvelope,
        after accepted: AssistantStreamAccepted,
        excluding previousMessages: [AssistantMessage]
    ) -> Bool {
        guard
            let acceptedRunID = accepted.runId?.trimmingCharacters(in: .whitespacesAndNewlines),
            !acceptedRunID.isEmpty
        else {
            // Without run attribution, another concurrent run could have produced
            // the new response. Keep the attempt indeterminate and retry by key.
            return false
        }
        if let userMessageID = accepted.userMessageId,
           let userIndex = envelope.messages.firstIndex(where: { $0.id == userMessageID }) {
            return envelope.messages.dropFirst(userIndex + 1).contains {
                $0.role != "user" && $0.runId == acceptedRunID
            }
        }
        let previousIDs = Set(previousMessages.map(\.id))
        return envelope.messages.contains {
            $0.role != "user" && $0.runId == acceptedRunID && !previousIDs.contains($0.id)
        }
    }
}
