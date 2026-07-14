import SwiftUI

struct MailRulesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedAccount = ""
    @State private var searchText = ""
    @State private var editingRule: MailRule?
    @State private var pendingToggle: RuleToggleRequest?
    @State private var pendingReset: MailRule?

    private var visibleRules: [MailRule] {
        model.mailRules.filter { rule in
            let accountMatches = selectedAccount.isEmpty
                || rule.account == nil
                || rule.account?.caseInsensitiveCompare(selectedAccount) == .orderedSame
            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            let searchMatches = query.isEmpty || [
                rule.description, rule.matcherTitle, rule.accountTitle, rule.actionTitle, rule.source,
            ].contains { $0.localizedCaseInsensitiveContains(query) }
            return accountMatches && searchMatches
        }
    }

    private var userRules: [MailRule] {
        visibleRules.filter { !$0.belongsWithDefaults && !$0.isLockedAutomation }
    }

    private var defaultRules: [MailRule] {
        let defaults = visibleRules.filter(\.belongsWithDefaults)
        guard !selectedAccount.isEmpty else { return defaults }
        let overriddenIDs = Set(model.mailRules.filter { rule in
            rule.isBaselineCustomization
                && rule.account?.caseInsensitiveCompare(selectedAccount) == .orderedSame
        }.compactMap(\.baselineRuleId))
        return defaults.filter { rule in
            !rule.isBaseline || !overriddenIDs.contains(rule.baselineRuleId ?? rule.id)
        }
    }

    private var lockedAutomations: [MailRule] {
        visibleRules.filter(\.isLockedAutomation)
    }

    var body: some View {
        List {
            Section {
                Picker("Account", selection: $selectedAccount) {
                    Text("All Accounts").tag("")
                    ForEach(model.accounts) { account in
                        Text(account.email).tag(account.email)
                    }
                }
            } footer: {
                Text("Rules for all accounts remain visible because they also apply to the selected mailbox.")
            }

            Section("My Rules") {
                if userRules.isEmpty {
                    emptyRow("No matching personal rules", symbol: "person.crop.circle.badge.checkmark")
                } else {
                    ForEach(userRules) { rule in
                        MailRuleRow(
                            rule: rule,
                            isBusy: model.performingRuleIDs.contains(rule.id),
                            toggle: { pendingToggle = RuleToggleRequest(rule: rule, enabled: $0) },
                            edit: { editingRule = rule }
                        )
                    }
                }
            }

            Section {
                if defaultRules.isEmpty {
                    emptyRow("No matching defaults", symbol: "checklist")
                } else {
                    ForEach(defaultRules) { rule in
                        MailRuleRow(
                            rule: rule,
                            isBusy: model.performingRuleIDs.contains(rule.id),
                            customize: { editingRule = rule },
                            reset: { pendingReset = rule }
                        )
                    }
                }
            } header: {
                Text("Winnow Defaults")
            } footer: {
                Text("Customizing a default creates your override. Reset restores Winnow’s original behavior.")
            }

            if !lockedAutomations.isEmpty {
                Section {
                    ForEach(lockedAutomations) { rule in
                        MailRuleRow(rule: rule, isBusy: false)
                    }
                } header: {
                    Text("Server Automations")
                } footer: {
                    Text("These are managed on the Winnow server and are shown here for clarity.")
                }
            }

            Section {
                Button {
                    model.requestAskWinnow()
                } label: {
                    Label("Add Rule with Ask Winnow", systemImage: "sparkles")
                }
            } footer: {
                Text("Describe the future mail you want archived or kept. Winnow will preview the scope and ask for confirmation before saving.")
            }
        }
        .navigationTitle("Rules")
        .searchable(text: $searchText, prompt: "Search rules")
        .overlay {
            if model.isLoadingMailRules && model.mailRules.isEmpty { ProgressView("Loading rules…") }
        }
        .task {
            await model.loadMailRules(showsError: model.mailRules.isEmpty)
        }
        .refreshable { await model.loadMailRules() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    model.requestAskWinnow()
                } label: {
                    Label("Add Rule", systemImage: "plus")
                }
            }
        }
        .sheet(item: $editingRule) { rule in
            MailRuleEditorView(rule: rule)
                .environmentObject(model)
        }
        .confirmationDialog(
            pendingToggle?.enabled == true ? "Enable this rule?" : "Disable this rule?",
            isPresented: Binding(
                get: { pendingToggle != nil },
                set: { if !$0 { pendingToggle = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let request = pendingToggle {
                Button(request.enabled ? "Enable Rule" : "Disable Rule", role: request.enabled ? nil : .destructive) {
                    pendingToggle = nil
                    Task { _ = await model.setMailRuleEnabled(request.rule, enabled: request.enabled) }
                }
            }
            Button("Cancel", role: .cancel) { pendingToggle = nil }
        } message: {
            if let request = pendingToggle {
                Text("Future matching messages will \(request.enabled ? request.rule.actionTitle.lowercased() : "return to normal Winnow handling").")
            }
        }
        .confirmationDialog(
            "Reset this default?",
            isPresented: Binding(
                get: { pendingReset != nil },
                set: { if !$0 { pendingReset = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let rule = pendingReset {
                Button("Reset to Winnow Default", role: .destructive) {
                    pendingReset = nil
                    Task { _ = await model.resetMailRule(rule) }
                }
            }
            Button("Cancel", role: .cancel) { pendingReset = nil }
        } message: {
            Text("Your customization will be removed. Future mail will use Winnow’s original rule again.")
        }
    }

    private func emptyRow(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .font(.subheadline)
            .foregroundStyle(.secondary)
    }
}

private struct RuleToggleRequest: Identifiable {
    let rule: MailRule
    let enabled: Bool
    var id: String { "\(rule.id)|\(enabled)" }
}

private struct MailRuleRow: View {
    let rule: MailRule
    let isBusy: Bool
    var toggle: ((Bool) -> Void)?
    var edit: (() -> Void)?
    var customize: (() -> Void)?
    var reset: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: rule.actionSymbol)
                    .foregroundStyle(rule.effect == "archive" ? WinnowDesign.indigo : WinnowDesign.mint)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text(rule.description.isEmpty ? rule.matcherTitle : rule.description)
                        .font(.subheadline.weight(.semibold))
                    if !rule.description.isEmpty && rule.description != rule.matcherTitle {
                        Text(rule.matcherTitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    HStack(spacing: 6) {
                        Text(rule.actionTitle)
                        Text("•")
                        Text(rule.accountTitle)
                        if rule.isBaselineCustomization {
                            Text("•")
                            Text("Customized")
                        }
                    }
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    if rule.type == "semantic" {
                        Label("Classifier-cited rule", systemImage: "sparkles")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if let activity = rule.activity {
                        HStack(spacing: 6) {
                            if activity.appliedCount30Days == 0 {
                                Text("No tracked uses yet")
                            } else {
                                Text(rule.type == "semantic"
                                     ? "\(activity.appliedCount30Days) classifier-cited in 30 days"
                                     : "\(activity.appliedCount30Days) applied in 30 days")
                            }
                            if activity.appliedCount30Days > 0, let date = activity.lastAppliedDate {
                                Text("•")
                                Text("Last used \(date.formatted(date: .abbreviated, time: .omitted))")
                            }
                        }
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    }
                }
                Spacer(minLength: 8)
                if isBusy {
                    ProgressView()
                } else if let toggle {
                    Toggle("", isOn: Binding(get: { rule.enabled }, set: toggle))
                        .labelsHidden()
                } else if rule.isLockedAutomation {
                    Image(systemName: "lock.fill")
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Managed on server")
                }
            }

            if edit != nil || customize != nil || (rule.canReset && reset != nil) {
                HStack(spacing: 16) {
                    if let edit {
                        Button("Edit", action: edit)
                    } else if let customize {
                        Button(rule.isBaselineCustomization ? "Edit Customization" : "Customize", action: customize)
                    }
                    if rule.canReset, let reset {
                        Button("Reset", role: .destructive, action: reset)
                    }
                }
                .font(.caption.weight(.semibold))
            }
        }
        .padding(.vertical, 4)
        .opacity(rule.enabled ? 1 : 0.58)
    }
}

struct MailRuleEditorView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let rule: MailRule

    @State private var draft: MailRuleDraft
    @State private var preview: MailRulePreviewResponse?
    @State private var isPreviewing = false
    @State private var isSaving = false
    @State private var showingReview = false
    @State private var localError: String?

    init(rule: MailRule) {
        self.rule = rule
        _draft = State(initialValue: MailRuleDraft(rule: rule))
    }

    private var originalDraft: MailRuleDraft { MailRuleDraft(rule: rule) }
    private var hasMeaningChange: Bool { draft != originalDraft }

    private var canTest: Bool {
        let matcherIsPresent = rule.belongsWithDefaults || (draft.type == "semantic"
            ? draft.match?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            : draft.matcherValue?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
        let accountIsScoped = !rule.isBaseline
            || draft.account?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        return matcherIsPresent && accountIsScoped && !isPreviewing && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Behavior") {
                    Picker("Action", selection: $draft.effect) {
                        Text("Archive").tag("archive")
                        Text("Keep in Inbox").tag("keep")
                    }
                    .pickerStyle(.segmented)

                    if rule.isBaseline {
                        Picker("Account", selection: Binding(
                            get: { draft.account ?? "" },
                            set: { draft.account = $0.isEmpty ? nil : $0 }
                        )) {
                            Text("Choose Account").tag("")
                            ForEach(model.accounts) { account in
                                Text(account.email).tag(account.email)
                            }
                        }
                        if draft.account == nil {
                            Text("A customization must belong to one managed account.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        LabeledContent("Account", value: rule.accountTitle)
                    }
                }

                if let activity = rule.activity {
                    Section("Recent Activity") {
                        if activity.recent.isEmpty {
                            Text("No tracked uses yet; activity is recorded from this release forward.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(activity.recent.prefix(3)) { example in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(example.subject).font(.subheadline.weight(.semibold))
                                    Text(example.from).font(.caption).foregroundStyle(.secondary)
                                    HStack(spacing: 6) {
                                        Text(rule.type == "semantic" ? "Classifier-cited" : "Matched")
                                        if let date = example.displayDate {
                                            Text("•")
                                            Text(date.formatted(date: .abbreviated, time: .omitted))
                                        }
                                    }
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(.tertiary)
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }
                }

                Section("Match") {
                    if rule.belongsWithDefaults {
                        LabeledContent("Winnow default", value: rule.matcherTitle)
                        Label("The default’s match definition is managed by Winnow. You can customize its action.", systemImage: "lock.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Type", selection: $draft.type) {
                            Text("Exact").tag("exact")
                            Text("Semantic").tag("semantic")
                        }
                    }
                    if !rule.belongsWithDefaults && draft.type == "semantic" {
                        TextField("Messages matching…", text: Binding(
                            get: { draft.match ?? "" },
                            set: { draft.match = $0 }
                        ), axis: .vertical)
                    } else if !rule.belongsWithDefaults {
                        Picker("Field", selection: Binding(
                            get: { draft.matcherKind ?? "sender" },
                            set: { draft.matcherKind = $0 }
                        )) {
                            Text("Sender").tag("sender")
                            Text("Domain").tag("domain")
                            Text("List ID").tag("list_id")
                        }
                        TextField("Value", text: Binding(
                            get: { draft.matcherValue ?? "" },
                            set: { draft.matcherValue = $0 }
                        ))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }

                Section("Label") {
                    TextField("Description", text: $draft.description, axis: .vertical)
                }

                Section {
                    Button {
                        reviewChange()
                    } label: {
                        HStack {
                            Label("Test Rule", systemImage: "checklist")
                            Spacer()
                            if isPreviewing { ProgressView() }
                        }
                    }
                    .disabled(!canTest)
                } footer: {
                    Text("Test the current rule against representative recent mail. Meaning-changing saves require a fresh test.")
                }
            }
            .navigationTitle(rule.belongsWithDefaults ? "Customize Default" : "Edit Rule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .onAppear {
                if rule.isBaseline, draft.account == nil, model.accounts.count == 1 {
                    draft.account = model.accounts[0].email
                }
            }
            .onChange(of: draft.type) { _, type in
                if type == "exact", draft.matcherKind == nil {
                    draft.matcherKind = "sender"
                }
            }
            .onChange(of: draft) { _, _ in
                preview = nil
            }
            .sheet(isPresented: $showingReview) {
                if let preview {
                    MailRuleReviewView(
                        draft: draft,
                        preview: preview,
                        isSaving: isSaving,
                        allowsSave: hasMeaningChange && canBindSave(preview),
                        title: hasMeaningChange ? "Review Rule Change" : "Rule Test",
                        saveTitle: preview.conflict == nil ? "Save Change" : "Replace Existing Rule",
                        cancel: { showingReview = false },
                        save: saveChange
                    )
                }
            }
            .alert("Couldn’t preview rule", isPresented: Binding(
                get: { localError != nil },
                set: { if !$0 { localError = nil } }
            )) {
                Button("OK") { localError = nil }
            } message: {
                Text(localError ?? "Unknown error")
            }
        }
    }

    private func reviewChange() {
        Task {
            isPreviewing = true
            defer { isPreviewing = false }
            do {
                preview = try await model.previewMailRule(draft)
                showingReview = true
            } catch {
                localError = error.localizedDescription
            }
        }
    }

    private func saveChange() {
        guard let reviewedPreview = preview else { return }
        let candidate = draft.bindingExpectedGuards(from: reviewedPreview)
        Task {
            isSaving = true
            let saved = await model.saveMailRule(candidate, replacing: rule)
            isSaving = false
            if saved {
                showingReview = false
                dismiss()
            } else {
                showingReview = false
                preview = nil
            }
        }
    }

    private func canBindSave(_ preview: MailRulePreviewResponse) -> Bool {
        let replacementIsBound = preview.conflict == nil || preview.replacementBinding != nil
        let currentRuleIsBound = draft.id == nil || preview.expectedRule != nil
        return replacementIsBound && currentRuleIsBound
    }
}

struct MailRuleReviewView: View {
    let draft: MailRuleDraft
    let preview: MailRulePreviewResponse
    let isSaving: Bool
    let allowsSave: Bool
    let title: String
    let saveTitle: String
    let cancel: () -> Void
    let save: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section("Proposed Behavior") {
                    LabeledContent("Action", value: draft.effect == "archive" ? "Archive" : "Keep in Inbox")
                    LabeledContent("Account", value: draft.account ?? "Choose an account")
                    if let evaluatedCount = preview.evaluatedCount {
                        LabeledContent("Examples evaluated", value: evaluatedCount.formatted())
                    } else if let matchCount = preview.matchCount {
                        LabeledContent("Recent matches", value: matchCount.formatted())
                    }
                    Text(sampleExplanation)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let conflict = preview.conflict {
                    Section {
                        Label("This save replaces an existing rule.", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(WinnowDesign.amber)
                        LabeledContent("Rule", value: conflict.rule.description.isEmpty ? conflict.rule.matcherTitle : conflict.rule.description)
                        LabeledContent("Current action", value: conflict.rule.actionTitle)
                        if preview.replacementBinding == nil {
                            Text("The rule changed or could not be bound to this preview. Test again before replacing it.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } header: {
                        Text("Existing Rule")
                    }
                }

                if draft.id != nil, preview.expectedRule == nil {
                    Section("Fresh Preview Required") {
                        Text("Winnow could not bind this preview to the current rule version. Test the rule again before saving.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                sampleSection("Representative Matches", examples: preview.matches, empty: "No representative matches were returned. The rule can still affect future mail.")
                sampleSection("Representative Non-Matches", examples: preview.nonMatches, empty: "No representative non-matches were returned.")
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(allowsSave ? "Back" : "Done", action: cancel)
                }
                if allowsSave {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saveTitle, action: save).disabled(isSaving)
                    }
                }
            }
            .overlay { if isSaving { ProgressView("Saving…") } }
        }
    }

    private var sampleExplanation: String {
        let previewMode = preview.mode ?? draft.type
        let isSemantic = draft.type == "semantic" || ["semantic", "sampled_estimate"].contains(previewMode)
        let pool = preview.sampledAtMost.map { " from a pool of up to \($0.formatted()) recent tracked messages" } ?? ""
        let base = isSemantic
            ? "Winnow’s classifier evaluated representative recent examples\(pool). Matches and non-matches are estimates, not a guarantee of future classification."
            : "Winnow checked this exact matcher against representative recent examples\(pool). Future mail may differ."
        guard let note = preview.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty else { return base }
        return "\(base) \(note)"
    }

    private func sampleSection(_ title: String, examples: [MailRulePreviewMatch], empty: String) -> some View {
        Section(title) {
            if examples.isEmpty {
                Text(empty).foregroundStyle(.secondary)
            } else {
                ForEach(examples.prefix(10)) { example in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(example.subject).font(.subheadline.weight(.semibold))
                        Text(example.from).font(.caption).foregroundStyle(.secondary)
                        if let reason = example.reason {
                            Text(reason).font(.caption).foregroundStyle(.secondary)
                        }
                        HStack(spacing: 6) {
                            if !example.account.isEmpty { Text(example.account) }
                            if let confidence = example.confidencePercentText { Text(confidence) }
                        }
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }
}
