import SwiftUI

struct EmailDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    let emailID: String
    @State private var confirmUnsubscribe = false

    private var item: EmailItem? { model.email(id: emailID) }

    var body: some View {
        ZStack {
            AppBackdrop()
            if let item {
                ScrollView {
                    VStack(spacing: 16) {
                        senderHeader(item)

                        if !item.summary.isEmpty {
                            InsightBlock(title: "Summary", symbol: "text.alignleft", text: item.summary, color: WinnowDesign.indigo)
                        }
                        if !item.action.isEmpty {
                            InsightBlock(title: "Next action", symbol: "arrow.turn.down.right", text: item.action, color: WinnowDesign.brightIndigo)
                        }

                        if !item.deadline.isEmpty || !item.impact.isEmpty || !item.handling.isEmpty {
                            VStack(spacing: 0) {
                                if !item.deadline.isEmpty { DetailRow(label: "Deadline", value: item.deadline, symbol: "clock", color: WinnowDesign.amber) }
                                if !item.impact.isEmpty { DetailRow(label: "Impact", value: item.impact, symbol: "bolt", color: WinnowDesign.rose) }
                                if !item.handling.isEmpty { DetailRow(label: "Handling", value: item.handling, symbol: "hand.raised", color: WinnowDesign.mint) }
                            }
                            .winnowCard(padding: 4)
                        }

                        if !item.reason.isEmpty || item.confidence != nil {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("WINNOW'S READ").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                                if !item.reason.isEmpty { Text(item.reason).font(.subheadline) }
                                if let confidence = item.confidence {
                                    HStack {
                                        Text("Confidence").foregroundStyle(.secondary)
                                        Spacer()
                                        Text("\(confidence)%").fontWeight(.semibold)
                                    }
                                    .font(.subheadline)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .winnowCard()
                        }

                        if !item.snippet.isEmpty, item.snippet != item.summary {
                            InsightBlock(title: "Message preview", symbol: "quote.opening", text: item.snippet, color: .secondary)
                        }

                        if item.unsubscribeState == "succeeded" {
                            InsightBlock(title: "Unsubscribed", symbol: "checkmark.circle.fill", text: "Winnow completed the unsubscribe request.", color: WinnowDesign.mint)
                        } else if item.unsubscribeState == "attempted" {
                            InsightBlock(title: "Manual step needed", symbol: "envelope.badge", text: "This sender requires an email-based unsubscribe. Open the message in Gmail to finish.", color: WinnowDesign.amber)
                        } else if item.canUnsubscribe {
                            Button(role: .destructive) { confirmUnsubscribe = true } label: {
                                Label("Unsubscribe from sender", systemImage: "person.crop.circle.badge.minus")
                                    .font(.subheadline.weight(.semibold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 13)
                            }
                            .buttonStyle(.bordered)
                            .tint(WinnowDesign.rose)
                        }

                        Spacer(minLength: 90)
                    }
                    .padding(16)
                }
                .safeAreaInset(edge: .bottom) { actionBar(item) }
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
                SenderAvatar(initials: item.senderInitials, seed: item.fromEmail.isEmpty ? item.senderDisplayName : item.fromEmail, size: 52)
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
                Label(item.account, systemImage: "person.crop.circle")
                Spacer()
                if let date = item.displayDate { Text(date.formatted(date: .abbreviated, time: .shortened)) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if let gmailURL = item.gmailURL {
                Button { openURL(gmailURL) } label: {
                    Label("Open in Gmail", systemImage: "arrow.up.right.square")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .winnowCard()
    }

    private func actionBar(_ item: EmailItem) -> some View {
        HStack(spacing: 12) {
            Button {
                Task { _ = await model.perform(item.isUnread ? .markRead : .markUnread, on: item) }
            } label: {
                Label(item.isUnread ? "Read" : "Unread", systemImage: item.isUnread ? "envelope.open" : "envelope.badge")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

            Button {
                Task { _ = await model.perform(item.isArchived ? .moveToInbox : .archive, on: item) }
            } label: {
                Label(item.isArchived ? "Inbox" : "Archive", systemImage: item.isArchived ? "tray.and.arrow.down" : "archivebox")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
        .disabled(model.performingEmailIDs.contains(item.id))
    }
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
        }
        .padding(13)
    }
}
