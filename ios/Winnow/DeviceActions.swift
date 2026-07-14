import Contacts
import ContactsUI
import EventKit
import EventKitUI
import SwiftUI

struct DeviceActionSource: Equatable {
    let emailItemID: String
    let mailboxState: String
    let subject: String

    init?(proposal: AssistantProposal) {
        guard
            let source = proposal.arguments["source"]?.objectValue,
            let emailItemID = source["emailItemId"]?.stringValue,
            !emailItemID.isEmpty
        else { return nil }
        self.emailItemID = emailItemID
        mailboxState = source["mailboxState"]?.stringValue == "archived" ? "archived" : "inbox"
        subject = source["subject"]?.stringValue ?? ""
    }

    func backlink(proposalID: String) -> URL? {
        var components = URLComponents()
        components.scheme = "winnow"
        components.host = "email"
        components.queryItems = [
            URLQueryItem(name: "id", value: emailItemID),
            URLQueryItem(name: "mailbox", value: mailboxState),
            URLQueryItem(name: "proposal", value: proposalID),
        ]
        return components.url
    }

    func visibleBacklink() -> URL? {
        var components = URLComponents()
        components.scheme = "winnow"
        components.host = "email"
        components.queryItems = [URLQueryItem(name: "id", value: emailItemID)]
        return components.url
    }
}

enum ReminderNotes {
    static func withWinnowBacklink(_ notes: String, source: DeviceActionSource) -> String {
        let trimmedNotes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let backlink = source.visibleBacklink() else { return trimmedNotes }
        let linkSection = "Open in Winnow:\n\(backlink.absoluteString)"
        return trimmedNotes.isEmpty ? linkSection : "\(trimmedNotes)\n\n\(linkSection)"
    }
}

private struct ReminderDraft {
    let title: String
    let notes: String
    let dueAt: Date?

    init?(proposal: AssistantProposal) {
        guard
            proposal.tool == "device.create_reminder",
            let title = proposal.arguments["title"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
            !title.isEmpty
        else { return nil }
        self.title = title
        notes = proposal.arguments["notes"]?.stringValue ?? ""
        dueAt = proposal.arguments["dueAt"]?.stringValue.flatMap(DeviceActionDate.parse)
    }
}

private struct CalendarDraft {
    let title: String
    let startAt: Date
    let endAt: Date
    let isAllDay: Bool
    let location: String
    let notes: String

    init?(proposal: AssistantProposal) {
        guard
            proposal.tool == "device.create_calendar_event",
            let title = proposal.arguments["title"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
            !title.isEmpty,
            let startAt = proposal.arguments["startAt"]?.stringValue.flatMap(DeviceActionDate.parse),
            let endAt = proposal.arguments["endAt"]?.stringValue.flatMap(DeviceActionDate.parse),
            endAt > startAt
        else { return nil }
        self.title = title
        self.startAt = startAt
        self.endAt = endAt
        isAllDay = proposal.arguments["isAllDay"]?.boolValue ?? false
        location = proposal.arguments["location"]?.stringValue ?? ""
        notes = proposal.arguments["notes"]?.stringValue ?? ""
    }
}

enum DeviceActionDate {
    static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

@MainActor
private final class DeviceActionStore {
    static let shared = DeviceActionStore()
    let eventStore = EKEventStore()

    func requestReminderAccess() async throws -> Bool {
        try await withCheckedThrowingContinuation { continuation in
            eventStore.requestFullAccessToReminders { granted, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: granted) }
            }
        }
    }

    func requestCalendarAccess() async throws -> Bool {
        try await withCheckedThrowingContinuation { continuation in
            eventStore.requestFullAccessToEvents { granted, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: granted) }
            }
        }
    }

    func reminderCalendars() -> [EKCalendar] {
        eventStore.calendars(for: .reminder).filter(\.allowsContentModifications)
    }

    func reminderExists(with backlink: URL) async throws -> Bool {
        try await withCheckedThrowingContinuation { continuation in
            let predicate = eventStore.predicateForReminders(in: nil)
            eventStore.fetchReminders(matching: predicate) { reminders in
                continuation.resume(returning: reminders?.contains(where: { $0.url == backlink }) == true)
            }
        }
    }

    func calendarEventExists(with backlink: URL, near start: Date, end: Date) -> Bool {
        let day: TimeInterval = 86_400
        let predicate = eventStore.predicateForEvents(
            withStart: start.addingTimeInterval(-day),
            end: end.addingTimeInterval(day),
            calendars: nil
        )
        return eventStore.events(matching: predicate).contains { $0.url == backlink }
    }
}

struct DeviceProposalReviewView: View {
    let proposal: AssistantProposal
    let isWorking: Bool
    let complete: () -> Void
    let cancel: () -> Void
    let selectedContact: (_ name: String, _ email: String) -> Void

    var body: some View {
        switch proposal.tool {
        case "device.create_reminder":
            ReminderProposalView(proposal: proposal, isWorking: isWorking, complete: complete, cancel: cancel)
        case "device.create_calendar_event":
            CalendarProposalView(proposal: proposal, isWorking: isWorking, complete: complete, cancel: cancel)
        case "device.pick_contact":
            ContactProposalView(proposal: proposal, selectedContact: selectedContact, cancel: cancel)
        default:
            ContentUnavailableView("Unsupported action", systemImage: "exclamationmark.triangle")
        }
    }
}

