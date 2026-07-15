import Foundation
import XCTest
@testable import Winnow

final class ModelDecodingTests: XCTestCase {
    func testPushContextPreservesThreadNavigationMetadata() {
        let context = WinnowPushContext(userInfo: [
            "emailId": "email-1",
            "account": "me@example.com",
            "threadId": "thread-1",
            "mailboxState": "inbox",
        ])

        XCTAssertEqual(context.emailID, "email-1")
        XCTAssertEqual(context.account, "me@example.com")
        XCTAssertEqual(context.threadID, "thread-1")
        XCTAssertEqual(context.mailboxState, "inbox")
        XCTAssertEqual(WinnowNotificationIdentifier.emailCategory, "WINNOW_EMAIL")
        XCTAssertEqual(WinnowNotificationIdentifier.archiveAction, "WINNOW_ARCHIVE")
        XCTAssertEqual(WinnowNotificationIdentifier.askAction, "WINNOW_ASK")
    }

    func testActionResponseDecodesAuthoritativeBadge() throws {
        let data = #"{"ok":true,"action":"archive","badge":3}"#.data(using: .utf8)!
        let response = try JSONDecoder().decode(ActionResponse.self, from: data)
        XCTAssertEqual(response.badge, 3)
    }

    @MainActor
    func testArchivedUnseenIndicatorOnlyTracksNewerArchivedItems() throws {
        let data = #"""
        [
          {"id":"old-archive","mailboxState":"archived","processedAt":"2026-07-14T08:59:00Z"},
          {"id":"new-inbox","mailboxState":"inbox","processedAt":"2026-07-14T09:01:00Z"},
          {"id":"new-archive-1","mailboxState":"archived","processedAt":"2026-07-14T09:02:00Z"},
          {"id":"new-archive-2","mailboxState":"archived","processedAt":"2026-07-14T09:03:00Z"}
        ]
        """#.data(using: .utf8)!
        let emails = try JSONDecoder().decode([EmailItem].self, from: data)
        let cutoff = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-14T09:00:00Z"))

        XCTAssertEqual(AppModel.itemCount(in: emails, mailbox: .archived, newerThan: cutoff), 2)
        XCTAssertEqual(
            AppModel.itemCount(
                in: emails,
                mailbox: .archived,
                newerThan: cutoff,
                excluding: ["new-archive-1"]
            ),
            1
        )
        XCTAssertEqual(AppModel.itemCount(in: Array(emails.dropLast()), mailbox: .archived, newerThan: cutoff), 1)
        XCTAssertEqual(AppModel.itemCount(in: emails, mailbox: .inbox, newerThan: cutoff), 1)
    }

    func testDeviceProposalBuildsAStableSourceBacklink() throws {
        let json = #"""
        {
          "id":"proposal-1","tool":"device.create_reminder","risk":"persistent",
          "summary":"Create reminder","confirmationDigest":"digest","status":"pending",
          "arguments":{
            "title":"Submit receipt",
            "source":{"emailItemId":"email id/1","mailboxState":"archived","subject":"Receipt"}
          }
        }
        """#.data(using: .utf8)!
        let proposal = try JSONDecoder().decode(AssistantProposal.self, from: json)
        let source = try XCTUnwrap(DeviceActionSource(proposal: proposal))
        let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(source.backlink(proposalID: proposal.id)), resolvingAgainstBaseURL: false))

        XCTAssertTrue(proposal.isDeviceAction)
        XCTAssertEqual(components.scheme, "winnow")
        XCTAssertEqual(components.host, "email")
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: components.queryItems?.compactMap { item in
            item.value.map { (item.name, $0) }
        } ?? []), ["id": "email id/1", "mailbox": "archived", "proposal": "proposal-1"])

        XCTAssertEqual(
            ReminderNotes.withWinnowBacklink("Receipt forwarded by Riley.", source: source),
            "Receipt forwarded by Riley.\n\nOpen in Winnow:\nwinnow://email?id=email%20id/1"
        )
    }

    func testDeviceActionDatesAcceptStandardAndFractionalISO8601() {
        XCTAssertNotNil(DeviceActionDate.parse("2026-07-14T09:30:00-07:00"))
        XCTAssertNotNil(DeviceActionDate.parse("2026-07-14T16:30:00.123Z"))
        XCTAssertNil(DeviceActionDate.parse("tomorrow morning"))
    }

    @MainActor
    func testNewItemDividerCutoffStaysFrozenUntilTheNextForegroundSession() {
        let defaults = UserDefaults.standard
        let inboxKey = "winnow.inbox-last-viewed"
        let archivedKey = "winnow.archived-last-viewed"
        let previousInbox = defaults.object(forKey: inboxKey)
        let previousArchived = defaults.object(forKey: archivedKey)
        defer {
            if let previousInbox { defaults.set(previousInbox, forKey: inboxKey) }
            else { defaults.removeObject(forKey: inboxKey) }
            if let previousArchived { defaults.set(previousArchived, forKey: archivedKey) }
            else { defaults.removeObject(forKey: archivedKey) }
        }

        let originalCutoff = Date(timeIntervalSince1970: 1_700_000_000)
        let nextSessionCutoff = originalCutoff.addingTimeInterval(300)
        defaults.set(originalCutoff, forKey: inboxKey)
        defaults.set(originalCutoff, forKey: archivedKey)

        let model = AppModel(configuration: ServerConfiguration(serverURL: "", token: ""))
        model.setVisibleMailbox(.inbox)
        defaults.set(nextSessionCutoff, forKey: inboxKey)
        model.setVisibleMailbox(.archived)
        model.setVisibleMailbox(.inbox)

        XCTAssertEqual(model.inboxNewItemsCutoff, originalCutoff)

        model.setVisibleMailbox(nil)
        model.setVisibleMailbox(.inbox)

        XCTAssertEqual(model.inboxNewItemsCutoff, nextSessionCutoff)
    }

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
          "updatedAt":"2026-07-12T08:00:00.000Z","readState":"unread","isRead":false,
          "trackedThreadMessageCount":3,"unreadThreadMessageCount":2
        }
        """#.data(using: .utf8)!

        let item = try JSONDecoder().decode(EmailItem.self, from: json)
        XCTAssertEqual(item.subject, "Hello")
        XCTAssertTrue(item.isUnread)
        XCTAssertEqual(item.meaningfulAction, "Reply")
        XCTAssertTrue(item.canLoadFullContent)
        XCTAssertTrue(item.isConversation)
        XCTAssertEqual(item.trackedThreadMessageCount, 3)
        XCTAssertEqual(item.unreadThreadMessageCount, 2)
        XCTAssertNil(item.handlingDecision)
        XCTAssertNil(item.undoAction)
    }

