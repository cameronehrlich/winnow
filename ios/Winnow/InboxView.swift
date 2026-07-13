import SwiftUI

enum MailboxTab {
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

    @State private var account = ""
    @State private var searchText = ""
    @State private var navigationPath: [String] = []

    private var filteredEmails: [EmailItem] {
        model.emails.filter { item in
            let matchesAccount = account.isEmpty || item.account == account
            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            let matchesSearch = query.isEmpty || [
                item.subject,
                item.senderDisplayName,
                item.fromEmail,
                item.summary,
                item.action,
                item.deadline,
                item.impact,
            ].contains(where: { $0.localizedCaseInsensitiveContains(query) })
            return mailbox.includes(item) && matchesAccount && matchesSearch
        }
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            ZStack {
                AppBackdrop()
                List {
                    ForEach(filteredEmails) { item in
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
                            .tint(mailbox == .inbox ? WinnowDesign.amber : WinnowDesign.indigo)
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
            .navigationTitle(mailbox.title)
            .navigationDestination(for: String.self) { emailID in
                EmailDetailView(emailID: emailID)
            }
            .searchable(
                text: $searchText,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Sender, subject, or summary"
            )
            .toolbar {
                if #available(iOS 26.0, *) {
                    ToolbarItem(placement: .topBarLeading) {
                        WinnowMark(size: 32)
                    }
                    .sharedBackgroundVisibility(.hidden)
                } else {
                    ToolbarItem(placement: .topBarLeading) {
                        WinnowMark(size: 32)
                    }
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
            .onChange(of: model.navigationRequest) { _, request in
                guard let request,
                      request.mailboxState == mailbox.apiState else { return }
                navigationPath.append(request.emailID)
                model.consumeNavigation(request)
            }
        }
    }

    private var emptyTitle: String {
        if !searchText.isEmpty { return "No Matches" }
        return mailbox == .inbox ? "Inbox Clear" : "Nothing Archived Yet"
    }

    private var emptySymbol: String {
        if !searchText.isEmpty { return "magnifyingglass" }
        return mailbox == .inbox ? "checkmark.circle" : "archivebox"
    }

    private var emptyDescription: String {
        if !searchText.isEmpty { return "Try a different sender, subject, or summary." }
        return mailbox == .inbox
            ? "Nothing needs your attention right now."
            : "Messages handled by Winnow will appear here."
    }

    private func perform(_ action: EmailAction, on item: EmailItem) {
        Task { _ = await model.perform(action, on: item) }
    }
}

private struct EmailCard: View {
    let item: EmailItem
    let account: AccountStatus?
    let isPerforming: Bool
    let openAction: () -> Void

    var body: some View {
        Button(action: openAction) {
            ZStack(alignment: .trailing) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 9) {
                        ZStack(alignment: .bottomTrailing) {
                            SenderAvatar(
                                initials: item.senderInitials,
                                seed: item.fromEmail.isEmpty ? item.senderDisplayName : item.fromEmail,
                                size: 36
                            )
                            AccountAvatarBadge(account: account, size: 17)
                                .offset(x: 4, y: 4)
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
                    }

                    Text(item.subject)
                        .font(.subheadline.weight(item.isUnread ? .bold : .regular))
                        .foregroundStyle(item.isUnread ? .primary : .secondary)
                        .lineLimit(2)

                    if !item.summary.isEmpty || !item.snippet.isEmpty {
                        Text(item.summary.isEmpty ? item.snippet : item.summary)
                            .font(.footnote)
                            .foregroundStyle(item.isUnread ? .secondary : .tertiary)
                            .lineLimit(2)
                    }

                    if let action = item.meaningfulAction {
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: "arrow.turn.down.right")
                                .foregroundStyle(WinnowDesign.brightIndigo)
                            Text(action)
                                .font(.caption.weight(item.isUnread ? .semibold : .regular))
                                .foregroundStyle(item.isUnread ? .primary : .secondary)
                                .lineLimit(2)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.trailing, 78)

                VStack(alignment: .trailing, spacing: 0) {
                    if isPerforming {
                        ProgressView().controlSize(.small)
                    } else if let date = item.displayDate {
                        Text(date.relativeWinnowTime)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                    }
                    Spacer(minLength: 0)
                }
                .frame(width: 70, alignment: .trailing)
                .frame(maxHeight: .infinity, alignment: .top)

                VStack {
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 70, alignment: .trailing)
                        .accessibilityHidden(true)
                    Spacer(minLength: 0)
                }
            }
            .padding(.leading, 12)
            .padding(.trailing, 15)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows email details")
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
