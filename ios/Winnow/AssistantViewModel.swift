import Foundation

@MainActor
final class AssistantViewModel: ObservableObject {
    @Published private(set) var conversation: AssistantConversation?
    @Published private(set) var messages: [AssistantMessage] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published private(set) var activeProposalID: String?
    @Published var errorMessage: String?

    let scope: AssistantScope
    let account: String?
    let emailItemID: String?

    private let configuration: ServerConfiguration
    private var generation = 0
    private var failedMessageAttempt: (text: String, idempotencyKey: String)?

    init(
        configuration: ServerConfiguration,
        scope: AssistantScope,
        account: String? = nil,
        emailItemID: String? = nil
    ) {
        self.configuration = configuration
        self.scope = scope
        self.account = account?.isEmpty == true ? nil : account
        self.emailItemID = emailItemID
    }

    var isWorking: Bool { isLoading || isSending || activeProposalID != nil }

    func startIfNeeded() async {
        guard conversation == nil, !isLoading else { return }
        await createConversation()
    }

    func newConversation() async {
        generation &+= 1
        conversation = nil
        messages = []
        errorMessage = nil
        failedMessageAttempt = nil
        await createConversation()
    }

    @discardableResult
    func send(_ rawText: String) async -> Bool {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isWorking else { return false }
        if conversation == nil { await createConversation() }
        guard let conversation else { return false }

        isSending = true
        errorMessage = nil
        let currentGeneration = generation
        let idempotencyKey = failedMessageAttempt?.text == text
            ? failedMessageAttempt!.idempotencyKey
            : UUID().uuidString
        defer { if currentGeneration == generation { isSending = false } }

        do {
            let envelope = try await APIClient(configuration: configuration).sendAssistantMessage(
                conversationID: conversation.id,
                text: text,
                idempotencyKey: idempotencyKey
            )
            guard currentGeneration == generation else { return false }
            failedMessageAttempt = nil
            apply(envelope)
            return true
        } catch {
            guard currentGeneration == generation else { return false }
            failedMessageAttempt = (text, idempotencyKey)
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func confirm(_ proposal: AssistantProposal) async -> Bool {
        guard proposal.isPending, activeProposalID == nil else { return false }
        activeProposalID = proposal.id
        errorMessage = nil
        let currentGeneration = generation
        defer { if currentGeneration == generation { activeProposalID = nil } }

        do {
            let envelope = try await APIClient(configuration: configuration).confirmAssistantProposal(
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
            let envelope = try await APIClient(configuration: configuration).cancelAssistantProposal(id: proposal.id)
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
            let envelope = try await APIClient(configuration: configuration).createAssistantConversation(
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

    private func apply(_ envelope: AssistantConversationEnvelope) {
        conversation = envelope.conversation
        messages = envelope.messages
    }
}
