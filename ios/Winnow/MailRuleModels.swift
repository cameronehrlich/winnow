import Foundation

struct MailRuleListResponse: Decodable {
    let rules: [MailRule]

    private enum CodingKeys: String, CodingKey { case rules }

    init(from decoder: Decoder) throws {
        if let values = try? decoder.container(keyedBy: CodingKeys.self) {
            rules = try values.decodeIfPresent([MailRule].self, forKey: .rules) ?? []
        } else {
            rules = try decoder.singleValueContainer().decode([MailRule].self)
        }
    }
}

struct MailRule: Decodable, Identifiable, Equatable {
    let id: String
    let account: String?
    let type: String
    let effect: String
    let match: String?
    let matcherKind: String?
    let matcherValue: String?
    let description: String
    let enabled: Bool
    let scope: String
    let source: String
    let editable: Bool
    let baselineRuleId: String?
    let sourceEmailItemId: String?
    let createdAt: String?
    let updatedAt: String?

    var isBaseline: Bool { scope == "baseline" }
    var isBaselineCustomization: Bool { !isBaseline && baselineRuleId != nil }
    var isLockedAutomation: Bool { !editable && !isBaseline && !isBaselineCustomization }
    var belongsWithDefaults: Bool { isBaseline || isBaselineCustomization }
    var canCustomize: Bool { isBaseline && !isLockedAutomation }
    var canReset: Bool { isBaselineCustomization }
    var canToggle: Bool { editable && !isBaseline }

    var actionTitle: String { effect == "archive" ? "Archive" : "Keep" }
    var actionSymbol: String { effect == "archive" ? "archivebox" : "tray" }
    var accountTitle: String { account?.nilIfBlank ?? "All accounts" }
    var matcherTitle: String {
        if type == "semantic" { return match?.nilIfBlank ?? description.nilIfBlank ?? "Semantic match" }
        let kind = (matcherKind ?? "exact").replacingOccurrences(of: "_", with: " ").capitalized
        return "\(kind): \(matcherValue?.nilIfBlank ?? match?.nilIfBlank ?? "Not specified")"
    }

    private enum CodingKeys: String, CodingKey {
        case id, account, type, effect, match, matcherKind, matcherValue, description
        case enabled, scope, source, editable, baselineRuleId, sourceEmailItemId
        case createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        account = try values.decodeIfPresent(String.self, forKey: .account)?.nilIfBlank
        type = try values.decodeIfPresent(String.self, forKey: .type) ?? "exact"
        effect = try values.decodeIfPresent(String.self, forKey: .effect) ?? "keep"
        match = try values.decodeIfPresent(String.self, forKey: .match)?.nilIfBlank
        matcherKind = try values.decodeIfPresent(String.self, forKey: .matcherKind)?.nilIfBlank
        matcherValue = try values.decodeIfPresent(String.self, forKey: .matcherValue)?.nilIfBlank
        description = try values.decodeIfPresent(String.self, forKey: .description) ?? ""
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        scope = try values.decodeIfPresent(String.self, forKey: .scope) ?? "user"
        source = try values.decodeIfPresent(String.self, forKey: .source) ?? "api"
        editable = try values.decodeIfPresent(Bool.self, forKey: .editable) ?? false
        baselineRuleId = try values.decodeIfPresent(String.self, forKey: .baselineRuleId)?.nilIfBlank
        sourceEmailItemId = try values.decodeIfPresent(String.self, forKey: .sourceEmailItemId)?.nilIfBlank
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try values.decodeIfPresent(String.self, forKey: .updatedAt)
    }
}

struct MailRuleDraft: Encodable, Equatable {
    var account: String?
    var type: String
    var effect: String
    var match: String?
    var matcherKind: String?
    var matcherValue: String?
    var description: String
    var enabled: Bool
    var baselineRuleId: String?

    init(rule: MailRule) {
        account = rule.account
        type = rule.type
        effect = rule.effect
        match = rule.match
        matcherKind = rule.matcherKind
        matcherValue = rule.matcherValue
        description = rule.description
        enabled = rule.enabled
        baselineRuleId = rule.baselineRuleId ?? (rule.isBaseline ? rule.id : nil)
    }
}

struct MailRuleResponse: Decodable {
    let rule: MailRule

    private enum CodingKeys: String, CodingKey { case rule }

    init(from decoder: Decoder) throws {
        if let values = try? decoder.container(keyedBy: CodingKeys.self), values.contains(.rule) {
            rule = try values.decode(MailRule.self, forKey: .rule)
        } else {
            rule = try decoder.singleValueContainer().decode(MailRule.self)
        }
    }
}

struct MailRuleActionResponse: Decodable {
    let ok: Bool
    let rule: MailRule?

    private enum CodingKeys: String, CodingKey { case ok, rule }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        ok = try values.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        rule = try values.decodeIfPresent(MailRule.self, forKey: .rule)
    }
}

struct MailRulePreviewResponse: Decodable {
    let matchCount: Int?
    let sampledAtMost: Int?
    let matches: [MailRulePreviewMatch]
    let note: String?

    private enum CodingKeys: String, CodingKey {
        case matchCount, count, sampledAtMost, matches, evidence, note
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        matchCount = try values.decodeIfPresent(Int.self, forKey: .matchCount)
            ?? values.decodeIfPresent(Int.self, forKey: .count)
        sampledAtMost = try values.decodeIfPresent(Int.self, forKey: .sampledAtMost)
        matches = try values.decodeIfPresent([MailRulePreviewMatch].self, forKey: .matches)
            ?? values.decodeIfPresent([MailRulePreviewMatch].self, forKey: .evidence)
            ?? []
        note = try values.decodeIfPresent(String.self, forKey: .note)
    }
}

struct MailRulePreviewMatch: Decodable, Identifiable {
    let account: String
    let messageId: String
    let from: String
    let subject: String
    let date: String?
    let snippet: String

    var id: String { "\(account)|\(messageId)|\(subject)" }

    private enum CodingKeys: String, CodingKey { case account, messageId, id, from, subject, date, snippet }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        account = try values.decodeIfPresent(String.self, forKey: .account) ?? ""
        messageId = try values.decodeIfPresent(String.self, forKey: .messageId)
            ?? values.decodeIfPresent(String.self, forKey: .id)
            ?? UUID().uuidString
        from = try values.decodeIfPresent(String.self, forKey: .from) ?? "Unknown sender"
        subject = try values.decodeIfPresent(String.self, forKey: .subject) ?? "(no subject)"
        date = try values.decodeIfPresent(String.self, forKey: .date)
        snippet = try values.decodeIfPresent(String.self, forKey: .snippet) ?? ""
    }
}

private extension String {
    var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
