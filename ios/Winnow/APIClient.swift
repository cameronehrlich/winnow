import Foundation

struct ServerConfiguration: Equatable {
    var serverURL: String
    var token: String
    var isDebugOverride: Bool = false

    var normalizedBaseURL: URL? {
        var raw = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while raw.hasSuffix("/") { raw.removeLast() }
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              url.host != nil else { return nil }
        return url
    }

    var isComplete: Bool {
        normalizedBaseURL != nil && !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

enum APIClientError: LocalizedError {
    case invalidServerURL
    case invalidRequest(String)
    case unauthorized
    case server(status: Int, message: String)
    case invalidResponse
    case transport(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            "Enter a complete server URL, including http:// or https://."
        case let .invalidRequest(message):
            message
        case .unauthorized:
            "The server rejected this token. Check the bearer token and try again."
        case let .server(status, message):
            "Server error \(status): \(message)"
        case .invalidResponse:
            "Winnow returned an unexpected response."
        case let .transport(message):
            "Couldn’t reach Winnow. \(message)"
        case let .decoding(message):
            "Winnow’s response couldn’t be read. \(message)"
        }
    }
}

private struct APIErrorEnvelope: Decodable {
    let error: String?
    let message: String?
}

private struct MailRulePreviewRequest: Encodable {
    let candidate: MailRuleDraft
    let limit: Int
}

struct APIClient {
    let configuration: ServerConfiguration
    var session: URLSession = .shared

    func status() async throws -> RuntimeStatus {
        try await request(path: "/v1/status")
    }

    func accounts() async throws -> [AccountStatus] {
        let response: AccountListResponse = try await request(path: "/v1/accounts")
        return response.accounts
    }

