import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
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
                            ConnectionBadge(isOnline: model.isOnline, isRefreshing: model.isRefreshing)
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

                    if !model.accounts.isEmpty {
                        Section("Managed Accounts") {
                            ForEach(model.accounts) { account in
                                HStack {
                                    Image(systemName: "envelope").foregroundStyle(WinnowDesign.indigo)
                                    Text(account.email).lineLimit(1)
                                    Spacer()
                                    if let date = account.scan.lastScanAt?.winnowSettingsDate {
                                        Text(date.relativeWinnowTime).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
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
