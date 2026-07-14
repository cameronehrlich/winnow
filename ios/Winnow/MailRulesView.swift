import SwiftUI

struct MailRulesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedAccount = ""
    @State private var searchText = ""
    @State private var editingRule: MailRule?

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
                .pickerStyle(.menu)
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
                            toggle: { enabled in
                                Task { _ = await model.setMailRuleEnabled(rule, enabled: enabled) }
                            },
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
                            reset: { Task { _ = await model.resetMailRule(rule) } }
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
        .listSectionSpacing(.compact)
        .tint(WinnowDesign.accent)
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
    }

    private func emptyRow(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .font(.subheadline)
            .foregroundStyle(.secondary)
    }
}

private struct MailRuleRow: View {
    let rule: MailRule
    let isBusy: Bool
    var toggle: ((Bool) -> Void)?
    var edit: (() -> Void)?
    var customize: (() -> Void)?
    var reset: (() -> Void)?
    @State private var pendingToggle: Bool?
    @State private var confirmReset = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(rule.displayTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(rule.enabled ? Color.primary : Color.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                if let supportingTitle = rule.supportingTitle {
                    Text(supportingTitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                HStack(spacing: 5) {
                    Text(rule.accountTitle)
                    if rule.isBaselineCustomization {
                        Text("•")
                        Text("Customized")
                    }
                    if let activity = rule.activity, activity.appliedCount30Days > 0 {
                        Text("•")
                        Text("\(activity.appliedCount30Days) uses")
                    }
                }
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .trailing, spacing: 7) {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 51, height: 31)
                } else if let toggle {
                    Toggle(
                        "Rule enabled",
                        isOn: Binding(
                            get: { rule.enabled },
                            set: { pendingToggle = $0 }
                        )
                    )
                        .labelsHidden()
                        .tint(WinnowDesign.accent)
                        .accessibilityValue(rule.enabled ? "On" : "Off")
                        .confirmationDialog(
                            pendingToggle == true ? "Enable this rule?" : "Disable this rule?",
                            isPresented: Binding(
                                get: { pendingToggle != nil },
                                set: { if !$0 { pendingToggle = nil } }
                            ),
                            titleVisibility: .visible
                        ) {
                            if let enabled = pendingToggle {
                                Button(
                                    enabled ? "Enable Rule" : "Disable Rule",
                                    role: enabled ? nil : .destructive
                                ) {
                                    pendingToggle = nil
                                    toggle(enabled)
                                }
                            }
                            Button("Cancel", role: .cancel) { pendingToggle = nil }
                        } message: {
                            if let enabled = pendingToggle {
                                Text("Future matching messages will \(enabled ? rule.actionTitle.lowercased() : "return to normal Winnow handling").")
                            }
                        }
                } else if rule.isLockedAutomation {
                    Image(systemName: "lock.fill")
                        .foregroundStyle(.secondary)
                        .frame(width: 31, height: 31)
                        .accessibilityLabel("Managed on server")
                }

                HStack(spacing: 6) {
                    effectIcon
                    trailingAction
                }
            }
        }
        .padding(.vertical, 2)
        .listRowInsets(EdgeInsets(top: 7, leading: 16, bottom: 7, trailing: 16))
        .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
        .alignmentGuide(.listRowSeparatorTrailing) { dimensions in dimensions.width }
        .listRowSeparatorTint(Color(uiColor: UIColor.separator).opacity(0.65))
    }

    private var effectColor: Color {
        rule.effect == "archive" ? WinnowDesign.accent : WinnowDesign.mint
    }

    private var effectIcon: some View {
        Image(systemName: rule.actionSymbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(effectColor)
            .frame(width: 29, height: 29)
            .background(effectColor.opacity(0.14), in: Circle())
            .accessibilityLabel(rule.actionTitle)
    }

    @ViewBuilder
    private var trailingAction: some View {
        if let edit {
            compactButton(symbol: "pencil", label: "Edit rule", action: edit)
        } else if let customize {
            if rule.canReset, let reset {
                Menu {
                    Button("Edit Customization", systemImage: "pencil", action: customize)
                    Button(
                        "Reset to Winnow Default",
                        systemImage: "arrow.counterclockwise",
                        role: .destructive,
                        action: { confirmReset = true }
                    )
                } label: {
                    compactIcon(symbol: "ellipsis")
                }
                .accessibilityLabel("Rule options")
                .confirmationDialog(
                    "Reset this default?",
                    isPresented: $confirmReset,
                    titleVisibility: .visible
                ) {
                    Button("Reset to Winnow Default", role: .destructive, action: reset)
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Your customization will be removed. Future mail will use Winnow’s original rule again.")
                }
            } else {
                compactButton(symbol: "slider.horizontal.3", label: "Customize rule", action: customize)
            }
        }
    }

    private func compactButton(symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            compactIcon(symbol: symbol)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private func compactIcon(symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(WinnowDesign.accent)
            .frame(width: 29, height: 29)
            .background(WinnowDesign.accent.opacity(0.12), in: Circle())
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
        let subjectIsValid = draft.type != "exact" || draft.subjectMatchMode == nil
            || draft.subjectMatchValue?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        let accountIsScoped = !rule.isBaseline
            || draft.account?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        return matcherIsPresent && subjectIsValid && accountIsScoped && !isPreviewing && !isSaving
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

                        Toggle("Limit to subject", isOn: Binding(
                            get: { draft.subjectMatchMode != nil },
                            set: { enabled in
                                draft.subjectMatchMode = enabled ? "exact" : nil
                                if !enabled { draft.subjectMatchValue = nil }
                            }
                        ))

                        if draft.subjectMatchMode != nil {
                            Picker("Subject match", selection: Binding(
                                get: { draft.subjectMatchMode ?? "exact" },
                                set: { draft.subjectMatchMode = $0 }
                            )) {
                                Text("Exactly").tag("exact")
                                Text("Starts With").tag("prefix")
                            }
                            TextField("Subject", text: Binding(
                                get: { draft.subjectMatchValue ?? "" },
                                set: { draft.subjectMatchValue = $0 }
                            ))
                        }
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
