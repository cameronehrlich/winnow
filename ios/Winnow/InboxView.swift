import SwiftUI

enum MailboxTab: Hashable {
    case inbox
    case archived

    var title: String {
        switch self {
        case .inbox: "Inbox"
        case .archived: "Archived"
        }
    }

    var apiState: String {
        switch self {
        case .inbox: "inbox"
        case .archived: "archived"
        }
    }

    var primaryAction: EmailAction {
        switch self {
        case .inbox: .archive
        case .archived: .moveToInbox
        }
    }

    var swipeEdge: HorizontalEdge {
        switch self {
        case .inbox: .leading
        case .archived: .trailing
        }
    }

    func includes(_ item: EmailItem) -> Bool {
        switch self {
        case .inbox: !item.isArchived
        case .archived: item.isArchived
        }
    }
}

struct InboxView: View {
    @EnvironmentObject private var model: AppModel
    let mailbox: MailboxTab
    let openSettings: () -> Void
    let openStats: () -> Void

    @State private var account = ""
    @State private var searchText = ""
    @State private var navigationPath: [String] = []

    private var searchQuery: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filteredEmails: [EmailItem] {
        return model.emails.filter { item in
            let matchesAccount = account.isEmpty || item.account == account
            let matchesQuery = searchQuery.isEmpty || [
                item.displaySubject ?? "",
                item.senderDisplayName,
                item.fromEmail,
                item.summary,
                item.snippet,
                item.action,
                item.deadline,
                item.impact,
            ].contains(where: { $0.localizedCaseInsensitiveContains(searchQuery) })
            return mailbox.includes(item) && matchesAccount && matchesQuery
        }
    }

    private var newItemsDividerIndex: Int? {
        guard searchQuery.isEmpty,
              let cutoff = model.newItemsCutoff(for: mailbox),
              let firstPreviouslySeen = filteredEmails.firstIndex(where: {
                  ($0.displayDate ?? .distantPast) <= cutoff
              }),
              firstPreviouslySeen > 0
        else { return nil }
        return firstPreviouslySeen
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            ZStack {
                AppBackdrop()
                List {
                    ForEach(Array(filteredEmails.enumerated()), id: \.element.id) { index, item in
                        if index == newItemsDividerIndex {
                            NewItemsDivider()
                                .listRowInsets(EdgeInsets(top: 4, leading: 18, bottom: 4, trailing: 18))
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                        }
                        EmailCard(
                            item: item,
                            account: model.account(email: item.account),
                            isPerforming: model.performingEmailIDs.contains(item.id),
                            openAction: { navigationPath.append(item.id) }
                        )
                        .listRowInsets(EdgeInsets(top: 5, leading: 14, bottom: 5, trailing: 14))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .swipeActions(edge: mailbox.swipeEdge, allowsFullSwipe: true) {
                            Button {
                                perform(mailbox.primaryAction, on: item)
                            } label: {
                                Label(mailbox.primaryAction.label, systemImage: mailbox.primaryAction.systemImage)
                            }
                            .tint(mailbox == .inbox ? WinnowDesign.amber : WinnowDesign.accent)
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .scrollDismissesKeyboard(.interactively)
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
            .navigationTitle(mailbox.title)
            .searchable(
                text: $searchText,
                placement: .navigationBarDrawer(displayMode: .automatic),
                prompt: "Sender, subject, or summary"
            )
            .navigationDestination(for: String.self) { emailID in
                EmailDetailView(emailID: emailID)
            }
            .toolbar {
                WinnowSettingsToolbarItem(action: openSettings)
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if model.accounts.count > 1 {
                        AccountFilterMenu(selection: $account, accounts: model.accounts)
                    }
                    WinnowStatusButton(
                        isOnline: model.isOnline,
                        isRefreshing: model.isRefreshing,
                        action: openStats
                    )
                }
            }
            .onChange(of: model.navigationRequest) { _, request in
                guard let request,
                      request.mailboxState == mailbox.apiState else { return }
                navigationPath.append(request.emailID)
                model.consumeNavigation(request)
            }
        }
    }

    private var emptyTitle: String {
        if !searchQuery.isEmpty { return "No Results" }
        return mailbox == .inbox ? "Inbox Clear" : "Nothing Archived Yet"
    }

    private var emptySymbol: String {
        if !searchQuery.isEmpty { return "magnifyingglass" }
        return mailbox == .inbox ? "checkmark.circle" : "archivebox"
    }

    private var emptyDescription: String {
        if !searchQuery.isEmpty {
            return "No messages in \(mailbox.title.lowercased()) match “\(searchQuery)”."
        }
        return mailbox == .inbox
            ? "Nothing needs your attention right now."
            : "Messages handled by Winnow will appear here."
    }

    private func perform(_ action: EmailAction, on item: EmailItem) {
        Task { _ = await model.perform(action, on: item, optimisticDelay: .milliseconds(140)) }
    }
}

private struct NewItemsDivider: View {
    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(WinnowDesign.brightIndigo.opacity(0.45)).frame(height: 1)
            Text("New since last visit")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(WinnowDesign.brightIndigo)
                .fixedSize()
            Rectangle().fill(WinnowDesign.brightIndigo.opacity(0.45)).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Earlier messages start here")
    }
}

struct EmailCard: View {
    let item: EmailItem
    let account: AccountStatus?
    let isPerforming: Bool
    let openAction: () -> Void

