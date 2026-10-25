import SwiftUI
import QuickLook

struct GmailDraftReference: Codable, Hashable, Identifiable {
    let account: String
    let draftId: String
    var id: String { account + "|" + draftId }
}

struct GmailDraftListResponse: Decodable {
    let items: [GmailDraft]
    let nextCursor: String?
    let unavailableAccounts: [String]
}

struct GmailDraftEnvelope: Decodable { let draft: GmailDraft }
struct GmailDraftSendResponse: Decodable { let ok: Bool; let messageId: String }
struct GmailDraftUpdate: Encodable { let revision: String; let fields: GmailDraftFields }
struct GmailDraftSend: Encodable { let revision: String; let idempotencyKey: String; let confirmed: Bool }

struct GmailDraft: Decodable, Identifiable {
    let account: String
    let draftId: String
    let messageId: String
    let threadId: String
    let from: String
    let to: String
    let cc: String
    let bcc: String
    let subject: String
    let snippet: String
    let date: String
    let internalDate: String
    let body: String
    let htmlBody: String
    let attachments: [EmailAttachment]
    let revision: String
    let editable: Bool
    let sendable: Bool

    var reference: GmailDraftReference { .init(account: account, draftId: draftId) }
    var id: String { reference.id }
    var displayDate: Date? { EmailTimestamp.parse(internalDate) ?? EmailTimestamp.parse(date) }
    var recipientSummary: String {
        let recipients = EmailParticipant.parseHeader([to, cc, bcc].joined(separator: ", "))
        guard let first = recipients.first else { return "No recipients" }
        return first.displayName + (recipients.count > 1 ? " +\(recipients.count - 1)" : "")
    }
    var gmailURL: URL? {
        var components = URLComponents(string: "https://mail.google.com/mail/u/")
        components?.queryItems = [URLQueryItem(name: "authuser", value: account)]
        components?.fragment = "drafts/\(threadId)"
        return components?.url
    }
    var fields: GmailDraftFields {
        .init(from: EmailParticipant.parseHeader(from).first?.emailAddress ?? from,
              to: Self.recipientEntries(to), cc: Self.recipientEntries(cc), bcc: Self.recipientEntries(bcc),
              subject: subject, body: body)
    }

    // Preserve malformed input for server validation; never silently omit a
    // recipient while splitting quoted display names and semicolon lists.
    static func recipientEntries(_ text: String) -> [String] {
        var result: [String] = []
        var current = ""
        var quoted = false
        var escaped = false
        for character in text {
            if escaped { current.append(character); escaped = false; continue }
            if quoted && character == "\\" { current.append(character); escaped = true; continue }
            if character == "\"" { quoted.toggle() }
            if !quoted && (character == "," || character == ";") {
                if !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { result.append(current.trimmingCharacters(in: .whitespacesAndNewlines)) }
                current = ""
            } else { current.append(character) }
        }
        if !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { result.append(current.trimmingCharacters(in: .whitespacesAndNewlines)) }
        return result
    }
}

struct GmailDraftFields: Encodable, Equatable {
    var from: String
    var to: [String]
    var cc: [String]
    var bcc: [String]
    var subject: String
    var body: String
}

struct GmailDraftEditBuffer {
    let original: GmailDraft
    let fields: GmailDraftFields
}

extension Notification.Name { static let winnowDraftsChanged = Notification.Name("winnowDraftsChanged") }

struct DraftsMailboxView: View {
    let openSettings: () -> Void
    @State private var path: [GmailDraftReference] = []
    var body: some View {
        NavigationStack(path: $path) {
            DraftsMailboxListView(openSettings: openSettings) { path.append($0.reference) }
                .navigationDestination(for: GmailDraftReference.self) { reference in
                    DraftDetailView(reference: reference)
                }
        }
    }
}

