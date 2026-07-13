import SwiftUI

struct TodayView: View {
    @EnvironmentObject private var model: AppModel

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackdrop()
                ScrollView {
                    VStack(spacing: 18) {
                        summaryHero

                        LazyVGrid(columns: columns, spacing: 12) {
                            MetricCard(title: "Kept", value: model.summary.counters.kept, symbol: "tray", color: WinnowDesign.mint)
                            MetricCard(title: "Archived", value: model.summary.counters.totalArchived, symbol: "archivebox", color: WinnowDesign.amber)
                            MetricCard(title: "Unsubscribed", value: model.summary.counters.unsubscribedSucceeded, symbol: "person.crop.circle.badge.minus", color: WinnowDesign.rose)
                            MetricCard(title: "Restored", value: model.summary.counters.restoredToInbox, symbol: "arrow.uturn.backward", color: WinnowDesign.brightIndigo)
                        }

                        runtimeCard

                        if !model.summary.lists.actedOn.isEmpty {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("RECENT ACTIVITY")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 4)
                                VStack(spacing: 0) {
                                    ForEach(Array(model.summary.lists.actedOn.suffix(12).reversed().enumerated()), id: \.element.id) { index, event in
                                        ActivityRow(event: event)
                                        if index < min(model.summary.lists.actedOn.count, 12) - 1 { Divider().padding(.leading, 42) }
                                    }
                                }
                                .winnowCard(padding: 4)
                            }
                        }
                    }
                    .padding(16)
                }
                .refreshable { await model.refresh() }
            }
            .navigationTitle("Today")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionBadge(isOnline: model.isOnline, isRefreshing: model.isRefreshing)
                }
            }
        }
    }

    private var summaryHero: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(model.summary.date.isEmpty ? "TODAY" : model.summary.date)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white.opacity(0.72))
                    Text("\(model.summary.counters.processed)")
                        .font(.system(size: 50, weight: .bold, design: .rounded))
                        .contentTransition(.numericText())
                    Text("emails processed")
                        .font(.headline)
                        .foregroundStyle(.white.opacity(0.82))
                }
                Spacer()
                WinnowMark(size: 48)
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(.white.opacity(0.24)))
            }

            if model.summary.counters.processed > 0 {
                GeometryReader { proxy in
                    let handled = model.summary.counters.totalArchived
                    let ratio = min(Double(handled) / Double(model.summary.counters.processed), 1)
                    Capsule().fill(.white.opacity(0.16))
                        .overlay(alignment: .leading) {
                            Capsule().fill(.white.opacity(0.78)).frame(width: proxy.size.width * ratio)
                        }
                }
                .frame(height: 7)
            }
        }
        .foregroundStyle(.white)
        .padding(22)
        .background(WinnowDesign.heroGradient, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .shadow(color: WinnowDesign.indigo.opacity(0.24), radius: 22, y: 10)
    }

    private var runtimeCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label("Winnow status", systemImage: "waveform.path.ecg")
                    .font(.headline)
                Spacer()
                ConnectionBadge(isOnline: model.isOnline, isRefreshing: model.isRefreshing)
            }
            if let lastScan = model.status?.scans.lastScanTime?.winnowParsedDate {
                HStack {
                    Text("Last scan").foregroundStyle(.secondary)
                    Spacer()
                    Text(lastScan.relativeWinnowTime).fontWeight(.semibold)
                }
                .font(.subheadline)
            }
            ForEach(model.accounts) { account in
                HStack(spacing: 10) {
                    Circle().fill(account.scan.lastScanAt == nil ? Color.secondary : WinnowDesign.mint).frame(width: 7, height: 7)
                    Text(account.email).lineLimit(1)
                    Spacer()
                    if let count = account.scan.lastScanProcessed { Text("\(count) handled").foregroundStyle(.secondary) }
                }
                .font(.caption)
            }
        }
        .winnowCard()
    }
}

private struct MetricCard: View {
    let title: String
    let value: Int
    let symbol: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: symbol)
                .font(.headline)
                .foregroundStyle(color)
                .frame(width: 34, height: 34)
                .background(color.opacity(0.11), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            Text("\(value)").font(.title.bold()).contentTransition(.numericText())
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .winnowCard()
    }
}

private struct ActivityRow: View {
    let event: SummaryItem

    private var icon: String {
        if event.actionType.contains("archive") { return "archivebox.fill" }
        if event.actionType.contains("unsubscribe") { return "person.crop.circle.badge.minus" }
        if event.actionType.contains("restored") { return "arrow.uturn.backward" }
        if event.actionType.contains("kept") { return "tray.fill" }
        return "sparkles"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: icon)
                .font(.caption.weight(.bold))
                .foregroundStyle(WinnowDesign.indigo)
                .frame(width: 30, height: 30)
                .background(WinnowDesign.indigo.opacity(0.10), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(event.subject.isEmpty ? event.actionType.replacingOccurrences(of: ".", with: " ").capitalized : event.subject)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(event.reason.isEmpty ? event.account : event.reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            if let date = event.displayDate { Text(date.relativeWinnowTime).font(.caption2).foregroundStyle(.tertiary) }
        }
        .padding(12)
    }
}

private extension String {
    var winnowParsedDate: Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: self) ?? ISO8601DateFormatter().date(from: self)
    }
}
