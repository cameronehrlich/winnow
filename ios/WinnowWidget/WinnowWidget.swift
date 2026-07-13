import SwiftUI
import WidgetKit

private struct WinnowInboxEntry: TimelineEntry {
    let date: Date
    let snapshot: WinnowWidgetSnapshot
}

private struct WinnowInboxProvider: TimelineProvider {
    func placeholder(in context: Context) -> WinnowInboxEntry {
        WinnowInboxEntry(date: Date(), snapshot: .empty)
    }

    func getSnapshot(in context: Context, completion: @escaping (WinnowInboxEntry) -> Void) {
        completion(WinnowInboxEntry(date: Date(), snapshot: load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WinnowInboxEntry>) -> Void) {
        let entry = WinnowInboxEntry(date: Date(), snapshot: load())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
    }

    private func load() -> WinnowWidgetSnapshot {
        guard let data = WinnowSharedStore.defaults.data(forKey: WinnowSharedStore.snapshotKey),
              let snapshot = try? JSONDecoder().decode(WinnowWidgetSnapshot.self, from: data) else { return .empty }
        return snapshot
    }
}

private struct WinnowInboxWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WinnowInboxEntry

    var body: some View {
        if family == .systemSmall {
            small
        } else {
            medium
        }
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "line.3.horizontal.decrease")
                    .font(.headline)
                    .foregroundStyle(.indigo)
                Spacer()
                Text("INBOX").font(.caption2.bold()).foregroundStyle(.secondary)
            }
            Spacer()
            Text("\(entry.snapshot.inboxCount)")
                .font(.system(size: 46, weight: .bold, design: .rounded))
            Text(entry.snapshot.inboxCount == 1 ? "email needs you" : "emails need you")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
            Spacer()
            Text(updatedText).font(.caption2).foregroundStyle(.tertiary)
        }
        .widgetURL(URL(string: "winnow://mailbox/inbox"))
    }

    private var medium: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Inbox", systemImage: "tray.full.fill").font(.headline).foregroundStyle(.indigo)
                Spacer()
                Text("\(entry.snapshot.inboxCount)").font(.title2.bold())
            }
            if entry.snapshot.items.isEmpty {
                Spacer()
                Label("Nothing needs your attention", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
            } else {
                ForEach(entry.snapshot.items.prefix(2)) { item in
                    Link(destination: emailURL(item)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.sender).font(.caption.bold()).lineLimit(1)
                            Text(item.subject).font(.caption).lineLimit(1).foregroundStyle(.primary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                Spacer(minLength: 0)
            }
            Text(updatedText).font(.caption2).foregroundStyle(.tertiary)
        }
        .widgetURL(URL(string: "winnow://mailbox/inbox"))
    }

    private var updatedText: String {
        guard entry.snapshot.updatedAt > .distantPast else { return "Open Winnow to connect" }
        return "Updated \(entry.snapshot.updatedAt.formatted(.relative(presentation: .named)))"
    }

    private func emailURL(_ item: WinnowWidgetSnapshot.Item) -> URL {
        var components = URLComponents()
        components.scheme = "winnow"
        components.host = "email"
        components.queryItems = [
            URLQueryItem(name: "id", value: item.id),
            URLQueryItem(name: "mailbox", value: "inbox"),
        ]
        return components.url ?? URL(string: "winnow://mailbox/inbox")!
    }
}

struct WinnowInboxWidget: Widget {
    let kind = "WinnowInboxWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: WinnowInboxProvider()) { entry in
            WinnowInboxWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Winnow Inbox")
        .description("See what needs your attention now.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct WinnowWidgetBundle: WidgetBundle {
    var body: some Widget {
        WinnowInboxWidget()
    }
}
