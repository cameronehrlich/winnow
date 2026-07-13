import SwiftUI

struct StatsView: View {
    @EnvironmentObject private var model: AppModel

    private let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackdrop()
                ScrollView {
                    VStack(spacing: 18) {
                        lifetimeHero

                        LazyVGrid(columns: columns, spacing: 10) {
                            MetricCard(
                                title: "Auto-handled",
                                value: model.lifetimeSummary.counters.autoArchived,
                                symbol: "wand.and.stars",
                                color: WinnowDesign.amber
                            )
                            MetricCard(
                                title: "Kept for you",
                                value: model.lifetimeSummary.counters.kept,
                                symbol: "tray.full",
                                color: WinnowDesign.mint
                            )
                            MetricCard(
                                title: "Unsubscribed",
                                value: model.lifetimeSummary.counters.unsubscribedSucceeded,
                                symbol: "person.crop.circle.badge.minus",
                                color: WinnowDesign.rose
                            )
                            MetricCard(
                                title: "Restored",
                                value: model.lifetimeSummary.counters.restoredToInbox,
                                symbol: "arrow.uturn.backward",
                                color: WinnowDesign.brightIndigo
                            )
                        }

                        todayCard

                        if !model.lifetimeSummary.recentActivity.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("RECENT ACTIVITY")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 4)

                                VStack(spacing: 0) {
                                    ForEach(Array(model.lifetimeSummary.recentActivity.prefix(20).enumerated()), id: \.element.id) { index, event in
                                        if let emailID = event.resolvedEmailID(in: model.emails) {
                                            NavigationLink {
                                                EmailDetailView(emailID: emailID)
                                            } label: {
                                                ActivityRow(event: event, isNavigable: true)
                                            }
                                            .buttonStyle(.plain)
                                            .accessibilityHint("Shows email details")
                                        } else {
                                            ActivityRow(event: event, isNavigable: false)
                                                .accessibilityHint("The related email is no longer available")
                                        }
                                        if index < min(model.lifetimeSummary.recentActivity.count, 20) - 1 {
                                            Divider().padding(.leading, 46)
                                        }
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
            .navigationTitle("Stats")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ConnectionBadge(isOnline: model.isOnline, isRefreshing: model.isRefreshing)
                }
            }
        }
    }

    private var lifetimeHero: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("ALL TIME")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white.opacity(0.72))
                    Text("\(model.lifetimeSummary.counters.processed)")
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

            let processed = model.lifetimeSummary.counters.processed
            if processed > 0 {
                let handled = model.lifetimeSummary.counters.autoArchived
                let percent = Int((Double(handled) / Double(processed) * 100).rounded())
                Label("\(percent)% handled automatically", systemImage: "sparkles")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.82))
            }
        }
        .foregroundStyle(.white)
        .padding(20)
        .background(WinnowDesign.heroGradient, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .shadow(color: WinnowDesign.indigo.opacity(0.22), radius: 20, y: 9)
    }

    private var todayCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("TODAY")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(WinnowDesign.indigo)
                    Text(model.summary.date)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "calendar")
                    .foregroundStyle(WinnowDesign.indigo)
            }

            HStack(spacing: 0) {
                TodayMetric(title: "Processed", value: model.summary.counters.processed)
                TodayMetric(title: "Inbox", value: model.summary.counters.kept)
                TodayMetric(title: "Archived", value: model.summary.counters.totalArchived)
                TodayMetric(title: "Unsubscribed", value: model.summary.counters.unsubscribedSucceeded)
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
        HStack(spacing: 11) {
            Image(systemName: symbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(color)
                .frame(width: 32, height: 32)
                .background(color.opacity(0.11), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text("\(value)")
                    .font(.title3.bold())
                    .contentTransition(.numericText())
                Text(title)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .winnowCard(padding: 12)
    }
}

private struct TodayMetric: View {
    let title: String
    let value: Int

    var body: some View {
        VStack(spacing: 4) {
            Text("\(value)")
                .font(.title3.bold())
                .contentTransition(.numericText())
            Text(title)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct ActivityRow: View {
    let event: SummaryItem
    let isNavigable: Bool

    private var presentation: (label: String, icon: String, color: Color) {
        switch event.actionType {
        case "email.auto_archived": ("Archived automatically", "archivebox.fill", WinnowDesign.amber)
        case "email.manual_archived": ("Archived", "archivebox.fill", WinnowDesign.indigo)
        case "email.restored_to_inbox": ("Moved to Inbox", "arrow.uturn.backward", WinnowDesign.brightIndigo)
        case "email.unsubscribed": ("Unsubscribed", "person.crop.circle.badge.minus", WinnowDesign.rose)
        case "email.unsubscribe_attempted": ("Unsubscribe needs a manual step", "envelope.badge", WinnowDesign.amber)
        case "email.unsubscribe_failed": ("Unsubscribe failed", "exclamationmark.triangle", WinnowDesign.rose)
        default: ("Kept in Inbox", "tray.fill", WinnowDesign.mint)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: presentation.icon)
                .font(.caption.weight(.bold))
                .foregroundStyle(presentation.color)
                .frame(width: 30, height: 30)
                .background(presentation.color.opacity(0.10), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(event.subject.isEmpty ? presentation.label : event.subject)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text("\(presentation.label) · \(event.account)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if let date = event.displayDate {
                Text(date.relativeWinnowTime)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if isNavigable {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 2)
                    .accessibilityHidden(true)
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 12)
        .padding(.vertical, 10)
    }
}
