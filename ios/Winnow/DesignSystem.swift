import SwiftUI

enum WinnowDesign {
    static let indigo = Color(red: 0.28, green: 0.22, blue: 0.82)
    static let brightIndigo = Color(red: 0.43, green: 0.37, blue: 0.98)
    static let mint = Color(red: 0.19, green: 0.72, blue: 0.60)
    static let amber = Color(red: 0.94, green: 0.58, blue: 0.20)
    static let rose = Color(red: 0.92, green: 0.30, blue: 0.43)
    static let deepRose = Color(red: 0.68, green: 0.12, blue: 0.25)
    static let ink = Color(red: 0.07, green: 0.08, blue: 0.14)

    static let heroGradient = LinearGradient(
        colors: [brightIndigo, indigo, Color(red: 0.11, green: 0.10, blue: 0.28)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static func senderGradient(seed: String) -> LinearGradient {
        let palettes: [[Color]] = [
            [brightIndigo, indigo],
            [mint, Color.teal],
            [amber, Color.orange],
            [rose, Color.pink],
            [Color.cyan, Color.blue],
        ]
        let hash = seed.unicodeScalars.reduce(UInt(5381)) { ($0 &* 33) &+ UInt($1.value) }
        let index = Int(hash % UInt(palettes.count))
        return LinearGradient(colors: palettes[index], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

struct WinnowCompactActionButtonStyle: ButtonStyle {
    let color: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(.white)
            .padding(.horizontal, 13)
            .padding(.vertical, 8)
            .background(
                color.opacity(configuration.isPressed ? 0.78 : 1),
                in: Capsule()
            )
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct AppBackdrop: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            Color(uiColor: colorScheme == .dark ? .systemBackground : .secondarySystemBackground)
            Circle()
                .fill(WinnowDesign.brightIndigo.opacity(colorScheme == .dark ? 0.16 : 0.10))
                .frame(width: 360, height: 360)
                .blur(radius: 60)
                .offset(x: 170, y: -350)
        }
        .ignoresSafeArea()
    }
}

struct WinnowMark: View {
    var size: CGFloat = 54

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(WinnowDesign.heroGradient)
            Image(systemName: "line.3.horizontal.decrease")
                .font(.system(size: size * 0.46, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .shadow(color: WinnowDesign.indigo.opacity(0.28), radius: size * 0.22, y: size * 0.1)
        .accessibilityHidden(true)
    }
}

struct SenderAvatar: View {
    let initials: String
    let seed: String
    var size: CGFloat = 42

    var body: some View {
        Text(initials)
            .font(.system(size: size * 0.35, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(WinnowDesign.senderGradient(seed: seed), in: RoundedRectangle(cornerRadius: size * 0.34, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct CapsuleLabel: View {
    let text: String
    let symbol: String?
    var color: Color = WinnowDesign.indigo

    init(_ text: String, symbol: String? = nil, color: Color = WinnowDesign.indigo) {
        self.text = text
        self.symbol = symbol
        self.color = color
    }

    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol) }
            Text(text)
                .lineLimit(1)
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(color)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(color.opacity(0.11), in: Capsule())
    }
}

struct ConnectionBadge: View {
    let isOnline: Bool
    let isRefreshing: Bool

    var body: some View {
        HStack(spacing: 6) {
            if isRefreshing {
                ProgressView().controlSize(.mini)
            } else {
                Circle()
                    .fill(isOnline ? WinnowDesign.mint : Color.secondary)
                    .frame(width: 7, height: 7)
            }
            Text(isRefreshing ? "Syncing" : (isOnline ? "Live" : "Offline"))
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.thinMaterial, in: Capsule())
        .accessibilityLabel(isRefreshing ? "Syncing" : (isOnline ? "Winnow is online" : "Winnow is offline"))
    }
}

struct ToastView: View {
    let toast: ToastMessage

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: toast.symbol)
                .foregroundStyle(WinnowDesign.mint)
            Text(toast.text)
                .font(.subheadline.weight(.semibold))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThickMaterial, in: Capsule())
        .overlay(Capsule().stroke(Color.primary.opacity(0.08)))
        .shadow(color: .black.opacity(0.14), radius: 18, y: 8)
        .padding(.top, 8)
    }
}

extension View {
    func winnowCard(padding: CGFloat = 16) -> some View {
        self
            .padding(padding)
            .background(.background, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(Color.primary.opacity(0.07), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.045), radius: 14, y: 5)
    }
}

extension Date {
    var relativeWinnowTime: String {
        formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}
