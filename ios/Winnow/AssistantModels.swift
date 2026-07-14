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

    init(conversation: AssistantConversation, messages: [AssistantMessage]) {
        self.conversation = conversation
        self.messages = messages
    }
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

    init(
        id: String,
        scope: AssistantScope,
        account: String? = nil,
        emailItemId: String? = nil,
        createdAt: String? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.scope = scope
        self.account = account
        self.emailItemId = emailItemId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
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
    let runId: String?
    let role: String
    let text: String
    let kind: String?
    let createdAt: String?
    let evidence: [AssistantEvidence]
    let draft: AssistantDraft?
    let proposal: AssistantProposal?

    private enum CodingKeys: String, CodingKey {
        case id, conversationId, runId, role, text, kind, createdAt, evidence, draft, proposal
    }

    init(
        id: String,
        conversationId: String? = nil,
        runId: String? = nil,
        role: String,
        text: String,
        kind: String? = nil,
        createdAt: String? = nil,
        evidence: [AssistantEvidence] = [],
        draft: AssistantDraft? = nil,
        proposal: AssistantProposal? = nil
    ) {
        self.id = id
        self.conversationId = conversationId
        self.runId = runId
        self.role = role
        self.text = text
        self.kind = kind
        self.createdAt = createdAt
        self.evidence = evidence
        self.draft = draft
        self.proposal = proposal
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        conversationId = try values.decodeIfPresent(String.self, forKey: .conversationId)
        runId = try values.decodeIfPresent(String.self, forKey: .runId)
        role = try values.decodeIfPresent(String.self, forKey: .role) ?? "assistant"
        text = try values.decodeIfPresent(String.self, forKey: .text) ?? ""
        kind = try values.decodeIfPresent(String.self, forKey: .kind)
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt)
        evidence = try values.decodeIfPresent([AssistantEvidence].self, forKey: .evidence) ?? []
        draft = try values.decodeIfPresent(AssistantDraft.self, forKey: .draft)
        proposal = try values.decodeIfPresent(AssistantProposal.self, forKey: .proposal)
    }
}

enum AssistantMarkdown {
    static func render(_ source: String) -> AttributedString {
        guard var rendered = try? AttributedString(
            markdown: source,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else {
            return AttributedString(source)
        }

        // Assistant text can be influenced by untrusted email content. Preserve
        // Markdown styling without making model-generated URLs tappable.
        let linkRanges = rendered.runs.compactMap { run in
            run.link == nil ? nil : run.range
        }
        for range in linkRanges {
            rendered[range].link = nil
        }
        return rendered
    }
}

extension AssistantMessage {
    var formattedText: AttributedString {
        role == "user" ? AttributedString(text) : AssistantMarkdown.render(text)
    }
}

struct AssistantStreamAccepted: Decodable, Equatable {
    let runId: String?
    let userMessageId: String?
}

struct AssistantStreamProgress: Decodable, Equatable {
    let stage: String
    let label: String
}

struct AssistantStreamFailure: Decodable, Equatable {
    let error: String
    let message: String
    let retryable: Bool?
}

enum AssistantStreamEvent {
    case accepted(AssistantStreamAccepted)
    case progress(AssistantStreamProgress)
    case complete(AssistantConversationEnvelope)
}

struct AssistantServerSentEvent: Equatable {
    let name: String
    let data: Data
}

enum AssistantServerSentEventParserError: LocalizedError {
    case eventTooLarge

    var errorDescription: String? {
        "Winnow’s response exceeded the safe streaming limit."
    }
}

/// Incrementally parses SSE fields without assuming anything about network chunk boundaries.
struct AssistantServerSentEventParser {
    static let maximumEventBytes = 16 * 1_024 * 1_024
    private var lineBuffer: [UInt8] = []
    private var eventName = ""
    private var dataLines: [[UInt8]] = []
    private var dataByteCount = 0

    mutating func append(_ chunk: Data) throws -> [AssistantServerSentEvent] {
        var events: [AssistantServerSentEvent] = []
        for byte in chunk {
            events.append(contentsOf: try append(byte: byte))
        }
        return events
    }

    mutating func append(byte: UInt8) throws -> [AssistantServerSentEvent] {
        var events: [AssistantServerSentEvent] = []
        if byte == 0x0A {
            try processLine(&events)
        } else {
            lineBuffer.append(byte)
            if lineBuffer.count > Self.maximumEventBytes {
                throw AssistantServerSentEventParserError.eventTooLarge
            }
        }
        return events
    }

    mutating func finish() throws -> [AssistantServerSentEvent] {
        var events: [AssistantServerSentEvent] = []
        if !lineBuffer.isEmpty { try processLine(&events) }
        dispatchEvent(into: &events)
        return events
    }

    private mutating func processLine(_ events: inout [AssistantServerSentEvent]) throws {
        if lineBuffer.last == 0x0D { lineBuffer.removeLast() }
        let line = lineBuffer
        lineBuffer.removeAll(keepingCapacity: true)

        guard !line.isEmpty else {
            dispatchEvent(into: &events)
            return
        }
        guard line.first != 0x3A else { return } // SSE comment / heartbeat.

        let colon = line.firstIndex(of: 0x3A)
        let fieldBytes = colon.map { Array(line[..<$0]) } ?? line
        var valueBytes = colon.map { Array(line[line.index(after: $0)...]) } ?? []
        if valueBytes.first == 0x20 { valueBytes.removeFirst() }

        switch String(decoding: fieldBytes, as: UTF8.self) {
        case "event":
            eventName = String(decoding: valueBytes, as: UTF8.self)
        case "data":
            dataLines.append(valueBytes)
            dataByteCount += valueBytes.count + (dataLines.count > 1 ? 1 : 0)
            if dataByteCount > Self.maximumEventBytes {
                throw AssistantServerSentEventParserError.eventTooLarge
            }
        default:
            break
        }
    }

    private mutating func dispatchEvent(into events: inout [AssistantServerSentEvent]) {
        guard !dataLines.isEmpty || !eventName.isEmpty else { return }
        var data = Data()
        for (index, line) in dataLines.enumerated() {
            if index > 0 { data.append(0x0A) }
            data.append(contentsOf: line)
        }
        events.append(AssistantServerSentEvent(name: eventName.isEmpty ? "message" : eventName, data: data))
        eventName = ""
        dataLines.removeAll(keepingCapacity: true)
        dataByteCount = 0
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

    var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    var boolValue: Bool? {
        guard case let .bool(value) = self else { return nil }
        return value
    }

    var objectValue: [String: AssistantValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }
}

extension AssistantProposal {
    var isDeviceAction: Bool { tool.hasPrefix("device.") }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
