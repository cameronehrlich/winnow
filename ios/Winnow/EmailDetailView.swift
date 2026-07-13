import SwiftUI
import UIKit

struct EmailDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    let emailID: String
    @State private var confirmUnsubscribe = false

    private var item: EmailItem? { model.email(id: emailID) }

    private var normalizedEmptyValues: Set<String> {
        ["", "n/a", "none", "none found", "not found", "unknown"]
    }

    var body: some View {
        ZStack {
            AppBackdrop()
            if let item {
                EmailAssistantThreadView(
                    configuration: model.configuration,
                    account: item.account,
                    emailItemID: item.id,
                    contextTitle: item.subject,
                    onMailboxChanged: { await model.refresh(silent: true) }
                ) {
                    VStack(spacing: 16) {
                        senderHeader(item)

                        if !item.summary.isEmpty {
                            InsightBlock(title: "Summary", symbol: "text.alignleft", text: item.summary, color: WinnowDesign.indigo)
                        }

                        if hasDetails(item) {
                            detailsCard(item)
                        }

                        actionsCard(item)

                        if !item.snippet.isEmpty, item.snippet != item.summary {
                            InsightBlock(title: "Message preview", symbol: "quote.opening", text: item.snippet, color: .secondary)
                        }

                        if item.unsubscribeState == "succeeded" {
                            InsightBlock(title: "Unsubscribed", symbol: "checkmark.circle.fill", text: "Winnow completed the unsubscribe request.", color: WinnowDesign.mint)
                        } else if item.unsubscribeState == "attempted" {
                            InsightBlock(title: "Manual step needed", symbol: "envelope.badge", text: "This sender requires an email-based unsubscribe. Open the message in Gmail to finish.", color: WinnowDesign.amber)
                        }
                    }
                }
                .confirmationDialog(
                    "Unsubscribe from this sender?",
                    isPresented: $confirmUnsubscribe,
                    titleVisibility: .visible
                ) {
                    Button("Unsubscribe", role: .destructive) {
                        Task { _ = await model.perform(.unsubscribe, on: item) }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Winnow will follow the sender’s unsubscribe link.")
                }
            } else {
                ContentUnavailableView("Email unavailable", systemImage: "envelope.badge")
            }
        }
        .navigationTitle("Email")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: emailID) {
            guard let item = model.email(id: emailID) else { return }
            await model.markReadWhenOpened(item)
        }
    }

    private func senderHeader(_ item: EmailItem) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 13) {
                ZStack(alignment: .bottomTrailing) {
                    SenderAvatar(initials: item.senderInitials, seed: item.fromEmail.isEmpty ? item.senderDisplayName : item.fromEmail, size: 52)
                    AccountAvatarBadge(account: model.account(email: item.account), size: 20)
                        .offset(x: 4, y: 4)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.senderDisplayName).font(.headline)
                    if !item.fromEmail.isEmpty { Text(item.fromEmail).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                CapsuleLabel(item.isArchived ? "Archived" : "Inbox", symbol: item.isArchived ? "archivebox" : "tray", color: item.isArchived ? WinnowDesign.amber : WinnowDesign.mint)
            }
            Text(item.subject)
                .font(.title2.bold())
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                AccountAvatarBadge(account: model.account(email: item.account), size: 18)
                Text(item.account)
                Spacer()
                if let date = item.displayDate { Text(date.formatted(date: .abbreviated, time: .shortened)) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .winnowCard()
    }

    private func openInGmail(_ item: EmailItem) {
        let accountID = model.account(email: item.account)?.gmailAppAccountId
        if UIApplication.shared.canOpenURL(GmailDestination.nativeAppURL),
           let nativeURL = item.nativeGmailURL(accountID: accountID) {
            openURL(nativeURL)
        } else if let webURL = item.gmailURL {
            openURL(webURL)
        }
    }

    @ViewBuilder
    private func detailsCard(_ item: EmailItem) -> some View {
        let rows = detailRows(item)
        VStack(spacing: 0) {
            ForEach(rows.indices, id: \.self) { index in
                if index > 0 { DetailDivider() }
                let row = rows[index]
                DetailRow(
                    label: row.label,
                    value: row.value,
                    symbol: row.symbol,
                    color: row.color,
                    trailingValue: row.trailingValue,
                    trailingAccessibilityLabel: row.trailingAccessibilityLabel
                )
            }
        }
        .winnowCard(padding: 4)
    }

    private func actionsCard(_ item: EmailItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ACTIONS")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)

            AdaptiveActionPair {
                Button {
                    Task { _ = await model.perform(item.isArchived ? .moveToInbox : .archive, on: item) }
                } label: {
                    DetailActionLabel(
                        title: item.isArchived ? "Move to Inbox" : "Archive",
                        symbol: item.isArchived ? "tray.and.arrow.down" : "archivebox"
                    )
                }
                .buttonStyle(.borderedProminent)
                .tint(WinnowDesign.indigo)
            } trailing: {
                Button {
                    Task { _ = await model.perform(item.isUnread ? .markRead : .markUnread, on: item) }
                } label: {
                    DetailActionLabel(
                        title: item.isUnread ? "Mark Read" : "Mark Unread",
                        symbol: item.isUnread ? "envelope.open" : "envelope.badge"
                    )
                }
                .buttonStyle(.bordered)
                .tint(WinnowDesign.indigo)
            }

            if item.gmailDestination != nil, item.canUnsubscribe {
                AdaptiveActionPair {
                    gmailButton(item)
                } trailing: {
                    unsubscribeButton
                }
            } else if item.gmailDestination != nil {
                gmailButton(item)
            } else if item.canUnsubscribe {
                unsubscribeButton
            }
        }
        .font(.subheadline.weight(.semibold))
        .winnowCard(padding: 14)
        .disabled(model.performingEmailIDs.contains(item.id))
    }

    private func gmailButton(_ item: EmailItem) -> some View {
        Button { openInGmail(item) } label: {
            DetailActionLabel(title: "Open in Gmail", symbol: "envelope.open.fill")
        }
        .buttonStyle(.bordered)
        .tint(WinnowDesign.indigo)
        .accessibilityHint("Opens this conversation in the \(item.account) Gmail account.")
    }

    private var unsubscribeButton: some View {
        Button(role: .destructive) { confirmUnsubscribe = true } label: {
            DetailActionLabel(title: "Unsubscribe", symbol: "person.crop.circle.badge.minus")
        }
        .buttonStyle(.bordered)
        .tint(WinnowDesign.rose)
    }

    private func hasDetails(_ item: EmailItem) -> Bool {
        !detailRows(item).isEmpty
    }

    private func detailRows(_ item: EmailItem) -> [DetailValue] {
        var rows: [DetailValue] = []
        if let action = item.meaningfulAction {
            rows.append(DetailValue(
                label: "Next step",
                value: action,
                symbol: "arrow.turn.down.right",
                color: WinnowDesign.brightIndigo
            ))
        }
        if let deadline = meaningfulDeadline(item.deadline) {
            rows.append(DetailValue(label: "Deadline", value: deadline, symbol: "clock", color: WinnowDesign.amber))
        }
        if let impact = meaningfulImpact(item.impact) {
            rows.append(DetailValue(label: "Impact", value: impact, symbol: "bolt", color: WinnowDesign.rose))
        }
        if let handling = meaningfulValue(item.handling) {
            rows.append(DetailValue(
                label: "Handling",
                value: humanizedHandling(handling),
                symbol: "hand.raised",
                color: WinnowDesign.mint,
                trailingValue: item.confidence.map { "\($0)%" },
                trailingAccessibilityLabel: item.confidence.map { "\($0) percent confidence" }
            ))
        }
        return rows
    }

    private func meaningfulDeadline(_ value: String) -> String? {
        meaningfulValue(value, additionallyIgnoring: ["no deadline", "no deadline found"])
    }

    private func meaningfulImpact(_ value: String) -> String? {
        meaningfulValue(value, additionallyIgnoring: ["no impact", "no impact found"])
    }

    private func meaningfulValue(_ value: String, additionallyIgnoring ignored: Set<String> = []) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.lowercased()
        guard !normalizedEmptyValues.union(ignored).contains(normalized) else { return nil }
        return trimmed
    }

    private func humanizedHandling(_ value: String) -> String {
        switch value.lowercased() {
        case "archive": "Archive"
        case "keep": "Keep in Inbox"
        case "reply": "Reply"
        case "task": "Follow up as a task"
        case "calendar": "Add to calendar"
        case "read later": "Read later"
        default:
            value
                .replacingOccurrences(of: "_", with: " ")
                .replacingOccurrences(of: "-", with: " ")
                .capitalized
        }
    }
}

