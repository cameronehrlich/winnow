# Winnow for iPhone

A personal, native SwiftUI client for Winnow. V1 keeps the useful, dynamic parts of the Slack cards while making inbox triage faster and less rigid.

## What V1 includes

- Separate Inbox and Archived tabs, each with account filtering and its own search
- Compact Slack-inspired cards with contextual Archive, Move to Inbox, and Unsubscribe buttons
- Swipe right from Inbox to archive; swipe left from Archived to restore
- Winnow's summary and meaningful recommended action in the feed, with deadline, impact, handling, reason, and confidence in detail
- Opening an in-app detail marks the message read; manual read/unread remains available in detail
- A safe confirmation step and truthful manual-action state for unsubscribe flows
- An account-aware **Open in Gmail** link on every email detail
- Lifetime and Today stats plus recent activity
- Server health merged with per-account scan state in Settings
- Pull to refresh, refresh whenever the app becomes active, and 30-second foreground refresh
- APNs alerts for Inbox mail, silent refreshes for automatically archived mail, and push deep links
- Inbox app-icon/tab badges plus a "new since viewed" Archived tab badge
- Small and medium Inbox widgets with current attention count and email deep links
- A global Ask tab for mailbox questions and search, with an explicit account scope
- A contextual Ask Winnow sheet on every email for questions, drafting, unsubscribe, and future-mail handling
- Evidence cards, draft review/revision, and exact confirmation sheets for persistent or outbound actions
- Loading, empty, offline, and action-error states
- Server URL in preferences and bearer token in the iOS Keychain

There are no third-party app dependencies.

## Requirements

- Xcode 26 or newer
- iOS 17 or newer
- A reachable Winnow API with `WINNOW_API_TOKEN` configured
- For a physical phone, the phone and Mac connected to the same Tailscale tailnet

## Private device connection

Keep Winnow bound to localhost and expose only that port to the private tailnet with Tailscale Serve:

```bash
tailscale serve --bg --https=9443 http://127.0.0.1:3777
tailscale serve status
```

Use this URL in the app:

```text
https://<mac-hostname>.<tailnet>.ts.net:9443
```

Tailscale provides HTTPS transport and tailnet access control. The app intentionally has no App Transport Security exception for plain HTTP.

## Build and run

Open `Winnow.xcodeproj`, select the **Winnow** scheme, choose an iPhone, and Run. The project uses automatic signing with the existing Thirty Seven Inc development team.

Command-line simulator build:

```bash
xcodebuild \
  -project ios/Winnow.xcodeproj \
  -scheme Winnow \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath /tmp/WinnowDerivedData \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Run unit tests:

```bash
xcodebuild test \
  -project ios/Winnow.xcodeproj \
  -scheme Winnow \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath /tmp/WinnowDerivedData \
  CODE_SIGNING_ALLOWED=NO
```

## First-launch setup

Normally, enter the private HTTPS server URL and bearer token in onboarding. The URL is stored in preferences and the token is stored with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` in Keychain.

Debug builds can also be seeded without embedding secrets:

- `WINNOW_SERVER_URL`
- `WINNOW_API_TOKEN`

The values are persisted once to preferences/Keychain, so a signed development build remains configured on the next normal launch. For Simulator, pass them through `SIMCTL_CHILD_WINNOW_SERVER_URL` and `SIMCTL_CHILD_WINNOW_API_TOKEN` when launching with `simctl`. Never put a real hostname or token in this repository or a shared Xcode scheme.

## Push and widget provisioning

The development identifiers are `com.cameronehrlich.Winnow` and
`com.cameronehrlich.Winnow.WinnowWidget`. They share the
`group.com.cameronehrlich.Winnow` App Group. Xcode automatic signing manages the
development profiles; an App Store Connect app record is not required.

One Apple Developer account-holder step remains before the backend can deliver
real pushes:

1. Open **Apple Developer → Certificates, Identifiers & Profiles → Keys**.
2. Create a key named **Winnow APNs**, enable **Apple Push Notifications service
   (APNs)**, and download its `.p8` file. Apple permits this download only once.
3. Put the key outside the repository with owner-only permissions and configure
   `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_BUNDLE_ID=com.cameronehrlich.Winnow`, and
   `APNS_PRIVATE_KEY_PATH` in Winnow's private runtime environment.

The backend uses the same token-based key for development and production APNs,
while keeping each registered device token's environment explicit.

## V1 boundaries

- Slack remains a notification fallback if APNs credentials are not installed.
- The normal feed keeps email bodies in Gmail and shows bounded snippets and structured triage fields. Ask Winnow fetches a bounded thread excerpt on demand and sends it to the configured Gemini model, but does not persist the incoming raw body in assistant tables.
- Assistant conversations are current-session UI in V1; there is no conversation-history picker yet.
- Draft changes are requested conversationally. There is no direct rich-text draft editor in V1.
- This is deliberately personal-use infrastructure: no user accounts, onboarding service, analytics, or multi-tenant product work.
