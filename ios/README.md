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

## V1 boundaries

- The app refreshes only while in the foreground. APNs delivery is not enabled yet, so Slack remains the notification fallback.
- Email bodies stay in Gmail; Winnow shows its bounded snippet and structured triage fields.
- This is deliberately personal-use infrastructure: no user accounts, onboarding service, analytics, or multi-tenant product work.