struct DraftsMailboxListView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    var showsSettingsButton = true
    var session: URLSession? = nil
    let openSettings: () -> Void
    let openDraft: (GmailDraft) -> Void
    @State private var account = ""
    @State private var items: [GmailDraft] = []
    @State private var nextCursor: String?
    @State private var unavailableAccounts: [String] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var generation = 0
    @State private var scrollPosition: String?

    var body: some View {
        ZStack {
            AppBackdrop()
            List {
                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(WinnowDesign.amber)
                }
                if !unavailableAccounts.isEmpty {
                    Text("Couldn’t refresh: \(unavailableAccounts.joined(separator: ", ")). Pull to refresh.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(items) { draft in
                    Button { openDraft(draft) } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Label(draft.recipientSummary, systemImage: "square.and.pencil")
                                    .font(.headline).lineLimit(1)
                                Spacer(minLength: 4)
                                if let date = draft.displayDate {
                                    Text(date, style: .relative).font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                            Text(draft.subject.isEmpty ? "No subject" : draft.subject)
                                .font(.subheadline.weight(.medium)).lineLimit(2)
                            Text(draft.snippet).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                            HStack {
                                AccountAvatarBadge(account: model.account(email: draft.account), size: 18)
                                Text(verbatim: draft.account).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                if !draft.attachments.isEmpty { Label("\(draft.attachments.count)", systemImage: "paperclip") }
                                Image(systemName: "chevron.right")
                            }.font(.caption2).foregroundStyle(.secondary)
                        }
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .winnowCard(padding: 14)
                    }
                    .buttonStyle(.plain)
                    .id(draft.id)
                    .listRowInsets(EdgeInsets(top: 5, leading: 14, bottom: 5, trailing: 14))
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                }
                if nextCursor != nil {
                    Button("Load More Drafts") { Task { await load(more: true) } }.disabled(isLoading)
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden)
            .scrollPosition(id: $scrollPosition)
            .refreshable { await load() }
            if isLoading && items.isEmpty {
                ProgressView("Loading drafts…")
            } else if items.isEmpty && errorMessage == nil {
                ContentUnavailableView("No Drafts", systemImage: "square.and.pencil", description: Text("Drafts saved in Gmail or from Winnow replies appear here on all your devices."))
            }
        }
        .navigationTitle("Drafts")
        .toolbar {
            if showsSettingsButton { WinnowSettingsToolbarItem(action: openSettings) }
            ToolbarItem(placement: .topBarTrailing) {
                AccountFilterMenu(selection: $account, accounts: model.activeAccounts)
            }
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(isLoading).accessibilityLabel("Refresh drafts")
            }
        }
        .task(id: "\(model.configuration.serverURL)|\(account)") { items = []; nextCursor = nil; await load() }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { return }
                if scenePhase == .active && !isLoading { await load() }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await load() } }
        }
        .onReceive(NotificationCenter.default.publisher(for: .winnowDraftsChanged)) { _ in Task { await load() } }
    }

    @MainActor private func load(more: Bool = false) async {
        generation &+= 1
        let currentGeneration = generation
        isLoading = true
        defer { if generation == currentGeneration { isLoading = false } }
        do {
            let response = try await APIClient(configuration: model.configuration, session: session).drafts(account: account, cursor: more ? nextCursor : nil)
            guard !Task.isCancelled, currentGeneration == generation else { return }
            let incoming = response.items
            if more {
                let ids = Set(incoming.map(\.id))
                items = items.filter { !ids.contains($0.id) } + incoming
            } else { items = incoming }
            nextCursor = response.nextCursor
            unavailableAccounts = response.unavailableAccounts
            errorMessage = nil
        } catch {
            guard !Task.isCancelled, currentGeneration == generation else { return }
            errorMessage = error.localizedDescription
        }
    }
}

