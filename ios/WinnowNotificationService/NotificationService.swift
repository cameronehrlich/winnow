import Intents
import UIKit
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private let deliveryLock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var fallbackContent: UNNotificationContent?
    private var updateTask: Task<Void, Never>?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        fallbackContent = request.content
        updateTask = Task { [weak self] in
            guard let self else { return }
            let updatedContent = await Self.communicationContent(for: request)
            deliver(updatedContent)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        updateTask?.cancel()
        if let fallbackContent {
            deliver(fallbackContent)
        }
    }

    private func deliver(_ content: UNNotificationContent) {
        deliveryLock.lock()
        let handler = contentHandler
        contentHandler = nil
        deliveryLock.unlock()
        handler?(content)
    }

    private static func communicationContent(for request: UNNotificationRequest) async -> UNNotificationContent {
        let content = request.content
        let userInfo = content.userInfo
        guard userInfo["event"] as? String == "email.kept",
              let account = userInfo["account"] as? String,
              !account.isEmpty
        else { return content }

        let avatar = await accountAvatar(
            urlString: userInfo["accountAvatarUrl"] as? String,
            account: account
        )
        guard !Task.isCancelled else { return content }

        let senderIdentifier = (userInfo["senderIdentifier"] as? String).flatMap { value in
            value.isEmpty ? nil : value
        } ?? content.title
        let handle = INPersonHandle(
            value: "\(account)|\(senderIdentifier)",
            type: .unknown
        )
        let sender = INPerson(
            personHandle: handle,
            nameComponents: nil,
            displayName: content.title.isEmpty ? "New email" : content.title,
            image: avatar,
            contactIdentifier: nil,
            customIdentifier: nil
        )
        let conversationIdentifier = content.threadIdentifier.isEmpty
            ? "\(account)|\(userInfo["emailId"] as? String ?? request.identifier)"
            : content.threadIdentifier
        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: content.body,
            speakableGroupName: nil,
            conversationIdentifier: conversationIdentifier,
            serviceName: "Winnow",
            sender: sender,
            attachments: nil
        )
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming

        do {
            try await interaction.donate()
            guard !Task.isCancelled else { return content }
            return try content.updating(from: intent)
        } catch {
            return content
        }
    }

    private static func accountAvatar(urlString: String?, account: String) async -> INImage {
        if let urlString,
           urlString.count <= 2_048,
           let url = URL(string: urlString),
           url.scheme?.lowercased() == "https",
           let downloaded = await downloadAvatar(from: url) {
            return downloaded
        }
        return monogramAvatar(for: account)
    }

    private static func downloadAvatar(from url: URL) async -> INImage? {
        var request = URLRequest(
            url: url,
            cachePolicy: .returnCacheDataElseLoad,
            timeoutInterval: 8
        )
        request.setValue("image/*", forHTTPHeaderField: "Accept")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let response = response as? HTTPURLResponse,
                  response.statusCode == 200,
                  data.count <= 2_000_000,
                  UIImage(data: data) != nil
            else { return nil }
            return INImage(imageData: data)
        } catch {
            return nil
        }
    }

    private static func monogramAvatar(for account: String) -> INImage {
        let size = CGSize(width: 128, height: 128)
        let letter = account.first.map { String($0).uppercased() } ?? "?"
        var hash: UInt32 = 2_166_136_261
        for byte in account.utf8 {
            hash ^= UInt32(byte)
            hash &*= 16_777_619
        }
        let background = UIColor(
            hue: CGFloat(hash % 360) / 360,
            saturation: 0.62,
            brightness: 0.72,
            alpha: 1
        )
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { context in
            background.setFill()
            context.fill(CGRect(origin: .zero, size: size))

            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 58, weight: .bold),
                .foregroundColor: UIColor.white,
            ]
            let attributedLetter = NSAttributedString(string: letter, attributes: attributes)
            let textSize = attributedLetter.size()
            attributedLetter.draw(at: CGPoint(
                x: (size.width - textSize.width) / 2,
                y: (size.height - textSize.height) / 2
            ))
        }
        return INImage(imageData: image.pngData() ?? Data())
    }
}