private struct DetailValue {
    let label: String
    let value: String
    let symbol: String
    let color: Color
    var trailingValue: String? = nil
    var trailingAccessibilityLabel: String? = nil
}

private struct InsightBlock: View {
    let title: String
    let symbol: String
    let text: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Label(title.uppercased(), systemImage: symbol)
                .font(.caption2.weight(.bold))
                .foregroundStyle(color)
            Text(text)
                .font(.body)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .winnowCard()
    }
}

private struct DetailRow: View {
    let label: String
    let value: String
    let symbol: String
    let color: Color
    var trailingValue: String? = nil
    var trailingAccessibilityLabel: String? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .foregroundStyle(color)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                Text(value).font(.subheadline.weight(.medium))
            }
            Spacer()
            if let trailingValue {
                Text(trailingValue)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel(trailingAccessibilityLabel ?? trailingValue)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}

private struct DetailDivider: View {
    var body: some View {
        Divider().padding(.leading, 46)
    }
}

private struct DetailActionLabel: View {
    let title: String
    let symbol: String

    var body: some View {
        Label(title, systemImage: symbol)
            .lineLimit(1)
            .minimumScaleFactor(0.82)
            .frame(maxWidth: .infinity, minHeight: 34)
    }
}

private struct AdaptiveActionPair<Leading: View, Trailing: View>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private let leading: Leading
    private let trailing: Trailing

    init(
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.leading = leading()
        self.trailing = trailing()
    }

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(spacing: 10) {
                leading
                trailing
            }
        } else {
            HStack(spacing: 10) {
                leading
                trailing
            }
        }
    }
}
