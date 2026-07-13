import XCTest
@testable import Winnow

final class ModelDecodingTests: XCTestCase {
    func testEmailDecodesCurrentBackendShape() throws {
        let json = #"""
        {
          "id":"abc","account":"me@example.com","messageId":"m1","threadId":"t1",
          "fromName":"Sender","fromEmail":"sender@example.com","from":"Sender <sender@example.com>",
          "subject":"Hello","snippet":"Preview","summary":"Useful message","action":"Reply",
          "deadline":"Tomorrow","impact":"Medium","handling":"Review","reason":"Needs attention",
          "confidence":88,"ephemeral":false,"lowConfidenceKept":false,"triageState":"kept",
          "mailboxState":"inbox","archive":false,"unsubscribeLink":"https://example.com/unsubscribe",
          "createdAt":"2026-07-12T08:00:00.000Z","processedAt":"2026-07-12T08:00:00.000Z",
          "updatedAt":"2026-07-12T08:00:00.000Z","readState":"unread","isRead":false
        }
        """#.data(using: .utf8)!

        let item = try JSONDecoder().decode(EmailItem.self, from: json)
        XCTAssertEqual(item.subject, "Hello")
        XCTAssertTrue(item.isUnread)
        XCTAssertEqual(item.meaningfulAction, "Reply")
        XCTAssertEqual(item.gmailURL?.host, "mail.google.com")
        XCTAssertTrue(item.gmailURL?.absoluteString.contains("authuser=me@example.com") == true)
        XCTAssertEqual(item.gmailDestination?.accountHint, "me@example.com")
        XCTAssertEqual(GmailDestination.nativeAppURL.scheme, "googlegmail")
        XCTAssertEqual(
            item.nativeGmailURL(accountID: 2)?.absoluteString,
            "googlegmail:///cv=t1/accountId=2&create-new-tab"
        )
    }

    func testAccountDecodesAvatarAndGmailAppSlot() throws {
        let json = #"{"email":"me@example.com","avatarUrl":"https://example.com/me.png","gmailAppAccountId":2,"scan":{},"latestEvent":null}"#.data(using: .utf8)!
        let account = try JSONDecoder().decode(AccountStatus.self, from: json)
        XCTAssertEqual(account.avatarURL?.absoluteString, "https://example.com/me.png")
        XCTAssertEqual(account.gmailAppAccountId, 2)
    }

    func testEmailToleratesFieldsAddedAfterOriginalAPI() throws {
        let json = #"{"id":"abc","isRead":true}"#.data(using: .utf8)!
        let item = try JSONDecoder().decode(EmailItem.self, from: json)
        XCTAssertEqual(item.readState, "read")
        XCTAssertEqual(item.mailboxState, "unknown")
        XCTAssertNil(item.meaningfulAction)
    }

    func testOptimisticMailboxActionsTakePrecedenceOverLegacyArchiveFlag() throws {
        let json = #"{"id":"abc","mailboxState":"archived","archive":true,"readState":"unread"}"#.data(using: .utf8)!
        var item = try JSONDecoder().decode(EmailItem.self, from: json)

        item.applyOptimistic(.moveToInbox)
        XCTAssertFalse(item.isArchived)
        XCTAssertEqual(item.triageState, "restored")

        item.applyOptimistic(.archive)
        XCTAssertTrue(item.isArchived)
        XCTAssertEqual(item.triageState, "manual_archived")

        item.applyOptimistic(.markRead)
        XCTAssertFalse(item.isUnread)
    }

    func testNoActionLanguageIsHiddenFromCompactCards() throws {
        let json = #"{"id":"abc","action":"No action needed from the user."}"#.data(using: .utf8)!
        let item = try JSONDecoder().decode(EmailItem.self, from: json)
        XCTAssertNil(item.meaningfulAction)
    }

    func testLifetimeSummaryDecodesStatsAndRecentActivity() throws {
        let json = #"""
        {
          "scope":"lifetime","timeZone":"America/Los_Angeles","account":"all",
          "counters":{
            "processed":42,"kept":12,"autoArchived":30,"manualArchived":2,
            "restoredToInbox":1,"unsubscribedSucceeded":4,"unsubscribedFailed":0,
            "unsubscribedAttempted":1,"ephemeral":3,"lowConfidenceKept":2
          },
          "recentActivity":[{
            "eventId":7,"emailItemId":"abc","timestamp":"2026-07-13T10:00:00.000Z","account":"me@example.com",
            "threadId":"t1","messageId":"m1","from":"Sender","subject":"Update",
            "summary":"Summary","actionType":"email.auto_archived","source":"scan",
            "reason":"Routine update","confidence":95
          }]
        }
        """#.data(using: .utf8)!

        let summary = try JSONDecoder().decode(LifetimeSummary.self, from: json)
        XCTAssertEqual(summary.counters.processed, 42)
        XCTAssertEqual(summary.counters.totalArchived, 32)
        XCTAssertEqual(summary.recentActivity.first?.actionType, "email.auto_archived")
        XCTAssertEqual(summary.recentActivity.first?.emailItemId, "abc")
    }

    func testRecentActivityResolvesLegacyEventsByMessageThenThread() throws {
        let emailJSON = #"{"id":"abc","account":"me@example.com","messageId":"m1","threadId":"t1"}"#.data(using: .utf8)!
        let email = try JSONDecoder().decode(EmailItem.self, from: emailJSON)

        let messageEventJSON = #"{"eventId":1,"account":"me@example.com","messageId":"m1","threadId":"old"}"#.data(using: .utf8)!
        let messageEvent = try JSONDecoder().decode(SummaryItem.self, from: messageEventJSON)
        XCTAssertEqual(messageEvent.emailItemId, "")
        XCTAssertEqual(messageEvent.resolvedEmailID(in: [email]), "abc")

        let threadEventJSON = #"{"eventId":2,"account":"me@example.com","threadId":"t1"}"#.data(using: .utf8)!
        let threadEvent = try JSONDecoder().decode(SummaryItem.self, from: threadEventJSON)
        XCTAssertEqual(threadEvent.resolvedEmailID(in: [email]), "abc")

        let missingEventJSON = #"{"eventId":3,"account":"other@example.com","threadId":"t1"}"#.data(using: .utf8)!
        let missingEvent = try JSONDecoder().decode(SummaryItem.self, from: missingEventJSON)
        XCTAssertNil(missingEvent.resolvedEmailID(in: [email]))
    }

    func testPushRegistrationDecodesWithoutReturningSensitiveToken() throws {
        let json = #"""
        {
          "device": {
            "id":"device-1","platform":"ios",
            "installationId":"11111111-1111-1111-1111-111111111111",
            "environment":"development","bundleId":"com.cameronehrlich.Winnow",
            "appVersion":"1.0 (1)","enabled":true
          }
        }
        """#.data(using: .utf8)!

        let response = try JSONDecoder().decode(PushDeviceResponse.self, from: json)
        XCTAssertEqual(response.device.environment, "development")
        XCTAssertTrue(response.device.enabled)
    }

    func testWidgetSnapshotRoundTripsInboxState() throws {
        let snapshot = WinnowWidgetSnapshot(
            inboxCount: 2,
            items: [.init(id: "email-1", sender: "Riley", subject: "Question", summary: "Please review", date: Date())],
            updatedAt: Date()
        )
        let decoded = try JSONDecoder().decode(
            WinnowWidgetSnapshot.self,
            from: JSONEncoder().encode(snapshot)
        )
        XCTAssertEqual(decoded.inboxCount, 2)
        XCTAssertEqual(decoded.items.first?.sender, "Riley")
    }

    func testAssistantEnvelopeDecodesEvidenceDraftAndProposal() throws {
        let json = #"""
        {
          "conversation":{"id":"conversation-1","scope":"email","account":"me@example.com","emailItemId":"email-1"},
          "messages":[{
            "id":"message-1","conversationId":"conversation-1","role":"assistant","text":"I found it.","kind":"proposal",
            "createdAt":"2026-07-13T12:00:00.000Z",
            "evidence":[{"account":"me@example.com","messageId":"gmail-1","threadId":"thread-1","from":"Store","subject":"Order 123","snippet":"Shipped"}],
            "draft":{"kind":"reply","to":["store@example.com"],"cc":[],"subject":"Re: Order 123","body":"Thanks."},
            "proposal":{
              "id":"proposal-1","tool":"send.reply","risk":"outbound","summary":"Send this reply",
              "arguments":{"to":["store@example.com"],"includeAttachments":false},
              "confirmationDigest":"sha256:abc","expiresAt":"2026-07-13T12:05:00.000Z","status":"pending"
            }
          }]
        }
        """#.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(AssistantConversationEnvelope.self, from: json)
        XCTAssertEqual(envelope.conversation.scope, .email)
        XCTAssertEqual(envelope.messages.first?.evidence.first?.subject, "Order 123")
        XCTAssertEqual(envelope.messages.first?.draft?.to, ["store@example.com"])
        XCTAssertEqual(envelope.messages.first?.proposal?.tool, "send.reply")
        XCTAssertEqual(envelope.messages.first?.proposal?.arguments["includeAttachments"]?.displayString, "No")
        XCTAssertTrue(envelope.messages.first?.proposal?.isPending == true)
    }

    func testAssistantModelsTolerateOptionalFieldsAndLegacyToolName() throws {
        let json = #"""
        {
          "conversation":{"id":"conversation-1","scope":"mailbox"},
          "messages":[{
            "id":"message-1","role":"assistant",
            "proposal":{"id":"proposal-1","toolName":"rules.create","confirmationDigest":"digest"}
          }]
        }
        """#.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(AssistantConversationEnvelope.self, from: json)
        XCTAssertNil(envelope.conversation.account)
        XCTAssertEqual(envelope.messages.first?.text, "")
        XCTAssertTrue(envelope.messages.first?.evidence.isEmpty == true)
        XCTAssertEqual(envelope.messages.first?.proposal?.tool, "rules.create")
    }

    func testUnifiedRulesDecodeDefaultsOverridesAndLockedAutomations() throws {
        let json = #"""
        {"rules":[
          {"id":"baseline:default-news","account":null,"type":"semantic","effect":"archive","match":"Routine newsletters","description":"Routine newsletters","enabled":true,"scope":"baseline","source":"baseline","editable":false,"baselineRuleId":"default-news"},
          {"id":"override-news","account":"me@example.com","type":"semantic","effect":"keep","description":"Keep newsletters","enabled":true,"scope":"user","source":"api","editable":true,"baselineRuleId":"default-news"},
          {"id":"server-hook","account":"work@example.com","type":"exact","effect":"archive","matcherKind":"sender","matcherValue":"robot@example.com","description":"Server workflow","enabled":true,"scope":"user","source":"import","editable":false}
        ]}
        """#.data(using: .utf8)!

        let response = try JSONDecoder().decode(MailRuleListResponse.self, from: json)
        XCTAssertEqual(response.rules.count, 3)
        XCTAssertTrue(response.rules[0].isBaseline)
        XCTAssertFalse(response.rules[0].isBaselineCustomization)
        XCTAssertFalse(response.rules[0].canReset)
        XCTAssertEqual(response.rules[0].accountTitle, "All accounts")
        XCTAssertTrue(response.rules[1].isBaselineCustomization)
        XCTAssertTrue(response.rules[1].canReset)
        XCTAssertTrue(response.rules[2].isLockedAutomation)
        XCTAssertEqual(response.rules[2].matcherTitle, "Sender: robot@example.com")
    }

    func testRulePreviewToleratesEvidenceResponseShape() throws {
        let json = #"""
        {"matchCount":2,"sampledAtMost":100,"evidence":[
          {"account":"me@example.com","messageId":"m1","from":"News","subject":"Weekly update","snippet":"Highlights"}
        ]}
        """#.data(using: .utf8)!
        let preview = try JSONDecoder().decode(MailRulePreviewResponse.self, from: json)
        XCTAssertEqual(preview.matchCount, 2)
        XCTAssertEqual(preview.sampledAtMost, 100)
        XCTAssertEqual(preview.matches.first?.subject, "Weekly update")
    }

    func testSemanticRulePreviewPreservesNoGuessingNote() throws {
        let json = #"{"matchCount":null,"evidence":[],"note":"Semantic rules are evaluated by the classifier."}"#.data(using: .utf8)!
        let preview = try JSONDecoder().decode(MailRulePreviewResponse.self, from: json)
        XCTAssertNil(preview.matchCount)
        XCTAssertEqual(preview.note, "Semantic rules are evaluated by the classifier.")
    }

    func testRuleAPIUsesUnifiedRoutesAndCandidateShapes() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MailRuleURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = APIClient(
            configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"),
            session: session
        )
        let baselineJSON = #"{"id":"default-news","type":"semantic","effect":"archive","match":"Routine newsletters","description":"Routine newsletters","enabled":true,"scope":"baseline","source":"baseline","editable":false}"#.data(using: .utf8)!
        let baseline = try JSONDecoder().decode(MailRule.self, from: baselineJSON)
        var draft = MailRuleDraft(rule: baseline)
        draft.account = "me@example.com"
        draft.effect = "keep"

        MailRuleURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? "GET"
            let body = MailRuleURLProtocol.bodyData(from: request)
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }

            switch (method, path) {
            case ("GET", "/v1/rules"):
                XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "me@example.com")
                return (200, #"{"rules":[]}"#)
            case ("POST", "/v1/rules/preview"):
                XCTAssertNotNil(body?["candidate"] as? [String: Any])
                return (200, #"{"matchCount":0,"evidence":[]}"#)
            case ("POST", "/v1/rules"):
                XCTAssertEqual(body?["baselineRuleId"] as? String, "default-news")
                XCTAssertEqual(body?["account"] as? String, "me@example.com")
                XCTAssertNil(body?["match"])
                return (200, #"{"rule":{"id":"override-news","account":null,"type":"semantic","effect":"keep","description":"Routine newsletters","enabled":true,"scope":"user","source":"api","editable":true,"baselineRuleId":"default-news"}}"#)
            case ("PATCH", "/v1/rules/override-news"):
                XCTAssertEqual(body?["effect"] as? String, "keep")
                return (200, #"{"rule":{"id":"override-news","type":"semantic","effect":"keep","description":"Routine newsletters","enabled":true,"scope":"user","source":"api","editable":true,"baselineRuleId":"default-news"}}"#)
            case ("POST", "/v1/rules/override-news/disable"), ("POST", "/v1/rules/override-news/reset"):
                return (200, #"{"ok":true}"#)
            default:
                XCTFail("Unexpected rule request: \(method) \(path)")
                return (404, #"{"error":"unexpected"}"#)
            }
        }
        defer { MailRuleURLProtocol.handler = nil }

        let listedRules = try await client.mailRules(account: "me@example.com")
        let preview = try await client.previewMailRule(draft)
        XCTAssertTrue(listedRules.isEmpty)
        XCTAssertEqual(preview.matchCount, 0)
        let customized = try await client.customizeBaselineRule(draft)
        XCTAssertEqual(customized.baselineRuleId, "default-news")
        _ = try await client.updateMailRule(id: customized.id, candidate: MailRuleDraft(rule: customized))
        let disabled = try await client.disableMailRule(id: customized.id)
        let reset = try await client.resetMailRule(id: customized.id)
        XCTAssertTrue(disabled.ok)
        XCTAssertTrue(reset.ok)
    }
}

private final class MailRuleURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    static func bodyData(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }

        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (status, body) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
