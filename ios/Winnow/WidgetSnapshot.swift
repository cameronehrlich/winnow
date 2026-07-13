import Foundation
import WidgetKit

enum WinnowSharedStore {
    static let appGroup = "group.com.cameronehrlich.Winnow"
    static let snapshotKey = "winnow.widget.snapshot"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }
}

struct WinnowWidgetSnapshot: Codable, Equatable {
    struct Item: Codable, Equatable, Identifiable {
        let id: String
        let sender: String
        let subject: String
        let summary: String
        let date: Date
    }

    let inboxCount: Int
    let items: [Item]
    let updatedAt: Date

    static let empty = WinnowWidgetSnapshot(inboxCount: 0, items: [], updatedAt: .distantPast)
}

#if !WIDGET_EXTENSION
enum WidgetSnapshotStore {
    static func save(emails: [EmailItem]) {
        let inbox = emails.filter { !$0.isArchived }
        let snapshot = WinnowWidgetSnapshot(
            inboxCount: inbox.count,
            items: inbox.prefix(3).map {
                WinnowWidgetSnapshot.Item(
                    id: $0.id,
                    sender: $0.senderDisplayName,
                    subject: $0.subject,
                    summary: $0.summary.isEmpty ? $0.snippet : $0.summary,
                    date: $0.displayDate ?? Date()
                )
            },
            updatedAt: Date()
        )
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        WinnowSharedStore.defaults.set(data, forKey: WinnowSharedStore.snapshotKey)
        WidgetCenter.shared.reloadTimelines(ofKind: "WinnowInboxWidget")
    }

    static func clear() {
        WinnowSharedStore.defaults.removeObject(forKey: WinnowSharedStore.snapshotKey)
        WidgetCenter.shared.reloadTimelines(ofKind: "WinnowInboxWidget")
    }
}
#endif