    func emails(state: String = "all", account: String = "", limit: Int = 100) async throws -> EmailListResponse {
        var query = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "limit", value: String(limit))]
        if !account.isEmpty { query.append(URLQueryItem(name: "account", value: account)) }
        return try await request(path: "/v1/emails", queryItems: query)
    }

    func dailySummary(account: String = "") async throws -> DailySummary {
        let query = account.isEmpty ? [] : [URLQueryItem(name: "account", value: account)]
        return try await request(path: "/v1/summaries/daily", queryItems: query)
    }

    func lifetimeSummary(account: String = "", recentLimit: Int = 25) async throws -> LifetimeSummary {
        var query = [URLQueryItem(name: "recentLimit", value: String(recentLimit))]
        if !account.isEmpty { query.append(URLQueryItem(name: "account", value: account)) }
        return try await request(path: "/v1/summaries/lifetime", queryItems: query)
    }

    func mailRules(account: String = "") async throws -> [MailRule] {
        let query = account.isEmpty ? [] : [URLQueryItem(name: "account", value: account)]
        let response: MailRuleListResponse = try await request(path: "/v1/rules", queryItems: query)
        return response.rules
    }

    func previewMailRule(_ candidate: MailRuleDraft, limit: Int = 5) async throws -> MailRulePreviewResponse {
        try await request(
            path: "/v1/rules/preview",
            method: "POST",
            body: try JSONEncoder().encode(MailRulePreviewRequest(
                candidate: candidate,
                limit: min(max(limit, 1), 25)
            ))
        )
    }

    func createMailRule(_ candidate: MailRuleDraft) async throws -> MailRule {
        guard candidate.account?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
            throw APIClientError.invalidRequest("Choose a managed account before creating a rule.")
        }
        let response: MailRuleResponse = try await request(
            path: "/v1/rules",
            method: "POST",
            body: try JSONEncoder().encode(candidate)
        )
        return response.rule
    }

    func customizeBaselineRule(_ candidate: MailRuleDraft) async throws -> MailRule {
        guard let account = candidate.account?.trimmingCharacters(in: .whitespacesAndNewlines), !account.isEmpty else {
            throw APIClientError.invalidRequest("Choose a managed account before customizing this default.")
        }
        var payload: [String: Any] = [
            "account": account,
            "type": "semantic",
            "effect": candidate.effect,
        ]
        if let id = candidate.id { payload["id"] = id }
        if let baselineRuleId = candidate.baselineRuleId { payload["baselineRuleId"] = baselineRuleId }
        if let expectedConflict = candidate.expectedConflict {
            payload["expectedConflict"] = [
                "ruleId": expectedConflict.ruleId,
                "updatedAt": expectedConflict.updatedAt,
            ]
        }
        if let expectedRule = candidate.expectedRule {
            payload["expectedRule"] = [
                "ruleId": expectedRule.ruleId,
                "updatedAt": expectedRule.updatedAt,
            ]
        }
        if !candidate.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            payload["description"] = candidate.description
        }
        let response: MailRuleResponse = try await request(
            path: "/v1/rules",
            method: "POST",
            body: try JSONSerialization.data(withJSONObject: payload)
        )
        return response.rule
    }

    func updateMailRule(id: String, candidate: MailRuleDraft) async throws -> MailRule {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let response: MailRuleResponse = try await request(
            path: "/v1/rules/\(encodedID)",
            method: "PATCH",
            body: try JSONEncoder().encode(candidate)
        )
        return response.rule
    }

    func disableMailRule(id: String) async throws -> MailRuleActionResponse {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return try await request(path: "/v1/rules/\(encodedID)/disable", method: "POST")
    }

    func resetMailRule(id: String) async throws -> MailRuleActionResponse {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return try await request(path: "/v1/rules/\(encodedID)/reset", method: "POST")
    }

    func createAssistantConversation(
        scope: AssistantScope,
        account: String? = nil,
        emailItemID: String? = nil
    ) async throws -> AssistantConversationEnvelope {
        var payload: [String: Any] = ["scope": scope.rawValue]
        if let account, !account.isEmpty { payload["account"] = account }
        if let emailItemID, !emailItemID.isEmpty { payload["emailItemId"] = emailItemID }
        return try await request(
            path: "/v1/assistant/conversations",
            method: "POST",
            body: try JSONSerialization.data(withJSONObject: payload),
            timeoutInterval: 30
        )
    }

    func assistantConversation(id: String) async throws -> AssistantConversationEnvelope {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return try await request(path: "/v1/assistant/conversations/\(encodedID)")
    }

    func sendAssistantMessage(
        conversationID: String,
        text: String,
        idempotencyKey: String = UUID().uuidString
    ) async throws -> AssistantConversationEnvelope {
        let encodedID = conversationID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? conversationID
        let body = try JSONSerialization.data(withJSONObject: [
            "text": text,
            "idempotencyKey": idempotencyKey,
        ])
        return try await request(
            path: "/v1/assistant/conversations/\(encodedID)/messages",
            method: "POST",
            body: body,
            timeoutInterval: 90
        )
    }

    func confirmAssistantProposal(id: String, confirmationDigest: String) async throws -> AssistantConversationEnvelope {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let body = try JSONSerialization.data(withJSONObject: ["confirmationDigest": confirmationDigest])
        return try await request(
            path: "/v1/assistant/proposals/\(encodedID)/confirm",
            method: "POST",
            body: body,
            timeoutInterval: 60
        )
    }

    func cancelAssistantProposal(id: String) async throws -> AssistantConversationEnvelope {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        return try await request(
            path: "/v1/assistant/proposals/\(encodedID)/cancel",
            method: "POST",
            timeoutInterval: 30
        )
    }

    func perform(_ action: EmailAction, emailID: String) async throws -> ActionResponse {
        let encodedID = emailID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? emailID
        return try await request(path: "/v1/emails/\(encodedID)/\(action.rawValue)", method: "POST")
    }

    func undoHandling(emailID: String) async throws -> UndoHandlingResponse {
        let encodedID = emailID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? emailID
        return try await request(path: "/v1/emails/\(encodedID)/undo-handling", method: "POST")
    }

    func registerPushDevice(
        token: String,
        installationID: String,
        environment: String,
        bundleID: String,
        appVersion: String
    ) async throws -> PushDevice {
        let body = try JSONSerialization.data(withJSONObject: [
            "deviceToken": token,
            "platform": "ios",
            "installationId": installationID,
            "environment": environment,
            "bundleId": bundleID,
            "appVersion": appVersion,
        ])
        let response: PushDeviceResponse = try await request(
            path: "/v1/push/devices",
            method: "POST",
            body: body
        )
        return response.device
    }

    func unregisterPushDevice(id: String) async throws {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let _: PushDeviceDeleteResponse = try await request(
            path: "/v1/push/devices/\(encodedID)",
            method: "DELETE"
        )
    }

    private func request<Response: Decodable>(
        path: String,
        queryItems: [URLQueryItem] = [],
        method: String = "GET",
        body: Data? = nil,
        timeoutInterval: TimeInterval = 20
    ) async throws -> Response {
        guard let baseURL = configuration.normalizedBaseURL else { throw APIClientError.invalidServerURL }
        guard var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw APIClientError.invalidServerURL
        }
        if !queryItems.isEmpty { components.queryItems = queryItems }
        guard let url = components.url else { throw APIClientError.invalidServerURL }

        var request = URLRequest(url: url, timeoutInterval: timeoutInterval)
        request.httpMethod = method
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body ?? Data("{}".utf8)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIClientError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let envelope = try? JSONDecoder().decode(APIErrorEnvelope.self, from: data)
            let message = envelope?.message ?? envelope?.error ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            if http.statusCode == 401 { throw APIClientError.unauthorized }
            throw APIClientError.server(status: http.statusCode, message: message)
        }

        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw APIClientError.decoding(error.localizedDescription)
        }
    }
}
