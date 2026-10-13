import SwiftUI
import UIKit

struct EmailAddressSuggestion: Decodable, Equatable, Identifiable {
    let name: String
    let email: String
    var id: String { email.lowercased() }
}

struct EmailAddressSuggestionsResponse: Decodable {
    let candidates: [EmailAddressSuggestion]
}

// Work on the recipient at the caret, not necessarily the last recipient.
// Quoted display-name commas and Unicode are preserved when another address is chosen.
struct EmailAddressEntry {
    let text: String
    let range: NSRange

    init(text: String, caret: Int, allowsMultiple: Bool) {
        self.text = text
        let length = text.utf16.count
        let cursor = min(max(0, caret), length)
        var start = 0
        var offset = 0
        var quoted = false
        var escaped = false
        var depth = 0
        var ranges: [NSRange] = []
        for character in text {
            let size = String(character).utf16.count
            defer { offset += size }
            if escaped { escaped = false; continue }
            if quoted && character == "\\" { escaped = true; continue }
            if character == "\"" { quoted.toggle(); continue }
            if !quoted {
                if character == "<" { depth += 1 }
                if character == ">" { depth = max(0, depth - 1) }
                if allowsMultiple && depth == 0 && (character == "," || character == ";") {
                    ranges.append(NSRange(location: start, length: offset - start))
                    start = offset + size
                }
            }
        }
        ranges.append(NSRange(location: start, length: length - start))
        range = ranges.first { cursor >= $0.location && cursor <= NSMaxRange($0) } ?? ranges.last!
    }

    var query: String {
        let token = (text as NSString).substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines)
        let parsed = EmailParticipant.parseHeader(token).first
        return parsed?.emailAddress.nilIfEmpty ?? parsed?.displayName ?? token
    }

    var otherAddresses: Set<String> {
        let remaining = (text as NSString).replacingCharacters(in: range, with: "")
        return Set(EmailParticipant.parseHeader(remaining).map { $0.emailAddress.lowercased() }.filter { !$0.isEmpty })
    }

    func completing(with address: String) -> (text: String, caret: Int)? {
        let email = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !email.isEmpty, !otherAddresses.contains(email.lowercased()) else { return nil }
        let original = (text as NSString).substring(with: range)
        let whitespace = String(original.prefix(while: \.isWhitespace))
        let replacement = whitespace + email
        return ((text as NSString).replacingCharacters(in: range, with: replacement), range.location + replacement.utf16.count)
    }
}

struct EmailAddressField: View {
    @Binding var text: String
    @Binding var focused: Bool
    let configuration: ServerConfiguration
    let account: String
    var allowsMultiple = false
    var suggestionsSession: URLSession? = nil
    @State private var caret = 0
    @State private var suggestions: [EmailAddressSuggestion] = []
    @State private var resultKey = ""
    @State private var lookupFailed = false
    @State private var showingContacts = false
    @State private var duplicateAddress = false

    private var entry: EmailAddressEntry {
        EmailAddressEntry(text: text, caret: caret, allowsMultiple: allowsMultiple)
    }