private struct ReminderProposalView: View {
    @Environment(\.dismiss) private var dismiss
    let proposal: AssistantProposal
    let isWorking: Bool
    let complete: () -> Void
    let cancel: () -> Void

    @State private var title: String
    @State private var notes: String
    @State private var hasDueDate: Bool
    @State private var dueAt: Date
    @State private var calendars: [EKCalendar] = []
    @State private var selectedCalendarID = ""
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var locallySaved = false
    @State private var errorMessage: String?

    init(proposal: AssistantProposal, isWorking: Bool, complete: @escaping () -> Void, cancel: @escaping () -> Void) {
        self.proposal = proposal
        self.isWorking = isWorking
        self.complete = complete
        self.cancel = cancel
        let draft = ReminderDraft(proposal: proposal)
        _title = State(initialValue: draft?.title ?? "")
        _notes = State(initialValue: draft?.notes ?? "")
        _hasDueDate = State(initialValue: draft?.dueAt != nil)
        _dueAt = State(initialValue: draft?.dueAt ?? Date().addingTimeInterval(3_600))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Reminder") {
                    TextField("Title", text: $title, axis: .vertical)
                    TextField("Notes", text: $notes, axis: .vertical).lineLimit(2...6)
                }
                Section {
                    Toggle("Due date and alert", isOn: $hasDueDate)
                    if hasDueDate {
                        DatePicker("Due", selection: $dueAt)
                    }
                }
                if calendars.count > 1 {
                    Section("List") {
                        Picker("Reminder list", selection: $selectedCalendarID) {
                            ForEach(calendars, id: \.calendarIdentifier) { calendar in
                                Text(calendar.title).tag(calendar.calendarIdentifier)
                            }
                        }
                    }
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
                Section {
                    Button {
                        Task { await save() }
                    } label: {
                        HStack {
                            Spacer()
                            if isSaving || isWorking { ProgressView().padding(.trailing, 4) }
                            Text(locallySaved ? "Finish" : "Add Reminder")
                            Spacer()
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isLoading || isSaving || isWorking)
                    Button("Cancel proposal", role: .destructive, action: cancel).disabled(isSaving || isWorking)
                }
            }
            .navigationTitle("Review Reminder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Close") { dismiss() }.disabled(isSaving || isWorking) } }
            .task { await prepare() }
            .interactiveDismissDisabled(isSaving || isWorking)
        }
    }

    private func prepare() async {
        guard let backlink = DeviceActionSource(proposal: proposal)?.backlink(proposalID: proposal.id) else {
            errorMessage = "This proposal is missing its source email."
            isLoading = false
            return
        }
        do {
            guard try await DeviceActionStore.shared.requestReminderAccess() else {
                errorMessage = "Allow Reminders access in Settings to use this action."
                isLoading = false
                return
            }
            calendars = DeviceActionStore.shared.reminderCalendars()
            selectedCalendarID = DeviceActionStore.shared.eventStore.defaultCalendarForNewReminders()?.calendarIdentifier
                ?? calendars.first?.calendarIdentifier
                ?? ""
            locallySaved = try await DeviceActionStore.shared.reminderExists(with: backlink)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func save() async {
        guard let source = DeviceActionSource(proposal: proposal),
              let backlink = source.backlink(proposalID: proposal.id) else { return }
        if locallySaved { complete(); return }
        guard let calendar = calendars.first(where: { $0.calendarIdentifier == selectedCalendarID })
                ?? DeviceActionStore.shared.eventStore.defaultCalendarForNewReminders()
                ?? calendars.first else {
            errorMessage = "No writable Reminders list is available."
            return
        }
        isSaving = true
        errorMessage = nil
        do {
            if try await DeviceActionStore.shared.reminderExists(with: backlink) {
                locallySaved = true
                complete()
                isSaving = false
                return
            }
            let reminder = EKReminder(eventStore: DeviceActionStore.shared.eventStore)
            reminder.calendar = calendar
            reminder.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
            reminder.notes = ReminderNotes.withWinnowBacklink(notes, source: source)
            reminder.url = backlink
            if hasDueDate {
                var components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: dueAt)
                components.calendar = .current
                components.timeZone = .current
                reminder.dueDateComponents = components
                reminder.addAlarm(EKAlarm(absoluteDate: dueAt))
            }
            try DeviceActionStore.shared.eventStore.save(reminder, commit: true)
            locallySaved = true
            complete()
        } catch {
            errorMessage = error.localizedDescription
        }
        isSaving = false
    }
}

