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
    }

    func testEmailToleratesFieldsAddedAfterOriginalAPI() throws {
        let json = #"{"id":"abc","isRead":true}"#.data(using: .utf8)!
        let item = try JSONDecoder().decode(EmailItem.self, from: json)
        XCTAssertEqual(item.readState, "read")
        XCTAssertEqual(item.mailboxState, "unknown")
        XCTAssertNil(item.meaningfulAction)
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
}