    var body: some View {
        Button(action: openAction) {
            ZStack(alignment: .trailing) {
                VStack(alignment: .leading, spacing: 7) {
                    HStack(alignment: .top, spacing: 8) {
                        ZStack(alignment: .bottomTrailing) {
                            SenderAvatar(
                                initials: item.senderInitials,
                                seed: item.fromEmail.isEmpty ? item.senderDisplayName : item.fromEmail,
                                size: 32
                            )
                            AccountAvatarBadge(account: account, size: 15)
                                .offset(x: 3, y: 3)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 5) {
                                if item.isUnread {
                                    Circle().fill(WinnowDesign.brightIndigo).frame(width: 6, height: 6)
                                }
                                Text(item.senderDisplayName)
                                    .font(.subheadline.weight(item.isUnread ? .bold : .regular))
                                    .foregroundStyle(item.isUnread ? .primary : .secondary)
                                    .lineLimit(1)
                            }
                            Text(item.account)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 6)
                        if isPerforming {
                            ProgressView().controlSize(.small)
                        } else if let date = item.displayDate {
                            Text(date.relativeWinnowTime)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }
                    }

                    if let subject = item.displaySubject {
                        Text(subject)
                            .font(.subheadline.weight(item.isUnread ? .bold : .regular))
                            .foregroundStyle(item.isUnread ? .primary : .secondary)
                            .lineLimit(2)
                    }

                    if !item.summary.isEmpty || !item.snippet.isEmpty {
                        Text(item.summary.isEmpty ? item.snippet : item.summary)
                            .font(.footnote)
                            .foregroundStyle(item.isUnread ? .secondary : .tertiary)
                            .lineLimit(3)
                    }

                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 30)

                VStack {
                    Spacer(minLength: 0)
                    Image(systemName: item.isConversation ? "chevron.right.circle" : "chevron.right")
                        .font(.system(size: item.isConversation ? 20 : 13, weight: .semibold))
                        .foregroundStyle(item.isConversation ? WinnowDesign.accent : Color(.tertiaryLabel))
                        .frame(width: 20, alignment: .trailing)
                        .accessibilityHidden(true)
                    Spacer(minLength: 0)
                }
            }
            .padding(.leading, 12)
            .padding(.trailing, 15)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(item.isConversation ? "Threaded conversation" : "Single message")
        .accessibilityHint(item.isConversation ? "Shows conversation details" : "Shows email details")
        .background(.background, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.primary.opacity(0.07), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.04), radius: 10, y: 3)
        .opacity(isPerforming ? 0.68 : 1)
        .disabled(isPerforming)
    }
}
