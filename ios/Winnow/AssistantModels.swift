import Foundation

enum AssistantScope: String, Codable {
    case mailbox
    case email

    var title: String {
        switch self {
        case .mailbox: "Mailbox"
        case .email: "This email"
        }
    }
}

struct AssistantConversationEnvelope: Decodable {
    let conversation: AssistantConversation
    let messages: [AssistantMessage]
}

struct AssistantConversation: Decodable, Identifiable {
    let id: String
    let scope: AssistantScope
    let account: String?
    let emailItemId: String?
    let createdAt: String?
    let updatedAt: String?

    private enum CodingKeys: String, CodingKey {
        case id, scope, account, emailItemId, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        scope = try values.decodeIfPresent(AssistantScope.self, forKey: .scope) ?? .mailbox
        account = try values.decodeIfPresent(String.self, forKey: .account)?.nilIfEmpty
        emailItemId = try values.decodeIfPresent(String.self, forKey: .emailItemId)?.nilIfEmpty
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try values.decodeIfPresent(String.self, forKey: .updatedAt)
    }
}

struct AssistantMessage: Decodable, Identifiable {
    let id: String
    let conversationId: String?
    let role: String
    let text: String
    let kind: String?
    let createdAt: String?
    let evidence: [AssistantEvidence]
    let draft: AssistantDraft?
    let proposal: AssistantProposal?

    private enum CodingKeys: String, CodingKey {
        case id, conversationId, role, text, kind, createdAt, evidence, draft, proposal
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        conversationId = try values.decodeIfPresent(String.self, forKey: .conversationId)
        role = try values.decodeIfPresent(String.self, forKey: .role) ?? "assistant"
        text = try values.decodeIfPresent(String.self, forKey: .text) ?? ""
        kind = try values.decodeIfPresent(String.self, forKey: .kind)
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt)
        evidence = try values.decodeIfPresent([AssistantEvidence].self, forKey: .evidence) ?? []
        draft = try values.decodeIfPresent(AssistantDraft.self, forKey: .draft)
        proposal = try values.decodeIfPresent(AssistantProposal.self, forKey: .proposal)
    }
}

struct AssistantEvidence: Decodable, Identifiable {
    let account: String
    let messageId: String
    let threadId: String
    let from: String
    let subject: String
    let date: String?
    let snippet: String

    var id: String { "\(account)|\(messageId)|\(threadId)" }

    var gmailURL: URL? {
        guard !threadId.isEmpty else { return nil }
        var components = URLComponents(string: "https://mail.google.com/mail/u/")
        if !account.isEmpty {
            components?.queryItems = [URLQueryItem(name: "authuser", value: account)]
        }
        components?.fragment = "all/\(threadId)"
        return components?.url
    }

    private enum CodingKeys: String, CodingKey {
        case account, messageId, threadId, from, subject, date, snippet
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        account = try values.decodeIfPresent(String.self, forKey: .account) ?? ""
        messageId = try values.decodeIfPresent(String.self, forKey: .messageId) ?? ""
        threadId = try values.decodeIfPresent(String.self, forKey: .threadId) ?? ""
        from = try values.decodeIfPresent(String.self, forKey: .from) ?? "Unknown sender"
        subject = try values.decodeIfPresent(String.self, forKey: .subject) ?? "(no subject)"
        date = try values.decodeIfPresent(String.self, forKey: .date)
        snippet = try values.decodeIfPresent(String.self, forKey: .snippet) ?? ""
    }
}

struct AssistantDraft: Decodable {
    let kind: String
    let to: [String]
    let cc: [String]
    let subject: String
    let body: String

    private enum CodingKeys: String, CodingKey { case kind, to, cc, subject, body }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decodeIfPresent(String.self, forKey: .kind) ?? "reply"
        to = try values.decodeIfPresent([String].self, forKey: .to) ?? []
        cc = try values.decodeIfPresent([String].self, forKey: .cc) ?? []
        subject = try values.decodeIfPresent(String.self, forKey: .subject) ?? ""
        body = try values.decodeIfPresent(String.self, forKey: .body) ?? ""
    }
}

struct AssistantProposal: Decodable, Identifiable {
    let id: String
    let tool: String
    let risk: String
    let summary: String
    let arguments: [String: AssistantValue]
    let confirmationDigest: String
    let expiresAt: String?
    let status: String

    var isPending: Bool { status == "pending" }

    private enum CodingKeys: String, CodingKey {
        case id, tool, toolName, risk, summary, arguments, confirmationDigest, expiresAt, status
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        tool = try values.decodeIfPresent(String.self, forKey: .tool)
            ?? values.decodeIfPresent(String.self, forKey: .toolName)
            ?? "assistant.action"
        risk = try values.decodeIfPresent(String.self, forKey: .risk) ?? "action"
        summary = try values.decodeIfPresent(String.self, forKey: .summary) ?? "Review this action"
        arguments = try values.decodeIfPresent([String: AssistantValue].self, forKey: .arguments) ?? [:]
        confirmationDigest = try values.decodeIfPresent(String.self, forKey: .confirmationDigest) ?? ""
        expiresAt = try values.decodeIfPresent(String.self, forKey: .expiresAt)
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? "pending"
    }
}

enum AssistantValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([AssistantValue])
    case object([String: AssistantValue])
    case null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let result = try? value.decode(String.self) { self = .string(result) }
        else if let result = try? value.decode(Bool.self) { self = .bool(result) }
        else if let result = try? value.decode(Double.self) { self = .number(result) }
        else if let result = try? value.decode([AssistantValue].self) { self = .array(result) }
        else if let result = try? value.decode([String: AssistantValue].self) { self = .object(result) }
        else { throw DecodingError.dataCorruptedError(in: value, debugDescription: "Unsupported assistant argument") }
    }

    var displayString: String {
        switch self {
        case let .string(value): value
        case let .number(value): value.formatted()
        case let .bool(value): value ? "Yes" : "No"
        case let .array(values): values.map(\.displayString).joined(separator: ", ")
        case let .object(values): values.sorted(by: { $0.key < $1.key }).map { "\($0.key): \($0.value.displayString)" }.joined(separator: "; ")
        case .null: "None"
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
