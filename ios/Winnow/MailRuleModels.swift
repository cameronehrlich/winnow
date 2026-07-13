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
    let activity: MailRuleActivity?

    var isBaseline: Bool { scope == "baseline" }
    var isBaselineCustomization: Bool { !isBaseline && baselineRuleId != nil }
    var isLockedAutomation: Bool { !editable && !isBaseline && !isBaselineCustomization }
    var belongsWithDefaults: Bool { isBaseline || isBaselineCustomization }
    var canCustomize: Bool { isBaseline && !isLockedAutomation }
    var canReset: Bool { isBaselineCustomization }
    var canToggle: Bool { editable && !isBaseline && !isBaselineCustomization }

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
        case createdAt, updatedAt, activity
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
        activity = try values.decodeIfPresent(MailRuleActivity.self, forKey: .activity)
    }
}

struct MailRuleDraft: Encodable, Equatable {
    var id: String?
    var account: String?
    var type: String
    var effect: String
    var match: String?
    var matcherKind: String?
    var matcherValue: String?
    var description: String
    var enabled: Bool
    var baselineRuleId: String?
    var sourceEmailItemId: String?
    var expectedConflict: MailRuleConflictBinding?

    init(rule: MailRule) {
        id = rule.editable && !rule.isBaseline ? rule.id : nil
        account = rule.account
        type = rule.type
        effect = rule.effect
        match = rule.match
        matcherKind = rule.matcherKind
        matcherValue = rule.matcherValue
        description = rule.description
        enabled = rule.enabled
        baselineRuleId = rule.baselineRuleId ?? (rule.isBaseline ? rule.id : nil)
        sourceEmailItemId = rule.sourceEmailItemId
        expectedConflict = nil
    }

    init(
        account: String,
        type: String,
        effect: String,
        match: String? = nil,
        matcherKind: String? = nil,
        matcherValue: String? = nil,
        description: String,
        enabled: Bool = true,
        baselineRuleId: String? = nil,
        sourceEmailItemId: String? = nil
    ) {
        self.id = nil
        self.account = account
        self.type = type
        self.effect = effect
        self.match = match
        self.matcherKind = matcherKind
        self.matcherValue = matcherValue
        self.description = description
        self.enabled = enabled
        self.baselineRuleId = baselineRuleId
        self.sourceEmailItemId = sourceEmailItemId
        self.expectedConflict = nil
    }

    private enum CodingKeys: String, CodingKey {
        case id, account, type, effect, match, matcherKind, matcherValue
        case description, enabled, baselineRuleId, sourceEmailItemId, expectedConflict
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(id, forKey: .id)
        try values.encodeIfPresent(account, forKey: .account)
        try values.encode(type, forKey: .type)
        try values.encode(effect, forKey: .effect)
        try values.encode(description, forKey: .description)
        try values.encode(enabled, forKey: .enabled)
        try values.encodeIfPresent(baselineRuleId, forKey: .baselineRuleId)
        try values.encodeIfPresent(sourceEmailItemId, forKey: .sourceEmailItemId)
        try values.encodeIfPresent(expectedConflict, forKey: .expectedConflict)
        if type == "exact" {
            try values.encode(matcherKind ?? "sender", forKey: .matcherKind)
            try values.encodeIfPresent(matcherValue, forKey: .matcherValue)
        } else {
            try values.encodeIfPresent(match, forKey: .match)
        }
    }

