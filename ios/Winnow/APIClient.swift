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
    case unauthorized
    case server(status: Int, message: String)
    case invalidResponse
    case transport(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            "Enter a complete server URL, including http:// or https://."
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

    func perform(_ action: EmailAction, emailID: String) async throws -> ActionResponse {
        let encodedID = emailID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? emailID
        return try await request(path: "/v1/emails/\(encodedID)/\(action.rawValue)", method: "POST")
    }

    private func request<Response: Decodable>(
        path: String,
        queryItems: [URLQueryItem] = [],
        method: String = "GET"
    ) async throws -> Response {
        guard let baseURL = configuration.normalizedBaseURL else { throw APIClientError.invalidServerURL }
        guard var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw APIClientError.invalidServerURL
        }
        if !queryItems.isEmpty { components.queryItems = queryItems }
        guard let url = components.url else { throw APIClientError.invalidServerURL }

        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if method != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
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