    private var lookupKey: String {
        "\(configuration.serverURL)\u{0}\(account)\u{0}\(focused)\u{0}\(caret)\u{0}\(text)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                AddressTextField(text: $text, focused: $focused, caret: $caret)
                    .frame(minHeight: 36)
                Button {
                    focused = false
                    showingContacts = true
                } label: {
                    Image(systemName: "person.crop.circle.badge.plus")
                        .font(.title3)
                        .frame(minWidth: 36, minHeight: 36)
                }
                .buttonStyle(.plain)
                .foregroundStyle(WinnowDesign.accent)
                .accessibilityLabel("Choose an email address from Contacts")
            }
            if focused && resultKey == lookupKey {
                ForEach(suggestions.filter {
                    !entry.otherAddresses.contains($0.email.lowercased())
                        && $0.email.caseInsensitiveCompare(entry.query) != .orderedSame
                }) { suggestion in
                    Button { choose(suggestion.email) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                if suggestion.name.caseInsensitiveCompare(suggestion.email) != .orderedSame {
                                    Text(verbatim: suggestion.name).font(.subheadline.weight(.medium)).lineLimit(1)
                                }
                                Text(verbatim: suggestion.email)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            Spacer(minLength: 4)
                            Image(systemName: "arrow.up.left").font(.caption).foregroundStyle(.tertiary)
                        }
                        .foregroundStyle(.primary)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Use \(suggestion.name), \(suggestion.email)")
                }
                if lookupFailed {
                    Text("Suggestions unavailable. Enter an address or choose a contact.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if duplicateAddress {
                Text("That address is already included.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .onChange(of: text) { _, _ in duplicateAddress = false }
        .task(id: lookupKey) {
            suggestions = []
            lookupFailed = false
            let query = entry.query
            let key = lookupKey
            guard focused, query.count >= 2, query.count <= 200 else { return }
            do {
                try await Task.sleep(for: .milliseconds(250))
                let candidates = try await APIClient(configuration: configuration, session: suggestionsSession)
                    .emailAddressSuggestions(query: query, account: account)
                try Task.checkCancellation()
                guard key == lookupKey else { return }
                suggestions = candidates
                resultKey = key
            } catch {
                guard !Task.isCancelled, key == lookupKey else { return }
                lookupFailed = true
                resultKey = key
            }
        }
        .sheet(isPresented: $showingContacts, onDismiss: { focused = true }) {
            ContactEmailPicker(suggestedName: entry.query) { _, email in
                choose(email)
                focused = false
                showingContacts = false
            } cancelled: {
                showingContacts = false
            }
        }
    }

    private func choose(_ email: String) {
        guard let completed = entry.completing(with: email) else {
            duplicateAddress = true
            focused = true
            return
        }
        text = completed.text
        caret = completed.caret
        suggestions = []
        focused = true
    }
}

// UITextField exposes caret position on iOS 17 too, keeping completion correct
// when editing the middle of a multi-recipient field on iPhone, iPad and Catalyst.
private struct AddressTextField: UIViewRepresentable {
    @Environment(\.isEnabled) private var isEnabled
    @Binding var text: String
    @Binding var focused: Bool
    @Binding var caret: Int

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.placeholder = "Email address"
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.keyboardType = .emailAddress
        field.textContentType = .emailAddress
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.returnKeyType = .done
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.edited(_:)), for: .editingChanged)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.accessibilityLabel = "Email address"
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.parent = self
        field.isEnabled = isEnabled
        if field.text != text {
            field.text = text
            if let position = field.position(from: field.beginningOfDocument, offset: min(caret, text.utf16.count)) {
                field.selectedTextRange = field.textRange(from: position, to: position)
            }
        }
        if focused && isEnabled && !field.isFirstResponder {
            DispatchQueue.main.async { [weak field] in
                guard context.coordinator.parent.focused, context.coordinator.parent.isEnabled else { return }
                field?.becomeFirstResponder()
            }
        } else if (!focused || !isEnabled) && field.isFirstResponder {
            field.resignFirstResponder()
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: AddressTextField
        init(_ parent: AddressTextField) { self.parent = parent }
        @objc func edited(_ field: UITextField) {
            parent.text = field.text ?? ""
            updateCaret(field)
        }
        func textFieldDidChangeSelection(_ field: UITextField) { updateCaret(field) }
        func textFieldDidBeginEditing(_ field: UITextField) { parent.focused = true; updateCaret(field) }
        func textFieldDidEndEditing(_ field: UITextField) { parent.focused = false }
        func textFieldShouldReturn(_ field: UITextField) -> Bool { parent.focused = false; return true }
        private func updateCaret(_ field: UITextField) {
            guard let selection = field.selectedTextRange else { return }
            parent.caret = field.offset(from: field.beginningOfDocument, to: selection.end)
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
