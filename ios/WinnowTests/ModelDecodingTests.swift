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
        XCTAssertEqual(item.gmailURL?.host, "mail.google.com")
        XCTAssertTrue(item.gmailURL?.absoluteString.contains("authuser=me@example.com") == true)
    }

    func testEmailToleratesFieldsAddedAfterOriginalAPI() throws {
        let json = #"{"id":"abc","isRead":true}"#.data(using: .utf8)!
        let item = try JSONDecoder().decode(EmailItem.self, from: json)
        XCTAssertEqual(item.readState, "read")
        XCTAssertEqual(item.mailboxState, "unknown")
    }
}