    func testEmailDecodesCanonicalAttachmentMetadata() throws {
        let json = #"""
        {
          "id":"abc","threadId":"thread-1",
          "attachments":[
            {
              "messageId":"message-1","attachmentId":"attachment-1",
              "filename":"Invoice.pdf","mimeType":"application/pdf","sizeBytes":143501
            },
            {
              "messageId":"message-2","attachmentId":"attachment-2",
              "filename":"details.txt","mimeType":"text/plain","sizeBytes":"512"
            }
          ]
        }
        """#.data(using: .utf8)!

        let item = try JSONDecoder().decode(EmailItem.self, from: json)
        XCTAssertEqual(item.attachments.count, 2)
        XCTAssertEqual(item.attachments.first?.id, "message-1|attachment-1")
        XCTAssertEqual(item.attachments.first?.messageId, "message-1")
        XCTAssertEqual(item.attachments.first?.displayName, "Invoice.pdf")
        XCTAssertEqual(item.attachments.first?.sizeBytes, 143_501)
        XCTAssertEqual(item.attachments.last?.sizeBytes, 512)
    }

    func testEmailNormalizesDisplayMetadataAndHidesMissingSubject() throws {
        let json = #"{"id":"abc","fromName":"<>","fromEmail":"shawn@example.com","subject":"(no subject)"}"#.data(using: .utf8)!
        let item = try JSONDecoder().decode(EmailItem.self, from: json)

        XCTAssertEqual(item.senderDisplayName, "shawn@example.com")
        XCTAssertNil(item.displaySubject)

        let foldedJSON = #"{"id":"folded","subject":" \n Follow-up work \t ready "}"#.data(using: .utf8)!
        let folded = try JSONDecoder().decode(EmailItem.self, from: foldedJSON)
        XCTAssertEqual(folded.displaySubject, "Follow-up work ready")
    }

    func testReplyIsRecognizedAsAConversationBeforeEarlierRowsAreIndexed() throws {
        let json = #"{"id":"reply","messageId":"m-reply","threadId":"t-original","trackedThreadMessageCount":1}"#.data(using: .utf8)!
        let item = try JSONDecoder().decode(EmailItem.self, from: json)

        XCTAssertTrue(item.isConversation)
    }

    func testFullEmailContentDecodes() throws {
        let json = #"{"emailItemId":"abc","account":"me@example.com","threadId":"t1","focusedMessageId":"m1","subject":"Hello","messages":[{"id":"m1","from":"Sender","to":"Me","cc":"","subject":"Hello","date":"Today","body":"Complete body","htmlBody":"<p>Complete <strong>body</strong></p>"}],"truncated":false,"fetchedAt":"2026-07-13T12:00:00.000Z"}"#.data(using: .utf8)!
        let content = try JSONDecoder().decode(EmailContent.self, from: json)
        XCTAssertEqual(content.focusedMessageId, "m1")
        XCTAssertEqual(content.messages.first?.body, "Complete body")
        XCTAssertEqual(content.messages.first?.htmlBody, "<p>Complete <strong>body</strong></p>")
        XCTAssertEqual(content.messages.first?.hasHTMLBody, true)
        XCTAssertTrue(content.attachments.isEmpty)
        XCTAssertFalse(content.truncated)
    }

    func testFullEmailContentDefaultsMissingHTMLBodyToEmpty() throws {
        let json = #"{"emailItemId":"abc","messages":[{"id":"m1","body":"Plain only"}]}"#.data(using: .utf8)!
        let content = try JSONDecoder().decode(EmailContent.self, from: json)

        XCTAssertEqual(content.messages.first?.htmlBody, "")
        XCTAssertEqual(content.messages.first?.hasHTMLBody, false)
    }

    func testSafeEmailHTMLDocumentLocksDownActiveAndRemoteContent() {
        let document = SafeEmailHTML.document(for: "<script>window.bad = true</script><img src='https://tracker.example/pixel'>")

        XCTAssertTrue(document.contains("default-src 'none'"))
        XCTAssertTrue(document.contains("connect-src 'none'"))
        XCTAssertTrue(document.contains("form-action 'none'"))
        XCTAssertTrue(document.contains("img:not([src^=\"data:\" i])"))
        XCTAssertTrue(document.contains("<script>window.bad = true</script>"))
    }

    func testFullEmailContentDecodesThreadAttachments() throws {
        let json = #"{"emailItemId":"abc","messages":[],"attachments":[{"messageId":"m1","attachmentId":"a1","filename":"Invoice.pdf","mimeType":"application/pdf","sizeBytes":143501}]}"#.data(using: .utf8)!
        let content = try JSONDecoder().decode(EmailContent.self, from: json)

        XCTAssertEqual(content.attachments.map(\.attachmentId), ["a1"])
    }

    func testFullEmailContentPutsSelectedMessageFirstThenNewest() throws {
        let json = #"{"emailItemId":"abc","account":"me@example.com","threadId":"t1","focusedMessageId":"m1","subject":"Hello","messages":[{"id":"m1","from":"One","to":"","cc":"","subject":"","date":"","body":"First"},{"id":"m2","from":"Two","to":"","cc":"","subject":"","date":"","body":"Second"},{"id":"m3","from":"Three","to":"","cc":"","subject":"","date":"","body":"Third"}],"truncated":false,"fetchedAt":"2026-07-13T12:00:00.000Z"}"#.data(using: .utf8)!
        let content = try JSONDecoder().decode(EmailContent.self, from: json)
        XCTAssertEqual(content.messagesForDisplay.map(\.id), ["m1", "m3", "m2"])
    }

    func testFullEmailBodyDetectsSafeLinksAndPhoneNumbers() {
        let source = "Visit https://example.com, email help@example.com, or call +1 (415) 555-0123."
        let rendered = EmailBodyLinks.render(source)
        let links = Set(rendered.runs.compactMap { $0.link?.absoluteString })

        XCTAssertEqual(String(rendered.characters), source)
        XCTAssertTrue(links.contains("https://example.com"))
        XCTAssertTrue(links.contains("mailto:help@example.com"))
        XCTAssertTrue(links.contains("tel:+14155550123"))
        XCTAssertTrue(links.allSatisfy {
            guard let scheme = URL(string: $0)?.scheme else { return false }
            return ["http", "https", "mailto", "tel"].contains(scheme)
        })
    }

    func testEmailDecodesTypedHandlingDecisionAndRuleAttribution() throws {
        let json = #"""
        {
          "id":"abc","mailboxState":"archived",
          "undoAction":"move-to-inbox",
          "handlingDecision":{
            "effect":"archive","basis":"semantic_rule",
            "explanation":"Matched routine product announcements.","confidence":93,
            "handledAt":"2026-07-13T12:00:00.000Z",
            "appliedRule":{
              "id":"rule-1","description":"Routine announcements","scope":"user",
              "source":"assistant","editable":true,
              "attribution":"model_cited"
            }
          }
        }
        """#.data(using: .utf8)!

        let item = try JSONDecoder().decode(EmailItem.self, from: json)
        XCTAssertEqual(item.handlingDecision?.effect, .archive)
        XCTAssertEqual(item.handlingDecision?.basis, .semanticRule)
        XCTAssertEqual(item.handlingDecision?.confidence, 93)
        XCTAssertEqual(item.handlingDecision?.appliedRule?.id, "rule-1")
        XCTAssertEqual(item.handlingDecision?.appliedRule?.displayTitle, "Routine announcements")
        XCTAssertEqual(item.handlingDecision?.appliedRule?.attributionDescription, "Classifier-cited rule")
        XCTAssertEqual(item.undoAction, .moveToInbox)
    }

    func testEmailDecodesAllServerHandlingBases() throws {
        for basis in ["server_automation", "ephemeral"] {
            let json = #"{"id":"abc","handlingDecision":{"effect":"archive","basis":"\#(basis)","handledAt":"2026-07-13T12:00:00.000Z"}}"#.data(using: .utf8)!
            let item = try JSONDecoder().decode(EmailItem.self, from: json)
            XCTAssertNotNil(item.handlingDecision?.basis)
        }
    }

    func testEmailToleratesFutureDecisionBasisAndUndoAction() throws {
        let json = #"{"id":"abc","undoAction":"future-action","handlingDecision":{"effect":"keep","basis":"future_basis","handledAt":"2026-07-13T12:00:00.000Z"}}"#.data(using: .utf8)!
        let item = try JSONDecoder().decode(EmailItem.self, from: json)
        XCTAssertEqual(item.handlingDecision?.effect, .keep)
        XCTAssertNil(item.handlingDecision?.basis)
        XCTAssertNil(item.undoAction)
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
            "id":"message-1","conversationId":"conversation-1","runId":"run-1","role":"assistant","text":"I found it.","kind":"proposal",
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
        XCTAssertEqual(envelope.messages.first?.runId, "run-1")
        XCTAssertEqual(envelope.messages.first?.evidence.first?.subject, "Order 123")
        XCTAssertEqual(envelope.messages.first?.draft?.to, ["store@example.com"])
        XCTAssertEqual(envelope.messages.first?.proposal?.tool, "send.reply")
        XCTAssertEqual(envelope.messages.first?.proposal?.arguments["includeAttachments"]?.displayString, "No")
        XCTAssertTrue(envelope.messages.first?.proposal?.isPending == true)
    }

    func testAssistantMarkdownFormatsModelOutputAndPreservesLayout() {
        let message = AssistantMessage(
            id: "assistant-markdown",
            role: "assistant",
            text: "The **review is on hold**.\n\n1. Provide the `order form`.\n2. Confirm retention."
        )

        XCTAssertEqual(
            String(message.formattedText.characters),
            "The review is on hold.\n\n1. Provide the order form.\n2. Confirm retention."
        )
        XCTAssertTrue(message.formattedText.runs.contains {
            $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
        })
        XCTAssertTrue(message.formattedText.runs.contains {
            $0.inlinePresentationIntent?.contains(.code) == true
        })
    }

    func testAssistantMarkdownDoesNotFormatUserTextOrActivateLinks() {
        let user = AssistantMessage(
            id: "user-markdown",
            role: "user",
            text: "Keep **these markers** literal"
        )
        XCTAssertEqual(String(user.formattedText.characters), "Keep **these markers** literal")

        let assistant = AssistantMessage(
            id: "assistant-link",
            role: "assistant",
            text: "Read [the source](https://example.com)"
        )
        XCTAssertEqual(String(assistant.formattedText.characters), "Read the source")
        XCTAssertFalse(assistant.formattedText.runs.contains { $0.link != nil })
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
          {"id":"override-news","account":"me@example.com","type":"semantic","effect":"keep","description":"Keep newsletters","enabled":true,"scope":"user","source":"api","editable":true,"baselineRuleId":"default-news","activity":{"appliedCount30Days":12,"lastAppliedAt":"2026-07-12T10:00:00.000Z","recent":[{"emailItemId":"email-1","from":"News","subject":"Weekly news","date":"2026-07-12T10:00:00.000Z"}]}},
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
        XCTAssertFalse(response.rules[1].canToggle)
        XCTAssertEqual(response.rules[1].activity?.appliedCount30Days, 12)
        XCTAssertNotNil(response.rules[1].activity?.lastAppliedDate)
        XCTAssertEqual(response.rules[1].activity?.recent.first?.subject, "Weekly news")
        XCTAssertNotNil(response.rules[1].activity?.recent.first?.displayDate)
        XCTAssertTrue(response.rules[2].isLockedAutomation)
        XCTAssertEqual(response.rules[2].matcherTitle, "Sender: robot@example.com")
    }

    func testImportedRuleUsesItsMatchAsTheVisibleTitle() throws {
        let json = #"{"id":"imported","account":"me@example.com","type":"semantic","effect":"archive","match":"TestFlight build notifications","description":"Imported from account YAML","enabled":true,"scope":"user","source":"import","editable":true}"#.data(using: .utf8)!
        let rule = try JSONDecoder().decode(MailRule.self, from: json)

        XCTAssertEqual(rule.displayTitle, "TestFlight build notifications")
        XCTAssertNil(rule.supportingTitle)
    }

    func testNamedRuleKeepsItsMatcherAsSupportingText() throws {
        let json = #"{"id":"named","account":"me@example.com","type":"exact","effect":"keep","matcherKind":"sender","matcherValue":"alerts@example.com","description":"Important alerts","enabled":true,"scope":"user","source":"api","editable":true}"#.data(using: .utf8)!
        let rule = try JSONDecoder().decode(MailRule.self, from: json)

        XCTAssertEqual(rule.displayTitle, "Important alerts")
        XCTAssertEqual(rule.supportingTitle, "Sender: alerts@example.com")
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

    func testRicherSemanticPreviewDecodesExamplesAndConflict() throws {
        let json = #"""
        {
          "candidate":{"id":"candidate","account":"me@example.com","type":"semantic","effect":"archive","match":"Routine receipts","description":"Receipts","enabled":true,"scope":"user","source":"api","editable":true},
          "mode":"semantic","evaluatedCount":18,"sampledAtMost":100,
          "matches":[{"emailItemId":"email-1","account":"me@example.com","messageId":"m1","threadId":"t1","from":"Store","subject":"Receipt","snippet":"Paid","confidence":91.5,"reason":"Completed purchase receipt"}],
          "nonMatches":[{"emailItemId":"email-2","account":"me@example.com","messageId":"m2","threadId":"t2","from":"Store","subject":"Payment failed","confidence":88,"reason":"Requires action"}],
          "sampledAt":"2026-07-13T12:00:00.000Z","model":"classifier-v1",
          "conflict":{"rule":{"id":"existing","account":"me@example.com","type":"semantic","effect":"keep","match":"Routine receipts","description":"Keep receipts","enabled":true,"scope":"user","source":"assistant","editable":true,"updatedAt":"2026-07-13T11:59:00.000Z"}},
          "expectedRule":{"ruleId":"candidate","updatedAt":"2026-07-13T11:58:00.000Z"}
        }
        """#.data(using: .utf8)!

        let preview = try JSONDecoder().decode(MailRulePreviewResponse.self, from: json)
        XCTAssertEqual(preview.mode, "semantic")
        XCTAssertEqual(preview.evaluatedCount, 18)
        XCTAssertEqual(preview.matches.first?.confidence, 91.5)
        XCTAssertEqual(preview.matches.first?.confidencePercentText, "91.5%")
        XCTAssertEqual(preview.nonMatches.first?.confidencePercentText, "88%")
        XCTAssertEqual(preview.nonMatches.first?.emailItemId, "email-2")
        XCTAssertEqual(preview.conflict?.rule.id, "existing")
        XCTAssertEqual(preview.replacementBinding?.ruleId, "existing")
        XCTAssertEqual(preview.replacementBinding?.updatedAt, "2026-07-13T11:59:00.000Z")
        XCTAssertEqual(preview.expectedRule?.ruleId, "candidate")
        XCTAssertEqual(preview.expectedRule?.updatedAt, "2026-07-13T11:58:00.000Z")

        let candidate = MailRuleDraft(
            account: "me@example.com", type: "semantic", effect: "archive",
            match: "Routine receipts", description: "Receipts"
        ).bindingExpectedGuards(from: preview)
        let payload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(candidate)) as? [String: Any]
        )
        let expectedConflict = try XCTUnwrap(payload["expectedConflict"] as? [String: Any])
        XCTAssertEqual(expectedConflict["ruleId"] as? String, "existing")
        XCTAssertEqual(expectedConflict["updatedAt"] as? String, "2026-07-13T11:59:00.000Z")
        let expectedRule = try XCTUnwrap(payload["expectedRule"] as? [String: Any])
        XCTAssertEqual(expectedRule["ruleId"] as? String, "candidate")
        XCTAssertEqual(expectedRule["updatedAt"] as? String, "2026-07-13T11:58:00.000Z")
    }

    func testExactRuleDraftEncodesDefaultFieldAndOmitsSemanticMatch() throws {
        let json = #"{"id":"rule-1","account":"me@example.com","type":"semantic","effect":"archive","match":"Routine receipts","description":"Receipts","enabled":true,"scope":"user","source":"api","editable":true}"#.data(using: .utf8)!
        let rule = try JSONDecoder().decode(MailRule.self, from: json)
        var draft = MailRuleDraft(rule: rule)
        draft.type = "exact"
        draft.matcherValue = "billing@example.com"

        let payload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any]
        )
        XCTAssertEqual(payload["matcherKind"] as? String, "sender")
        XCTAssertEqual(payload["matcherValue"] as? String, "billing@example.com")
        XCTAssertEqual(payload["id"] as? String, "rule-1")
        XCTAssertNil(payload["match"])
        XCTAssertTrue(payload["subjectMatchMode"] is NSNull)
        XCTAssertTrue(payload["subjectMatchValue"] is NSNull)
    }

    func testCompoundSubjectRuleDecodesDisplaysAndRoundTrips() throws {
        let json = #"{"id":"rule-2","account":"me@example.com","type":"exact","effect":"archive","matcherKind":"sender","matcherValue":"systemmessage@paycomonline.com","subjectMatchMode":"exact","subjectMatchValue":"New Check Available","description":"Paycom checks","enabled":true,"scope":"user","source":"assistant","editable":true}"#.data(using: .utf8)!
        let rule = try JSONDecoder().decode(MailRule.self, from: json)

        XCTAssertEqual(rule.subjectMatchMode, "exact")
        XCTAssertEqual(rule.subjectMatchValue, "New Check Available")
        XCTAssertTrue(rule.matcherTitle.contains("Subject is “New Check Available”"))

        let compoundDraft = MailRuleDraft(rule: rule)
        XCTAssertTrue(compoundDraft.matcherTitle.contains("Subject is “New Check Available”"))
        let payload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(compoundDraft)) as? [String: Any]
        )
        XCTAssertEqual(payload["subjectMatchMode"] as? String, "exact")
        XCTAssertEqual(payload["subjectMatchValue"] as? String, "New Check Available")

        var clearedDraft = MailRuleDraft(rule: rule)
        clearedDraft.subjectMatchMode = nil
        clearedDraft.subjectMatchValue = nil
        let clearedPayload = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(clearedDraft)) as? [String: Any]
        )
        XCTAssertTrue(clearedPayload["subjectMatchMode"] is NSNull)
        XCTAssertTrue(clearedPayload["subjectMatchValue"] is NSNull)
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
                let candidate = body?["candidate"] as? [String: Any]
                XCTAssertNotNil(candidate)
                XCTAssertNil(candidate?["id"])
                XCTAssertEqual(body?["limit"] as? Int, 5)
                return (200, #"{"matchCount":0,"evidence":[]}"#)
            case ("POST", "/v1/rules"):
                if body?["sourceEmailItemId"] as? String == "email-source" {
                    XCTAssertNil(body?["id"])
                    XCTAssertEqual(body?["matcherKind"] as? String, "sender")
                    XCTAssertEqual(body?["account"] as? String, "me@example.com")
                    let expectedConflict = body?["expectedConflict"] as? [String: Any]
                    XCTAssertEqual(expectedConflict?["ruleId"] as? String, "existing-sender")
                    XCTAssertEqual(expectedConflict?["updatedAt"] as? String, "2026-07-13T12:00:00.000Z")
                    return (201, #"{"rule":{"id":"created","account":"me@example.com","type":"exact","effect":"archive","matcherKind":"sender","matcherValue":"billing@example.com","description":"Billing","enabled":true,"scope":"user","source":"api","editable":true,"sourceEmailItemId":"email-source"}}"#)
                }
                XCTAssertEqual(body?["baselineRuleId"] as? String, "default-news")
                XCTAssertEqual(body?["account"] as? String, "me@example.com")
                XCTAssertNil(body?["id"])
                XCTAssertNil(body?["match"])
                let expectedConflict = body?["expectedConflict"] as? [String: Any]
                XCTAssertEqual(expectedConflict?["ruleId"] as? String, "existing-default")
                XCTAssertEqual(expectedConflict?["updatedAt"] as? String, "2026-07-13T11:00:00.000Z")
                return (200, #"{"rule":{"id":"override-news","account":null,"type":"semantic","effect":"keep","description":"Routine newsletters","enabled":true,"scope":"user","source":"api","editable":true,"baselineRuleId":"default-news","updatedAt":"2026-07-13T10:00:00.000Z"}}"#)
            case ("PATCH", "/v1/rules/override-news"):
                XCTAssertEqual(body?["effect"] as? String, "keep")
                let expectedRule = body?["expectedRule"] as? [String: Any]
                XCTAssertEqual(expectedRule?["ruleId"] as? String, "override-news")
                XCTAssertEqual(expectedRule?["updatedAt"] as? String, "2026-07-13T10:00:00.000Z")
                return (200, #"{"rule":{"id":"override-news","type":"semantic","effect":"keep","description":"Routine newsletters","enabled":true,"scope":"user","source":"api","editable":true,"baselineRuleId":"default-news"}}"#)
            case ("POST", "/v1/rules/override-news/disable"), ("POST", "/v1/rules/override-news/reset"):
                return (200, #"{"ok":true}"#)
            case ("POST", "/v1/emails/email-source/undo-handling"):
                return (200, #"{"ok":true,"action":"undo-handling","item":{"id":"email-source","mailboxState":"inbox"}}"#)
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
        draft.expectedConflict = MailRuleVersionBinding(
            ruleId: "existing-default",
            updatedAt: "2026-07-13T11:00:00.000Z"
        )
        let customized = try await client.customizeBaselineRule(draft)
        XCTAssertEqual(customized.baselineRuleId, "default-news")
        var sourceDraft = MailRuleDraft(
            account: "me@example.com", type: "exact", effect: "archive",
            matcherKind: "sender", matcherValue: "billing@example.com",
            description: "Billing", sourceEmailItemId: "email-source"
        )
        sourceDraft.expectedConflict = MailRuleVersionBinding(
            ruleId: "existing-sender",
            updatedAt: "2026-07-13T12:00:00.000Z"
        )
        let created = try await client.createMailRule(sourceDraft)
        XCTAssertEqual(created.sourceEmailItemId, "email-source")
        var updateDraft = MailRuleDraft(rule: customized)
        updateDraft.expectedRule = try XCTUnwrap(MailRuleVersionBinding(rule: customized))
        _ = try await client.updateMailRule(id: customized.id, candidate: updateDraft)
        let disabled = try await client.disableMailRule(id: customized.id)
        let reset = try await client.resetMailRule(id: customized.id)
        XCTAssertTrue(disabled.ok)
        XCTAssertTrue(reset.ok)
        let undone = try await client.undoHandling(emailID: "email-source")
        XCTAssertEqual(undone.action, "undo-handling")
        XCTAssertEqual(undone.item?.mailboxState, "inbox")
    }

    func testExistingBaselineCustomizationPOSTRetainsRuleID() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MailRuleURLProtocol.self]
        let client = APIClient(
            configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"),
            session: URLSession(configuration: configuration)
        )
        let json = #"{"id":"override-news","account":"me@example.com","type":"semantic","effect":"keep","match":"Routine newsletters","description":"Keep newsletters","enabled":true,"scope":"user","source":"api","editable":true,"baselineRuleId":"default-news","updatedAt":"2026-07-13T11:00:00.000Z"}"#.data(using: .utf8)!
        let existing = try JSONDecoder().decode(MailRule.self, from: json)

        MailRuleURLProtocol.handler = { request in
            let body = try XCTUnwrap(MailRuleURLProtocol.bodyData(from: request))
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(request.httpMethod, "POST")
            switch request.url?.path {
            case "/v1/rules/preview":
                let candidate = try XCTUnwrap(payload["candidate"] as? [String: Any])
                XCTAssertEqual(candidate["id"] as? String, "override-news")
                XCTAssertNil(candidate["expectedRule"])
                return (200, #"{"candidate":{"id":"override-news","account":"me@example.com","type":"semantic","effect":"archive","match":"Routine newsletters","description":"Keep newsletters","enabled":true,"scope":"user","source":"api","editable":true,"baselineRuleId":"default-news"},"mode":"semantic","matches":[],"nonMatches":[],"expectedRule":{"ruleId":"override-news","updatedAt":"2026-07-13T11:00:00.000Z"}}"#)
            case "/v1/rules":
                XCTAssertEqual(payload["id"] as? String, "override-news")
                XCTAssertEqual(payload["baselineRuleId"] as? String, "default-news")
                XCTAssertEqual(payload["account"] as? String, "me@example.com")
                let expectedRule = try XCTUnwrap(payload["expectedRule"] as? [String: Any])
                XCTAssertEqual(expectedRule["ruleId"] as? String, "override-news")
                XCTAssertEqual(expectedRule["updatedAt"] as? String, "2026-07-13T11:00:00.000Z")
                return (200, #"{"rule":{"id":"override-news","account":"me@example.com","type":"semantic","effect":"archive","description":"Keep newsletters","enabled":true,"scope":"user","source":"api","editable":true,"baselineRuleId":"default-news","updatedAt":"2026-07-13T12:00:00.000Z"}}"#)
            default:
                XCTFail("Unexpected path: \(request.url?.path ?? "nil")")
                return (404, #"{"error":"unexpected"}"#)
            }
        }
        defer { MailRuleURLProtocol.handler = nil }

        var draft = MailRuleDraft(rule: existing)
        draft.effect = "archive"
        let preview = try await client.previewMailRule(draft)
        XCTAssertEqual(preview.expectedRule?.ruleId, existing.id)
        let updated = try await client.customizeBaselineRule(draft.bindingExpectedGuards(from: preview))
        XCTAssertEqual(updated.id, existing.id)
        XCTAssertEqual(updated.effect, "archive")
    }

    func testClientActionCompletionUsesDigestBoundEndpoint() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MailRuleURLProtocol.self]
        let client = APIClient(
            configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"),
            session: URLSession(configuration: configuration)
        )
        MailRuleURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/assistant/proposals/proposal-1/complete-client")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
            let body = try XCTUnwrap(MailRuleURLProtocol.bodyData(from: request))
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
            XCTAssertEqual(payload, ["confirmationDigest": "digest-1"])
            return (200, #"{"conversation":{"id":"conversation-1","scope":"email"},"messages":[]}"#)
        }
        defer { MailRuleURLProtocol.handler = nil }

        let envelope = try await client.completeAssistantClientProposal(id: "proposal-1", confirmationDigest: "digest-1")
        XCTAssertEqual(envelope.conversation.id, "conversation-1")
    }

    func testAssistantSSEParserHandlesByteBoundariesCRLFMultilineAndUnknownEvents() throws {
        let complete = #"{"conversation":{"id":"conversation-1","scope":"mailbox"},"messages":[{"id":"answer-1","role":"assistant","text":"Done"}]}"#
        let wire = [
            ": heartbeat\r\n",
            "event: accepted\r\n",
            "data: {\"runId\":\"run-1\",\r\n",
            "data: \"userMessageId\":\"user-1\"}\r\n",
            "\r\n",
            "event: future-event\n",
            "data: this need not be JSON\n",
            "\n",
            "event: progress\n",
            "data: {\"stage\":\"search\",\"label\":\"Searching 📬\",\"future\":true}\n",
            "\n",
            "event: complete\r\n",
            "data: \(complete)\r\n",
        ].joined()

        var parser = AssistantServerSentEventParser()
        var frames: [AssistantServerSentEvent] = []
        for byte in Data(wire.utf8) {
            frames.append(contentsOf: try parser.append(Data([byte])))
        }
        frames.append(contentsOf: try parser.finish())

        XCTAssertEqual(frames.map(\.name), ["accepted", "future-event", "progress", "complete"])
        let client = APIClient(configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"))

        guard case let .accepted(accepted)? = try client.decodeAssistantStreamEvent(frames[0]) else {
            return XCTFail("Expected accepted event")
        }
        XCTAssertEqual(accepted.runId, "run-1")
        XCTAssertEqual(accepted.userMessageId, "user-1")
        XCTAssertNil(try client.decodeAssistantStreamEvent(frames[1]))

        guard case let .progress(progress)? = try client.decodeAssistantStreamEvent(frames[2]) else {
            return XCTFail("Expected progress event")
        }
        XCTAssertEqual(progress.stage, "search")
        XCTAssertEqual(progress.label, "Searching 📬")

        guard case let .complete(envelope)? = try client.decodeAssistantStreamEvent(frames[3]) else {
            return XCTFail("Expected complete event")
        }
        XCTAssertEqual(envelope.messages.first?.id, "answer-1")
    }

    func testAssistantSSEKnownMalformedAndErrorEventsFailSafely() throws {
        let client = APIClient(configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"))
        let malformed = AssistantServerSentEvent(
            name: "progress",
            data: Data(#"{"stage":"search"}"#.utf8)
        )
        XCTAssertThrowsError(try client.decodeAssistantStreamEvent(malformed)) { error in
            guard case APIClientError.decoding = error else {
                return XCTFail("Expected decoding error, got \(error)")
            }
        }

        let failure = AssistantServerSentEvent(
            name: "error",
            data: Data(#"{"error":"provider_failed","message":"Search failed safely.","retryable":true,"extra":1}"#.utf8)
        )
        XCTAssertThrowsError(try client.decodeAssistantStreamEvent(failure)) { error in
            guard case let APIClientError.assistantStream(message, retryable) = error else {
                return XCTFail("Expected assistant stream error, got \(error)")
            }
            XCTAssertEqual(message, "Search failed safely.")
            XCTAssertTrue(retryable)
        }

        var parser = AssistantServerSentEventParser()
        let oversized = Data((
            "data: " + String(repeating: "x", count: AssistantServerSentEventParser.maximumEventBytes + 1)
        ).utf8)
        XCTAssertThrowsError(try parser.append(oversized)) { error in
            guard case AssistantServerSentEventParserError.eventTooLarge = error else {
                return XCTFail("Expected safe size error, got \(error)")
            }
        }
    }

    @MainActor
    func testAssistantViewModelOptimisticallySendsThenReconcilesCanonicalEnvelope() async throws {
        let service = AssistantServiceStub()
        let model = AssistantViewModel(
            configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"),
            scope: .mailbox,
            service: service
        )
        await model.startIfNeeded()

        let sendTask = Task { await model.send("Find my order") }
        await waitUntil { service.continuation != nil }
        XCTAssertEqual(model.messages.last?.text, "Find my order")
        XCTAssertTrue(model.messages.last?.id.hasPrefix("optimistic-user-") == true)
        XCTAssertTrue(model.isSending)

        service.continuation?.yield(.accepted(AssistantStreamAccepted(runId: "run-1", userMessageId: "user-1")))
        await waitUntil { model.messages.last?.id == "user-1" }
        service.continuation?.yield(.progress(AssistantStreamProgress(stage: "search", label: "Searching mail")))
        await waitUntil { model.progress?.stage == "search" }
        XCTAssertEqual(model.progress?.label, "Searching mail")

        let completed = service.envelope(messages: [
            AssistantMessage(id: "user-1", conversationId: "conversation-1", role: "user", text: "Find my order"),
            AssistantMessage(id: "answer-1", conversationId: "conversation-1", role: "assistant", text: "I found it."),
        ])
        service.continuation?.yield(.complete(completed))
        service.continuation?.finish()

        let sendSucceeded = await sendTask.value
        XCTAssertTrue(sendSucceeded)
        XCTAssertEqual(model.messages.map(\.id), ["user-1", "answer-1"])
        XCTAssertEqual(model.messages.filter { $0.role == "user" }.count, 1)
        XCTAssertEqual(model.canonicalResponseRevision, 1)
        XCTAssertNil(model.progress)
    }

    @MainActor
    func testAssistantViewModelDoesNotTreatDraftWithoutProposalAsWorking() {
        let model = AssistantViewModel(
            configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"),
            scope: .email,
            account: "me@example.com",
            emailItemID: "email-1",
            service: AssistantServiceStub()
        )

        XCTAssertFalse(model.isProposalWorking(nil))
    }

    @MainActor
    func testAssistantViewModelPreparesStoredDraftForExplicitConfirmation() async throws {
        let service = AssistantServiceStub()
        service.draftSendEnvelope = try JSONDecoder().decode(
            AssistantConversationEnvelope.self,
            from: Data(#"""
            {
              "conversation":{"id":"conversation-1","scope":"email","account":"me@example.com","emailItemId":"email-1"},
              "messages":[{
                "id":"proposal-message","conversationId":"conversation-1","role":"assistant",
                "text":"Review the exact draft below, then confirm to send it.",
                "draft":{"kind":"reply","to":["sender@example.com"],"cc":[],"bcc":["archive@example.com"],"subject":"Re: Hello","body":"Thanks."},
                "proposal":{"id":"proposal-1","tool":"mail.send_reply","risk":"outbound","summary":"Send this reply","arguments":{},"confirmationDigest":"digest-1","status":"pending"}
              }]
            }
            """#.utf8)
        )
        let model = AssistantViewModel(
            configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"),
            scope: .email,
            account: "me@example.com",
            emailItemID: "email-1",
            service: service
        )
        await model.startIfNeeded()

        let proposal = await model.proposeDraftSend(messageID: "draft-message")

        XCTAssertEqual(proposal?.id, "proposal-1")
        XCTAssertEqual(model.messages.last?.draft?.bcc, ["archive@example.com"])
        XCTAssertEqual(service.draftSendMessageIDs, ["draft-message"])
        XCTAssertEqual(service.draftSendIdempotencyKeys.count, 1)
        XCTAssertFalse(service.draftSendIdempotencyKeys[0].isEmpty)
    }

    @MainActor
    func testAssistantViewModelRollsBackPreAcceptedFailureAndReusesIdempotencyKey() async throws {
        let service = AssistantServiceStub()
        let model = AssistantViewModel(
            configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"),
            scope: .mailbox,
            service: service
        )
        await model.startIfNeeded()

        let first = Task { await model.send("Find my EIN") }
        await waitUntil { service.continuation != nil }
        let optimisticID = try XCTUnwrap(model.messages.last?.id)
        service.continuation?.finish(throwing: AssistantServiceStub.StubError.failed)
        let firstSucceeded = await first.value
        XCTAssertFalse(firstSucceeded)
        XCTAssertTrue(model.messages.isEmpty)
        XCTAssertTrue(model.shouldRestoreFailedComposerText)
        let firstKey = try XCTUnwrap(service.idempotencyKeys.first)

        service.continuation = nil
        let retry = Task { await model.send("Find my EIN") }
        await waitUntil { service.idempotencyKeys.count == 2 && service.continuation != nil }
        XCTAssertEqual(service.idempotencyKeys[1], firstKey)
        XCTAssertEqual(model.messages.last?.id, optimisticID)
        service.continuation?.yield(.complete(service.envelope(messages: [
            AssistantMessage(id: "user-ein", role: "user", text: "Find my EIN"),
            AssistantMessage(id: "answer-ein", role: "assistant", text: "Here it is."),
        ])))
        service.continuation?.finish()
        let retrySucceeded = await retry.value
        XCTAssertTrue(retrySucceeded)
    }

    @MainActor
    func testAssistantViewModelAcceptedEOFBlocksNewIntentAndRetriesOriginalKey() async throws {
        let service = AssistantServiceStub()
        service.recoveryError = AssistantServiceStub.StubError.failed
        let model = AssistantViewModel(
            configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"),
            scope: .mailbox,
            service: service
        )
        await model.startIfNeeded()

        let first = Task { await model.send("Locate order 42") }
        await waitUntil { service.continuation != nil }
        service.continuation?.yield(.accepted(AssistantStreamAccepted(runId: "run-42", userMessageId: "user-42")))
        service.continuation?.finish()
        let firstSucceeded = await first.value
        XCTAssertFalse(firstSucceeded)
        XCTAssertEqual(model.messages.last?.id, "user-42")
        XCTAssertTrue(model.hasIndeterminateMessageAttempt)
        XCTAssertTrue(model.isWorking)
        XCTAssertEqual(service.recoveryRequests, 1)
        let firstKey = try XCTUnwrap(service.idempotencyKeys.first)

        let differentRequestSucceeded = await model.send("Start a different request")
        XCTAssertFalse(differentRequestSucceeded)
        XCTAssertEqual(service.idempotencyKeys.count, 1)

        service.continuation = nil
        let retry = Task { await model.retryIndeterminateMessage() }
        await waitUntil { service.idempotencyKeys.count == 2 && service.continuation != nil }
        XCTAssertEqual(service.idempotencyKeys[1], firstKey)
        service.continuation?.yield(.complete(service.envelope(messages: [
            AssistantMessage(id: "user-42", role: "user", text: "Locate order 42"),
            AssistantMessage(id: "answer-42", role: "assistant", text: "Order located."),
        ])))
        service.continuation?.finish()
        let retrySucceeded = await retry.value
        XCTAssertTrue(retrySucceeded)
        XCTAssertFalse(model.hasIndeterminateMessageAttempt)
    }

    @MainActor
    func testAssistantViewModelNewConversationClearsSupersededSendingState() async {
        let service = AssistantServiceStub()
        let model = AssistantViewModel(
            configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"),
            scope: .mailbox,
            service: service
        )
        await model.startIfNeeded()

        let supersededSend = Task { await model.send("Old request") }
        await waitUntil { service.continuation != nil }
        let oldContinuation = service.continuation
        XCTAssertTrue(model.isSending)

        await model.newConversation()
        XCTAssertFalse(model.isSending)
        XCTAssertFalse(model.isWorking)
        XCTAssertTrue(model.messages.isEmpty)

        oldContinuation?.finish()
        let oldSendSucceeded = await supersededSend.value
        XCTAssertFalse(oldSendSucceeded)
        XCTAssertFalse(model.isSending)
    }

    @MainActor
    func testAssistantViewModelRecoversCanonicalAnswerAfterAcceptedDisconnect() async {
        let service = AssistantServiceStub()
        service.recoveryEnvelope = service.envelope(messages: [
            AssistantMessage(id: "user-recovered", role: "user", text: "Recover this"),
            AssistantMessage(
                id: "answer-recovered",
                runId: "run-recovered",
                role: "assistant",
                text: "Recovered safely."
            ),
        ])
        let model = AssistantViewModel(
            configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"),
            scope: .mailbox,
            service: service
        )
        await model.startIfNeeded()

        let send = Task { await model.send("Recover this") }
        await waitUntil { service.continuation != nil }
        service.continuation?.yield(.accepted(AssistantStreamAccepted(
            runId: "run-recovered",
            userMessageId: "user-recovered"
        )))
        service.continuation?.finish()

        let succeeded = await send.value
        XCTAssertTrue(succeeded)
        XCTAssertEqual(model.messages.map(\.id), ["user-recovered", "answer-recovered"])
        XCTAssertFalse(model.hasIndeterminateMessageAttempt)
        XCTAssertEqual(service.recoveryRequests, 1)
    }

    @MainActor
    func testAssistantViewModelDoesNotRecoverFromAnotherRunsAnswer() async {
        let service = AssistantServiceStub()
        service.recoveryEnvelope = service.envelope(messages: [
            AssistantMessage(id: "user-target", role: "user", text: "Target request"),
            AssistantMessage(id: "answer-other", runId: "run-other", role: "assistant", text: "Other result"),
        ])
        let model = AssistantViewModel(
            configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"),
            scope: .mailbox,
            service: service
        )
        await model.startIfNeeded()

        let send = Task { await model.send("Target request") }
        await waitUntil { service.continuation != nil }
        service.continuation?.yield(.accepted(AssistantStreamAccepted(
            runId: "run-target",
            userMessageId: "user-target"
        )))
        service.continuation?.finish()

        let succeeded = await send.value
        XCTAssertFalse(succeeded)
        XCTAssertTrue(model.hasIndeterminateMessageAttempt)
        XCTAssertEqual(model.messages.last?.id, "user-target")
        XCTAssertFalse(model.messages.contains { $0.id == "answer-other" })
    }

    @MainActor
    func testAssistantViewModelLegacyAcceptedEventRemainsIndeterminateDuringRecovery() async {
        let service = AssistantServiceStub()
        service.recoveryEnvelope = service.envelope(messages: [
            AssistantMessage(id: "user-legacy", role: "user", text: "Legacy request"),
            AssistantMessage(id: "answer-unattributed", role: "assistant", text: "Unattributed result"),
        ])
        let model = AssistantViewModel(
            configuration: ServerConfiguration(serverURL: "https://winnow.test", token: "secret"),
            scope: .mailbox,
            service: service
        )
        await model.startIfNeeded()

        let send = Task { await model.send("Legacy request") }
        await waitUntil { service.continuation != nil }
        service.continuation?.yield(.accepted(AssistantStreamAccepted(
            runId: nil,
            userMessageId: "user-legacy"
        )))
        service.continuation?.finish()

        let succeeded = await send.value
        XCTAssertFalse(succeeded)
        XCTAssertTrue(model.hasIndeterminateMessageAttempt)
        XCTAssertFalse(model.messages.contains { $0.id == "answer-unattributed" })
    }

    @MainActor
    private func waitUntil(_ condition: @escaping @MainActor () -> Bool) async {
        for _ in 0..<200 {
            if condition() { return }
            await Task.yield()
        }
        XCTFail("Timed out waiting for asynchronous state")
    }
}

private final class AssistantServiceStub: AssistantService {
    enum StubError: Error { case failed }

    var continuation: AsyncThrowingStream<AssistantStreamEvent, Error>.Continuation?
    var idempotencyKeys: [String] = []
    var recoveryRequests = 0
    var recoveryError: Error?
    var recoveryEnvelope: AssistantConversationEnvelope?
    var draftSendEnvelope: AssistantConversationEnvelope?
    var draftSendMessageIDs: [String] = []
    var draftSendIdempotencyKeys: [String] = []

    private let conversation = AssistantConversation(id: "conversation-1", scope: .mailbox)

    func envelope(messages: [AssistantMessage]) -> AssistantConversationEnvelope {
        AssistantConversationEnvelope(conversation: conversation, messages: messages)
    }

    func createAssistantConversation(
        scope: AssistantScope,
        account: String?,
        emailItemID: String?
    ) async throws -> AssistantConversationEnvelope {
        envelope(messages: [])
    }

    func sendAssistantMessageStream(
        conversationID: String,
        text: String,
        idempotencyKey: String
    ) -> AsyncThrowingStream<AssistantStreamEvent, Error> {
        idempotencyKeys.append(idempotencyKey)
        return AsyncThrowingStream { continuation = $0 }
    }

    func assistantConversation(id: String) async throws -> AssistantConversationEnvelope {
        recoveryRequests += 1
        if let recoveryError { throw recoveryError }
        return recoveryEnvelope ?? envelope(messages: [])
    }

    func proposeAssistantDraftSend(
        conversationID: String,
        messageID: String,
        idempotencyKey: String
    ) async throws -> AssistantConversationEnvelope {
        draftSendMessageIDs.append(messageID)
        draftSendIdempotencyKeys.append(idempotencyKey)
        guard let draftSendEnvelope else { throw StubError.failed }
        return draftSendEnvelope
    }

    func confirmAssistantProposal(id: String, confirmationDigest: String) async throws -> AssistantConversationEnvelope {
        envelope(messages: [])
    }

    func completeAssistantClientProposal(id: String, confirmationDigest: String) async throws -> AssistantConversationEnvelope {
        envelope(messages: [])
    }

    func cancelAssistantProposal(id: String) async throws -> AssistantConversationEnvelope {
        envelope(messages: [])
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