struct DraftDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let reference: GmailDraftReference
    var session: URLSession? = nil
    var showsCloseButton = false
    var onSent: () -> Void = {}
    @State private var draft: GmailDraft?
    @State private var isLoading = false
    @State private var isWorking = false
    @State private var isEditing = false
    @State private var errorMessage: String?
    @State private var to = ""
    @State private var cc = ""
    @State private var bcc = ""
    @State private var subject = ""
    @State private var bodyText = ""
    @State private var toFocused = false
    @State private var ccFocused = false
    @State private var bccFocused = false
    @State private var htmlHeight: CGFloat = 200
    @State private var reviewedDraft: GmailDraft?
    @State private var confirmsSend = false
    @State private var confirmsDiscardEdits = false
    @State private var sendKey = UUID().uuidString
    @State private var previewURL: URL?

    var body: some View {
        Group {
            if let draft {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        header(draft)
                        if let errorMessage { Label(errorMessage, systemImage: "exclamationmark.triangle").foregroundStyle(WinnowDesign.amber).font(.subheadline) }
                        if isEditing { editor(draft) }
                        else if !draft.htmlBody.isEmpty {
                            SafeEmailHTMLView(html: draft.htmlBody, contentHeight: $htmlHeight).frame(height: htmlHeight)
                        } else {
                            Text(EmailBodyLinks.render(draft.body.isEmpty ? "No message text" : draft.body))
                                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if !draft.attachments.isEmpty {
                            Divider()
                            Text("Attachments").font(.headline)
                            ForEach(draft.attachments) { attachment in
                                Button { Task { await openAttachment(attachment) } } label: {
                                    Label(attachment.displayName, systemImage: "paperclip").lineLimit(2)
                                }.disabled(isWorking)
                            }
                        }
                        if !draft.editable && !isEditing {
                            Text("Formatting, attachments, and reply headers are preserved when sent. To change this draft, edit it in Gmail, then reload here.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(20).frame(maxWidth: 900).frame(maxWidth: .infinity, alignment: .top)
                }
            } else if isLoading { ProgressView("Loading draft…") }
            else {
                ContentUnavailableView {
                    Label("Draft Unavailable", systemImage: "square.and.pencil")
                } description: { Text(errorMessage ?? "This draft may have been sent or removed in Gmail.") }
                actions: { Button("Reload") { Task { await load() } } }
            }
        }
        .navigationTitle(isEditing ? "Edit Draft" : "Draft")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(isEditing)
        .interactiveDismissDisabled(isEditing || isWorking)
        .background { AppBackdrop() }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if showsCloseButton && !isEditing { Button("Close") { dismiss() }.disabled(isWorking) }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let draft {
                    if isEditing {
                        Button("Cancel") { confirmsDiscardEdits = true }.disabled(isWorking)
                            .confirmationDialog("Discard unsaved changes?", isPresented: $confirmsDiscardEdits, titleVisibility: .visible) {
                                Button("Discard Changes", role: .destructive) {
                                    model.draftEditBuffers[reference] = nil
                                    isEditing = false; errorMessage = nil
                                    Task { await load() }
                                }
                                Button("Keep Editing", role: .cancel) {}
                            }
                        Button("Save") { Task { await save(draft) } }
                            .keyboardShortcut("s", modifiers: .command)
                            .disabled(isWorking || subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || bodyText.isEmpty)
                    } else {
                        Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                            .disabled(isWorking || isLoading).accessibilityLabel("Reload draft from Gmail")
                        if draft.editable {
                            Button("Edit") { beginEditing(draft) }.disabled(isWorking || isLoading)
                        } else if let url = draft.gmailURL {
                            Button("Edit in Gmail") { openURL(url) }.disabled(isWorking)
                        }
                        Button {
                            reviewedDraft = draft
                            confirmsSend = true
                        } label: { Label("Send", systemImage: "paperplane.fill") }
                        .keyboardShortcut(.return, modifiers: [.command, .shift])
                        .disabled(isWorking || isLoading || !draft.sendable)
                        .confirmationDialog("Send this draft?", isPresented: $confirmsSend, titleVisibility: .visible) {
                            Button("Send Email") { if let reviewedDraft { Task { await send(reviewedDraft) } } }
                            Button("Cancel", role: .cancel) {}
                        } message: {
                            if let reviewedDraft {
                                Text("From: \(reviewedDraft.from)\nTo: \(reviewedDraft.to)" + (reviewedDraft.cc.isEmpty ? "" : "\nCc: \(reviewedDraft.cc)") + (reviewedDraft.bcc.isEmpty ? "" : "\nBcc: \(reviewedDraft.bcc)") + "\n\(reviewedDraft.attachments.count) attachment(s)")
                            }
                        }
                    }
                }
            }
        }
        .task(id: reference) { await load() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await load() } }
        }
        .quickLookPreview($previewURL)
        .onDisappear {
            if isEditing, let draft {
                model.draftEditBuffers[reference] = GmailDraftEditBuffer(original: draft, fields: editorFields(draft))
            }
            if let previewURL { AttachmentPreviewFile.remove(previewURL) }
        }
    }

    private func header(_ draft: GmailDraft) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                AccountAvatarBadge(account: model.account(email: draft.account), size: 24)
                Text(verbatim: draft.account).lineLimit(1).truncationMode(.middle).foregroundStyle(.secondary)
                Spacer()
                CapsuleLabel("Not sent", symbol: "lock.fill", color: WinnowDesign.amber)
            }
            if !isEditing {
                Text(draft.subject.isEmpty ? "No subject" : draft.subject).font(.title2.bold()).textSelection(.enabled)
                address("From", draft.from)
                address("To", draft.to)
                if !draft.cc.isEmpty { address("Cc", draft.cc) }
                if !draft.bcc.isEmpty { address("Bcc", draft.bcc) }
            }
            Divider()
        }
    }
    private func address(_ title: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(title).foregroundStyle(.secondary).frame(width: 42, alignment: .leading)
            Text(verbatim: value.isEmpty ? "Not specified" : value).textSelection(.enabled)
        }.font(.subheadline)
    }
    private func editor(_ draft: GmailDraft) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            address("From", draft.from)
            Text("To").font(.caption).foregroundStyle(.secondary)
            EmailAddressField(text: $to, focused: $toFocused, configuration: model.configuration, account: draft.account, allowsMultiple: true)
            Text("Cc").font(.caption).foregroundStyle(.secondary)
            EmailAddressField(text: $cc, focused: $ccFocused, configuration: model.configuration, account: draft.account, allowsMultiple: true)
            Text("Bcc").font(.caption).foregroundStyle(.secondary)
            EmailAddressField(text: $bcc, focused: $bccFocused, configuration: model.configuration, account: draft.account, allowsMultiple: true)
            Divider()
            TextField("Subject", text: $subject).font(.headline)
            Divider()
            TextEditor(text: $bodyText).frame(minHeight: 300).scrollContentBackground(.hidden)
                .accessibilityLabel("Draft message")
            Text("Changes are saved to Gmail when you choose Save.").font(.caption).foregroundStyle(.secondary)
        }
    }
    private func beginEditing(_ draft: GmailDraft) {
        to = draft.to; cc = draft.cc; bcc = draft.bcc; subject = draft.subject; bodyText = draft.body
        isEditing = true; errorMessage = nil
    }
    @MainActor private func load() async {
        guard !isWorking, !isEditing else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let latest = try await APIClient(configuration: model.configuration, session: session).draft(reference)
            if let buffer = model.draftEditBuffers[reference] {
                draft = buffer.original
                to = buffer.fields.to.joined(separator: ", "); cc = buffer.fields.cc.joined(separator: ", ")
                bcc = buffer.fields.bcc.joined(separator: ", "); subject = buffer.fields.subject; bodyText = buffer.fields.body
                isEditing = true
                errorMessage = latest.revision == buffer.original.revision ? nil
                    : "Your unsaved text is preserved, but the Gmail draft changed elsewhere. Cancel to discard these local edits and reload the current version."
            } else {
                draft = latest; errorMessage = nil
            }
        } catch {
            errorMessage = error.localizedDescription
            draft = nil
        }
    }
    @MainActor private func save(_ original: GmailDraft) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        let fields = editorFields(original)
        do {
            draft = try await APIClient(configuration: model.configuration, session: session).saveDraft(reference, revision: original.revision, fields: fields)
            isEditing = false; errorMessage = nil; sendKey = UUID().uuidString
            model.draftEditBuffers[reference] = nil
            NotificationCenter.default.post(name: .winnowDraftsChanged, object: nil)
        } catch { errorMessage = error.localizedDescription }
    }
    private func editorFields(_ original: GmailDraft) -> GmailDraftFields {
        var fields = original.fields
        fields.to = GmailDraft.recipientEntries(to); fields.cc = GmailDraft.recipientEntries(cc); fields.bcc = GmailDraft.recipientEntries(bcc)
        fields.subject = subject; fields.body = bodyText
        return fields
    }
    @MainActor private func send(_ reviewed: GmailDraft) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let result = try await APIClient(configuration: model.configuration, session: session).sendDraft(reference, revision: reviewed.revision, idempotencyKey: sendKey)
            guard result.ok else { throw APIClientError.invalidResponse }
            NotificationCenter.default.post(name: .winnowDraftsChanged, object: nil)
            model.toast = ToastMessage(text: "Email sent", symbol: "paperplane.fill")
            Task { await model.refresh(silent: true) }
            onSent(); dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
    @MainActor private func openAttachment(_ attachment: EmailAttachment) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let data = try await APIClient(configuration: model.configuration, session: session).draftAttachmentData(reference, attachmentID: attachment.attachmentId)
            if let previewURL { AttachmentPreviewFile.remove(previewURL) }
            previewURL = try AttachmentPreviewFile.write(data, filename: attachment.displayName, mimeType: attachment.mimeType)
        } catch { errorMessage = error.localizedDescription }
    }
}