    func bindingExpectedConflict(from preview: MailRulePreviewResponse) -> MailRuleDraft {
        var bound = self
        bound.expectedConflict = preview.replacementBinding
        return bound
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
    let candidate: MailRule?
    let mode: String?
    let evaluatedCount: Int?
    let matchCount: Int?
    let sampledAtMost: Int?
    let matches: [MailRulePreviewMatch]
    let nonMatches: [MailRulePreviewMatch]
    let note: String?
    let sampledAt: String?
    let model: String?
    let conflict: MailRuleConflict?

    var replacementBinding: MailRuleConflictBinding? {
        conflict.flatMap { MailRuleConflictBinding(rule: $0.rule) }
    }

    private enum CodingKeys: String, CodingKey {
        case candidate, mode, evaluatedCount, matchCount, count, sampledAtMost
        case matches, evidence, nonMatches, nonmatches, note, sampledAt, model, conflict
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        candidate = try values.decodeIfPresent(MailRule.self, forKey: .candidate)
        mode = try values.decodeIfPresent(String.self, forKey: .mode)
        evaluatedCount = try values.decodeIfPresent(Int.self, forKey: .evaluatedCount)
        matchCount = try values.decodeIfPresent(Int.self, forKey: .matchCount)
            ?? values.decodeIfPresent(Int.self, forKey: .count)
        sampledAtMost = try values.decodeIfPresent(Int.self, forKey: .sampledAtMost)
        matches = try values.decodeIfPresent([MailRulePreviewMatch].self, forKey: .matches)
            ?? values.decodeIfPresent([MailRulePreviewMatch].self, forKey: .evidence)
            ?? []
        nonMatches = try values.decodeIfPresent([MailRulePreviewMatch].self, forKey: .nonMatches)
            ?? values.decodeIfPresent([MailRulePreviewMatch].self, forKey: .nonmatches)
            ?? []
        note = try values.decodeIfPresent(String.self, forKey: .note)
        sampledAt = try values.decodeIfPresent(String.self, forKey: .sampledAt)
        model = try values.decodeIfPresent(String.self, forKey: .model)
        conflict = try values.decodeIfPresent(MailRuleConflict.self, forKey: .conflict)
    }
}

struct MailRuleConflictBinding: Codable, Equatable {
    let ruleId: String
    let updatedAt: String

    init(ruleId: String, updatedAt: String) {
        self.ruleId = ruleId
        self.updatedAt = updatedAt
    }

    init?(rule: MailRule) {
        guard
            !rule.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let updatedAt = rule.updatedAt?.trimmingCharacters(in: .whitespacesAndNewlines),
            !updatedAt.isEmpty
        else { return nil }
        self.init(ruleId: rule.id, updatedAt: updatedAt)
    }
}

struct MailRulePreviewMatch: Decodable, Identifiable, Equatable {
    let emailItemId: String
    let account: String
    let messageId: String
    let threadId: String
    let from: String
    let subject: String
    let date: String?
    let snippet: String
    let confidence: Int?
    let reason: String?

    var id: String { emailItemId.nilIfBlank ?? "\(account)|\(messageId)|\(threadId)|\(subject)" }
    var displayDate: Date? {
        guard let date else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: date) ?? ISO8601DateFormatter().date(from: date)
    }

    private enum CodingKeys: String, CodingKey {
        case emailItemId, account, messageId, id, threadId, from, subject, date, snippet, confidence, reason
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        emailItemId = try values.decodeIfPresent(String.self, forKey: .emailItemId) ?? ""
        account = try values.decodeIfPresent(String.self, forKey: .account) ?? ""
        messageId = try values.decodeIfPresent(String.self, forKey: .messageId)
            ?? values.decodeIfPresent(String.self, forKey: .id)
            ?? ""
        threadId = try values.decodeIfPresent(String.self, forKey: .threadId) ?? ""
        from = try values.decodeIfPresent(String.self, forKey: .from) ?? "Unknown sender"
        subject = try values.decodeIfPresent(String.self, forKey: .subject) ?? "(no subject)"
        date = try values.decodeIfPresent(String.self, forKey: .date)
        snippet = try values.decodeIfPresent(String.self, forKey: .snippet) ?? ""
        confidence = try values.decodeIfPresent(Int.self, forKey: .confidence)
        reason = try values.decodeIfPresent(String.self, forKey: .reason)?.nilIfBlank
    }
}

struct MailRuleConflict: Decodable {
    let rule: MailRule
}

struct MailRuleActivity: Decodable, Equatable {
    let appliedCount30Days: Int
    let lastAppliedAt: String?
    let recent: [MailRulePreviewMatch]

    var lastAppliedDate: Date? {
        guard let lastAppliedAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: lastAppliedAt) ?? ISO8601DateFormatter().date(from: lastAppliedAt)
    }

    private enum CodingKeys: String, CodingKey { case appliedCount30Days, count30Days, lastAppliedAt, recent }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        appliedCount30Days = try values.decodeIfPresent(Int.self, forKey: .appliedCount30Days)
            ?? values.decodeIfPresent(Int.self, forKey: .count30Days)
            ?? 0
        lastAppliedAt = try values.decodeIfPresent(String.self, forKey: .lastAppliedAt)
        recent = try values.decodeIfPresent([MailRulePreviewMatch].self, forKey: .recent) ?? []
    }
}

private extension String {
    var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