private struct CalendarProposalView: View {
    @Environment(\.dismiss) private var dismiss
    let proposal: AssistantProposal
    let isWorking: Bool
    let complete: () -> Void
    let cancel: () -> Void
    @State private var event: EKEvent?
    @State private var locallySaved = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if locallySaved {
                NavigationStack {
                    ContentUnavailableView {
                        Label("Added to Calendar", systemImage: "calendar.badge.checkmark")
                    } description: {
                        Text("The event is saved. Finish to update this Winnow conversation.")
                    } actions: {
                        Button(isWorking ? "Finishing…" : "Finish", action: complete)
                            .buttonStyle(.borderedProminent)
                            .disabled(isWorking)
                    }
                }
            } else if let event {
                CalendarEventEditor(event: event) { action in
                    if action == .saved {
                        locallySaved = true
                        self.event = nil
                        complete()
                    } else {
                        dismiss()
                    }
                }
                .ignoresSafeArea()
            } else if let errorMessage {
                NavigationStack {
                    ContentUnavailableView("Calendar unavailable", systemImage: "calendar.badge.exclamationmark", description: Text(errorMessage))
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) { Button("Cancel proposal", role: .destructive, action: cancel) }
                        }
                }
            } else {
                ProgressView("Preparing Calendar…")
            }
        }
        .task { await prepare() }
        .interactiveDismissDisabled(isWorking)
    }

    private func prepare() async {
        guard event == nil, errorMessage == nil, let draft = CalendarDraft(proposal: proposal),
              let source = DeviceActionSource(proposal: proposal),
              let backlink = source.backlink(proposalID: proposal.id) else {
            if event == nil { errorMessage = "This calendar proposal is incomplete." }
            return
        }
        do {
            guard try await DeviceActionStore.shared.requestCalendarAccess() else {
                errorMessage = "Allow Calendar access in Settings to use this action."
                return
            }
            if DeviceActionStore.shared.calendarEventExists(with: backlink, near: draft.startAt, end: draft.endAt) {
                complete()
                return
            }
            let item = EKEvent(eventStore: DeviceActionStore.shared.eventStore)
            item.title = draft.title
            item.startDate = draft.startAt
            item.endDate = draft.endAt
            item.isAllDay = draft.isAllDay
            item.location = draft.location.nilIfEmpty
            item.notes = draft.notes.nilIfEmpty
            item.url = backlink
            item.calendar = DeviceActionStore.shared.eventStore.defaultCalendarForNewEvents
            event = item
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct CalendarEventEditor: UIViewControllerRepresentable {
    let event: EKEvent
    let completion: (EKEventEditViewAction) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }

    func makeUIViewController(context: Context) -> EKEventEditViewController {
        let controller = EKEventEditViewController()
        controller.eventStore = DeviceActionStore.shared.eventStore
        controller.event = event
        controller.editViewDelegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: EKEventEditViewController, context: Context) {}

    final class Coordinator: NSObject, EKEventEditViewDelegate {
        let completion: (EKEventEditViewAction) -> Void
        init(completion: @escaping (EKEventEditViewAction) -> Void) { self.completion = completion }
        func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
            completion(action)
        }
    }
}

private struct ContactProposalView: View {
    @Environment(\.dismiss) private var dismiss
    let proposal: AssistantProposal
    let selectedContact: (_ name: String, _ email: String) -> Void
    let cancel: () -> Void

    var body: some View {
        ContactEmailPicker(suggestedName: proposal.arguments["name"]?.stringValue ?? "") { name, email in
            selectedContact(name, email)
        } cancelled: {
            // Dismissing the system picker leaves the proposal pending so it can be retried.
            dismiss()
        }
        .ignoresSafeArea()
    }
}

private struct ContactEmailPicker: UIViewControllerRepresentable {
    let suggestedName: String
    let selected: (_ name: String, _ email: String) -> Void
    let cancelled: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(selected: selected, cancelled: cancelled) }

    func makeUIViewController(context: Context) -> CNContactPickerViewController {
        let picker = CNContactPickerViewController()
        picker.delegate = context.coordinator
        picker.displayedPropertyKeys = [CNContactEmailAddressesKey]
        picker.predicateForEnablingContact = NSPredicate(format: "emailAddresses.@count > 0")
        picker.predicateForSelectionOfContact = NSPredicate(value: false)
        picker.predicateForSelectionOfProperty = NSPredicate(format: "key == %@", CNContactEmailAddressesKey)
        if !suggestedName.isEmpty { picker.navigationItem.prompt = "Choose an email for \(suggestedName)" }
        return picker
    }

    func updateUIViewController(_ uiViewController: CNContactPickerViewController, context: Context) {}

    final class Coordinator: NSObject, CNContactPickerDelegate {
        let selected: (_ name: String, _ email: String) -> Void
        let cancelled: () -> Void
        init(selected: @escaping (_ name: String, _ email: String) -> Void, cancelled: @escaping () -> Void) {
            self.selected = selected
            self.cancelled = cancelled
        }

        func contactPickerDidCancel(_ picker: CNContactPickerViewController) { cancelled() }

        func contactPicker(_ picker: CNContactPickerViewController, didSelect contactProperty: CNContactProperty) {
            guard contactProperty.key == CNContactEmailAddressesKey,
                  let email = contactProperty.value as? String else { return }
            let contact = contactProperty.contact
            let name = CNContactFormatter.string(from: contact, style: .fullName) ?? email
            selected(name, email)
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
