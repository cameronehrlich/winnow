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
}
