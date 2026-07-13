import SwiftUI

private enum MailboxFilter: String, CaseIterable, Identifiable {
    case inbox = "Inbox"
    case all = "All"
    case archived = "Archived"

    var id: String { rawValue }
}

struct InboxView: View {
    @EnvironmentObject private var model: AppModel
    @State private var filter: MailboxFilter = .inbox
    @State private var account = ""
    @State private var searchText = ""

    private var filteredEmails: [EmailItem] {
        model.emails.filter { item in
            let matchesMailbox = switch filter {
            case .inbox: !item.isArchived
            case .all: true
            case .archived: item.isArchived
            }
            let matchesAccount = account.isEmpty || item.account == account
            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            let matchesSearch = query.isEmpty || [item.subject, item.senderDisplayName, item.fromEmail, item.summary, item.action]
                .contains(where: { $0.localizedCaseInsensitiveContains(query) })
            return matchesMailbox && matchesAccount && matchesSearch
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackdrop()
                List {
                    Section {
                        Picker("Mailbox", selection: $filter) {
                            ForEach(MailboxFilter.allCases) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 10, trailing: 16))
                        .listRowBackground(Color.clear)
                    }

                    ForEach(filteredEmails) { item in
                        NavigationLink {
                            EmailDetailView(emailID: item.id)
                        } label: {
                            EmailCard(item: item, isPerforming: model.performingEmailIDs.contains(item.id))
                        }
                        .buttonStyle(.plain)
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button {
                                Task { _ = await model.perform(item.isArchived ? .moveToInbox : .archive, on: item) }
                            } label: {
                                Label(item.isArchived ? "Inbox" : "Archive", systemImage: item.isArchived ? "tray.and.arrow.down" : "archivebox")
                            }
                            .tint(item.isArchived ? WinnowDesign.indigo : WinnowDesign.amber)
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            Button {
                                Task { _ = await model.perform(item.isUnread ? .markRead : .markUnread, on: item) }
                            } label: {
                                Label(item.isUnread ? "Read" : "Unread", systemImage: item.isUnread ? "envelope.open" : "envelope.badge")
                            }
                            .tint(WinnowDesign.mint)
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .refreshable { await model.refresh() }

                if model.isLoading && model.emails.isEmpty {
                    ProgressView("Distilling your inbox…")
                        .padding(22)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                } else if filteredEmails.isEmpty {
                    ContentUnavailableView {
                        Label(emptyTitle, systemImage: emptySymbol)
                    } description: {
                        Text(emptyDescription)
                    } actions: {
                        Button("Refresh") { Task { await model.refresh() } }
                    }
                }
            }
            .navigationTitle("Inbox")
            .searchable(text: $searchText, prompt: "Sender, subject, or action")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    WinnowMark(size: 32)
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if model.accounts.count > 1 {
                        Menu {
                            Button("All Accounts") { account = "" }
                            Divider()
                            ForEach(model.accounts) { item in
                                Button(item.email) { account = item.email }
                            }
                        } label: {
                            Image(systemName: account.isEmpty ? "person.2" : "person.crop.circle")
                        }
                        .accessibilityLabel("Filter account")
                    }
                    ConnectionBadge(isOnline: model.isOnline, isRefreshing: model.isRefreshing)
                }
            }
        }
    }

    private var emptyTitle: String {
        if !searchText.isEmpty { return "No Matches" }
        return filter == .inbox ? "Inbox Clear" : "Nothing Here"
    }

    private var emptySymbol: String {
        if !searchText.isEmpty { return "magnifyingglass" }
        return filter == .inbox ? "checkmark.circle" : "tray"
    }

    private var emptyDescription: String {
        if !searchText.isEmpty { return "Try a different sender, subject, or action." }
        return filter == .inbox ? "Winnow has handled everything in this view." : "Pull down to check again."
    }
}

private struct EmailCard: View {
    let item: EmailItem
    let isPerforming: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack(spacing: 11) {
                SenderAvatar(initials: item.senderInitials, seed: item.fromEmail.isEmpty ? item.senderDisplayName : item.fromEmail)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        if item.isUnread {
                            Circle().fill(WinnowDesign.brightIndigo).frame(width: 7, height: 7)
                        }
                        Text(item.senderDisplayName)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                    }
                    Text(item.account)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if isPerforming {
                    ProgressView().controlSize(.small)
                } else if let date = item.displayDate {
                    Text(date.relativeWinnowTime)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            VStack(alignment: .leading, spacing: 7) {
                Text(item.subject)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                if !item.summary.isEmpty || !item.snippet.isEmpty {
                    Text(item.summary.isEmpty ? item.snippet : item.summary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }

            if !item.action.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "arrow.turn.down.right")
                        .foregroundStyle(WinnowDesign.brightIndigo)
                    Text(item.action)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                }
                .padding(11)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(WinnowDesign.indigo.opacity(0.075), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }

            if !item.deadline.isEmpty || !item.impact.isEmpty || item.lowConfidenceKept {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 7) {
                        if !item.deadline.isEmpty { CapsuleLabel(item.deadline, symbol: "clock", color: WinnowDesign.amber) }
                        if !item.impact.isEmpty { CapsuleLabel(item.impact, symbol: "bolt", color: WinnowDesign.rose) }
                        if item.lowConfidenceKept { CapsuleLabel("Review", symbol: "eye", color: WinnowDesign.indigo) }
                    }
                }
            }
        }
        .winnowCard()
        .opacity(isPerforming ? 0.72 : 1)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
