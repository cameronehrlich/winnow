import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var serverURL = ""
    @State private var token = ""
    @State private var isTesting = false
    @State private var confirmDisconnect = false

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackdrop()
                Form {
                    Section {
                        HStack(spacing: 13) {
                            WinnowMark(size: 46)
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Winnow").font(.headline)
                                Text("Private, direct, and fast").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        .padding(.vertical, 5)
                    }

                    Section {
                        TextField("https://your-winnow-host", text: $serverURL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .textContentType(.URL)
                        SecureField("Bearer token", text: $token)
                            .textContentType(.password)
                        if model.configuration.isDebugOverride {
                            Label("Seeded by a development launch", systemImage: "hammer.fill")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } header: {
                        Text("Connection")
                    } footer: {
                        Text("The token is stored in this device’s Keychain and is never shown in logs.")
                    }

                    Section {
                        Button {
                            Task {
                                isTesting = true
                                _ = await model.testConnection(serverURL: serverURL, token: token)
                                isTesting = false
                            }
                        } label: {
                            HStack {
                                Label("Test Connection", systemImage: "bolt.horizontal")
                                Spacer()
                                if isTesting { ProgressView() }
                            }
                        }
                        .disabled(isTesting || serverURL.isEmpty || token.isEmpty)

                        Button {
                            Task { _ = await model.saveAndConnect(serverURL: serverURL, token: token) }
                        } label: {
                            HStack {
                                Label("Save & Connect", systemImage: "checkmark.circle")
                                Spacer()
                                if model.isLoading { ProgressView() }
                            }
                        }
                        .disabled(model.isLoading || serverURL.isEmpty || token.isEmpty)
                    }

                    if model.status != nil || !model.accounts.isEmpty {
                        Section {
                            HStack(spacing: 12) {
                                Image(systemName: "waveform.path.ecg")
                                    .foregroundStyle(WinnowDesign.indigo)
                                    .frame(width: 24)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Winnow service")
                                        .font(.subheadline.weight(.semibold))
                                    if let lastScan = model.status?.scans.lastScanTime?.winnowSettingsDate {
                                        Text("Last scan \(lastScan.relativeWinnowTime)")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                ConnectionBadge(isOnline: model.isOnline, isRefreshing: model.isRefreshing)
                            }

                            ForEach(model.accounts) { account in
                                HStack(spacing: 12) {
                                    Circle()
                                        .fill(account.scan.lastScanAt == nil ? Color.secondary : WinnowDesign.mint)
                                        .frame(width: 8, height: 8)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(account.email)
                                            .font(.subheadline)
                                            .lineLimit(1)
                                        if let processed = account.scan.lastScanProcessed {
                                            Text("\(processed) handled in latest scan")
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    if let date = account.scan.lastScanAt?.winnowSettingsDate {
                                        Text(date.relativeWinnowTime)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        } header: {
                            Text("Managed Accounts")
                        } footer: {
                            Text("Service health and per-account scan activity are shown together here.")
                        }
                    }

                    Section("Mail Handling") {
                        NavigationLink {
                            MailRulesView()
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Rules")
                                    Text("Choose what Winnow archives or keeps")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            } icon: {
                                Image(systemName: "line.3.horizontal.decrease.circle")
                            }
                        }
                    }

                    Section("Sync") {
                        LabeledContent("Foreground refresh", value: "Every 30 seconds")
                        if let lastRefresh = model.lastRefresh {
                            LabeledContent("Last app refresh", value: lastRefresh.relativeWinnowTime)
                        }
                        Text("Push delivery is not enabled in V1. Slack remains the notification fallback; this app refreshes while open and whenever it becomes active.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Section {
                        Button("Forget This Server", role: .destructive) { confirmDisconnect = true }
                    }

                    Section {
                        HStack {
                            Text("Version")
                            Spacer()
                            Text(appVersion).foregroundStyle(.secondary)
                        }
                    }
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                serverURL = model.configuration.serverURL
                token = model.configuration.token
            }
            .confirmationDialog("Forget Winnow setup?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
                Button("Forget Server & Token", role: .destructive) { model.disconnect() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This only clears the connection details on this device.")
            }
        }
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(version) (\(build))"
    }
}

private extension String {
    var winnowSettingsDate: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: self) ?? ISO8601DateFormatter().date(from: self)
    }
}
