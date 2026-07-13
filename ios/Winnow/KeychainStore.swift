import Foundation
import Security

enum KeychainStore {
    private static let service = "com.cameronehrlich.Winnow"
    private static let account = "api-bearer-token"

    static func readToken() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else { return "" }
        return token
    }

    static func saveToken(_ token: String) throws {
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]

        if token.isEmpty {
            SecItemDelete(baseQuery as CFDictionary)
            return
        }

        let data = Data(token.utf8)
        let status = SecItemCopyMatching(baseQuery as CFDictionary, nil)
        let result: OSStatus
        if status == errSecSuccess {
            result = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        } else {
            var attributes = baseQuery
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            result = SecItemAdd(attributes as CFDictionary, nil)
        }

        guard result == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(result))
        }
    }
}

enum ConfigurationStore {
    private static let serverURLKey = "winnow.server-url"

    static func load() -> ServerConfiguration {
        var configuration = ServerConfiguration(
            serverURL: UserDefaults.standard.string(forKey: serverURLKey) ?? "",
            token: KeychainStore.readToken()
        )

        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        let debugURL = environment["WINNOW_SERVER_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let debugToken = environment["WINNOW_API_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !debugURL.isEmpty || !debugToken.isEmpty {
            if !debugURL.isEmpty { configuration.serverURL = debugURL }
            if !debugToken.isEmpty { configuration.token = debugToken }
            configuration.isDebugOverride = true

            // A signed development launch can seed the device once via
            // SIMCTL_CHILD_* / devicectl environment variables. Future normal
            // launches then use the same non-secret URL and Keychain token.
            if !debugURL.isEmpty { UserDefaults.standard.set(debugURL, forKey: serverURLKey) }
            if !debugToken.isEmpty { try? KeychainStore.saveToken(debugToken) }
        }
        #endif

        return configuration
    }

    static func save(_ configuration: ServerConfiguration) throws {
        UserDefaults.standard.set(configuration.serverURL, forKey: serverURLKey)
        try KeychainStore.saveToken(configuration.token)
    }

    static func clear() throws {
        UserDefaults.standard.removeObject(forKey: serverURLKey)
        try KeychainStore.saveToken("")
    }
}
