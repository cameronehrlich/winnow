<p align="center">
  <h1 align="center">🌾 Winnow</h1>
  <p align="center">
    <strong>AI email triage that lives in Slack, Discord, or wherever you already hang out</strong>
  </p>
  <p align="center">
    <a href="#quickstart">Quickstart</a> •
    <a href="#how-it-works">How It Works</a> •
    <a href="#rules">Rules</a> •
    <a href="#commands">Commands</a> •
    <a href="#contributing">Contributing</a>
  </p>
</p>

---

Winnow brings your email into the tools you actually use. Every email posts to Slack (or your messaging platform of choice) as it arrives — triaged by AI, with the noise auto-archived so you only see what matters. It's also a full CLI for managing your inbox from the terminal.

Stop context-switching to Gmail. Let your inbox come to you.

```
#work-email
📥 Jane Smith — Meeting tomorrow at 3pm
📥 Your Bank — Wire transfer received
🗂️ LinkedIn — You appeared in 3 searches (archived, 92%)
🔑 GitHub — Your verification code is 847291 (copied to clipboard)

#personal-email
📥 Dr. Smith — Appointment reminder for Friday
🗂️ Promo — 50% off everything! (archived, 95%)
📌 USPS — Package delivered to front door (archived)
📌 Procare — Noa checked in at 8:15am (archived)
```

## Why Winnow?

- **Email → Messaging** — Every email appears in Slack, Discord, or your favorite platform. Multiple accounts route to separate channels. Your inbox becomes a feed you can glance at without opening Gmail.
- **AI Triage** — Winnow uses Gemini to classify each email: archive it or keep it. Marketing, newsletters, and noise get auto-archived. Important emails stay in your inbox.
- **Plain-English Rules** — No regex, no filters, no query syntax. Just write what you mean: *"Archive Robinhood statements unless something looks wrong."*
- **CLI-First** — Scan, triage, add rules, check stats — all from the terminal. Run it as a one-shot command or a background daemon.
- **Multi-Account** — Personal and work inboxes, each with their own rules and notification channel. One tool for all your email.
- **Private** — Runs locally on your machine. Sender, subject, snippet, and a capped message body excerpt go to the AI; credentials and state stay local.
- **Safe** — Never deletes anything. Only archives. Low-confidence classifications stay in your inbox. Everything is configurable.

## Quickstart

### Prerequisites

- **Node.js** 18+
- **[gog](https://github.com/xlab-si/gog)** — Gmail CLI adapter (handles OAuth)
- **Gemini API key** — [Get one free](https://aistudio.google.com/apikey)
- **Slack Bot Token** *(optional but recommended)* — For the email feed

### Install

```bash
git clone https://github.com/cameronehrlich/winnow.git
cd winnow
npm install
```

### Configure

```bash
cp config/config.yaml.example config/config.yaml
cp .env.example .env
```

Edit `config/config.yaml`:

```yaml
accounts:
  - email: you@gmail.com
    channel: C0YOUR_CHANNEL  # Slack channel for this account's emails

adapter: gog

slack:
  bot_token: ""                  # prefer SLACK_BOT_TOKEN in .env
  app_token: ""                  # prefer SLACK_APP_TOKEN in .env for button actions
  channel_id: C0DEFAULT_CHANNEL  # fallback channel for accounts without a channel

model:
  name: gemini-2.5-flash

feed: true  # post every email to your messaging platform

scan:
  max_messages: 50
  search_query: "in:inbox is:unread newer_than:1d"
```

Set credentials in `.env`:

```bash
GEMINI_API_KEY=your_gemini_key
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_APP_TOKEN=xapp-your-token
```

Authenticate your Gmail account(s):

```bash
gog auth login you@gmail.com
```

### Run

```bash
# One-shot scan — triage and notify
./bin/winnow scan

# Watch mode — real-time email feed (polls every 30s by default)
./bin/winnow watch

# Always-on with PM2
pm2 start ecosystem.config.cjs
```

Once running, every email shows up in your Slack channel with an emoji indicating what happened:
- 📥 Kept in inbox
- 🗂️ Auto-archived
- 🔑 OTP code extracted and copied to clipboard
- 📌 Ephemeral FYI (delivered, checked in, etc.)

## How It Works

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Gmail    │────▶│  Winnow  │────▶│  Gemini  │────▶│  Gmail   │
│  (unread) │     │  (scan)  │     │ (classify)│    │ (archive) │
└──────────┘     └────┬─────┘     └──────────┘     └──────────┘
                      │
                      ▼
              ┌───────────────┐
              │ Slack/Discord │
              │  (email feed) │
              └───────────────┘
```

1. **Scan** — Polls Gmail for unread messages and fetches metadata, headers, and a capped body excerpt for classification.

2. **Classify** — Each email is sent to Gemini with your rules. The AI returns: archive or keep, confidence score, and a summary.

3. **Act** — Archived emails get removed from inbox and labeled. Kept emails are left untouched. OTP codes get copied to your clipboard.

4. **Notify** — Every email posts to your messaging platform in real-time, routed to the right channel per account. Daily archive reports summarize what was handled.

### Ephemeral Emails

Some emails are briefly useful but don't need to live in your inbox:

- **🔑 OTP/2FA codes** — Extracted, copied to clipboard, macOS notification, then archived
- **📌 Delivery updates** — "Package delivered" → posted to your channel, archived
- **📌 School check-ins** — "Noa checked in at 8:15am" → posted, archived

## The Email Feed

The core feature: **every email becomes a message in your channel.** You get a real-time stream of your inbox without ever opening Gmail.

Each account routes to its own channel, so work and personal stay separate:

```yaml
accounts:
  - email: personal@gmail.com
    channel: C0PERSONAL    # → #personal-email
  - email: work@company.com
    channel: C0WORK        # → #work-email
```

Toggle the feed on or off anytime:

```bash
winnow feed on      # every email posts to your channel
winnow feed off     # CLI-only mode, no notifications
winnow feed status  # check current state
```

### Notification Platforms

| Platform | Status | How |
|----------|--------|-----|
| **Slack** | ✅ Supported | Bot/app tokens in `.env` + channel IDs in config |
| **Discord** | 🔜 Planned | Webhook URL |
| **Telegram** | 🔜 Planned | Bot token + chat ID |
| **Desktop** | ✅ Partial | macOS notifications for OTP codes |
| **Custom** | 💡 Future | Webhook adapter for any platform |

## Rules

### Baseline Rules

Ship with Winnow. Sensible defaults:

```yaml
rules:
  - id: marketing-promo
    match: "Marketing, promotional, or sales emails"
    archive: true

  - id: security-alerts
    match: "Security alerts, fraud warnings, unusual sign-in activity"
    archive: false

  - id: 2fa-codes
    match: "Two-factor authentication codes, verification codes"
    archive: false
```

### Per-Account Rules

Each account has its own rules file. Plain English, no regex:

```yaml
# config/rules-you@gmail.com.yaml
rules:
  - id: nextdoor-digest
    match: "Nextdoor neighborhood digest emails"
    archive: true

  - id: mychart-messages
    match: >-
      MyChart messages from doctors or care teams should NOT be archived.
      Only archive MyChart marketing or surveys.
    archive: false
```

### Managing Rules

```bash
# List rules
winnow rules -a you@gmail.com

# Add a rule
winnow rule add "Archive LinkedIn recruiter InMail" -a you@gmail.com

# Keep instead of archive
winnow rule add "Emails from my doctor" -a you@gmail.com --keep

# Remove a rule
winnow rule remove nextdoor-digest -a you@gmail.com
```

### Confidence Threshold

If the AI's confidence is below 70%, the email stays in your inbox no matter what. This is the only hardcoded behavior — everything else is configurable through rules.

## Commands

| Command | Description |
|---------|-------------|
| `winnow scan` | Scan and triage unread emails |
| `winnow watch` | Real-time watch mode (polls every 15s) |
| `winnow run` | Scan all accounts + post daily digest |
| `winnow rescan --since 7d` | Re-classify emails with current rules |
| `winnow digest` | Generate and post archive report |
| `winnow rules` | List all active rules |
| `winnow rule add <desc> -a <email>` | Add a custom rule |
| `winnow rule remove <id> -a <email>` | Remove a custom rule |
| `winnow stats` | Processing statistics and daily breakdown |
| `winnow check` | Health check — verify everything works |
| `winnow check --fix` | Auto-fix issues (re-archive stuck emails) |
| `winnow feed on/off/status` | Toggle the email feed |
| `winnow alerts on/off/status` | Mute/unmute notifications |

### Common Options

```bash
--account, -a <email>   Target a specific account
--dry-run               Classify without taking any Gmail actions
--since <duration>      Time window (e.g., 7d, 24h)
```

## Architecture

```
winnow/
├── bin/winnow              # CLI entrypoint
├── .env                    # Local credentials (gitignored)
├── config/
│   ├── config.yaml         # Main config (gitignored)
│   ├── config.yaml.example # Template
│   ├── baseline-rules.yaml # Default rules (ships with winnow)
│   └── rules-*.yaml        # Per-account custom rules
├── src/
│   ├── cli.js              # Command definitions (commander)
│   ├── scan.js             # Core scan loop
│   ├── classify.js         # Gemini classification
│   ├── rules.js            # Rule loading & merging
│   ├── notify.js           # Notifications & email feed
│   ├── slack-actions.js    # Slack button actions via Socket Mode
│   ├── digest.js           # Daily archive report
│   ├── config.js           # Config & account routing
│   ├── state.js            # Persistent state (processed IDs, stats)
│   ├── check.js            # Health checks & auto-fix
│   ├── watch.js            # Real-time watch mode
│   └── adapters/
│       └── gog.js          # Gmail adapter via gog CLI
├── scripts/                # Optional rule action hooks
├── data/
│   └── state.json          # Processing state (gitignored)
└── test/
    └── notify.test.js      # Notification tests
```

### Gmail Adapters

Winnow accesses Gmail through a pluggable adapter interface. Swap backends without touching classification or notification logic.

| Adapter | Status | Description |
|---------|--------|-------------|
| **[gog](https://github.com/xlab-si/gog)** | ✅ Supported | Google CLI with OAuth. Current default. |
| **[gws](https://github.com/googleworkspace/cli)** | 🔜 Planned | Google's official Workspace CLI. Structured JSON output. |
| **Gmail API** | 🔜 Planned | Direct Gmail REST API — no CLI dependency. |
| **IMAP** | 💡 Future | For non-Gmail providers (Outlook, Fastmail, etc.) |

Want to add an adapter? Implement the `GmailAdapter` interface in `src/adapters/` — see `gog.js` for reference.

### Design Decisions

- **Never delete** — Only archive. Everything is recoverable from Gmail's All Mail.
- **Capped AI input** — Classification uses sender, subject, snippet, and a bounded body excerpt so summaries are more useful without sending unlimited message content.
- **Low-confidence = keep** — Below 70% confidence, emails stay in the inbox.
- **Pluggable everything** — Gmail adapters, notification targets, AI models — all swappable.

## Running with PM2

For always-on email feed:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # auto-start on boot
```

`ecosystem.config.cjs` loads `.env` automatically, so normal PM2 restarts pick up local credentials without hardcoded secrets in the tracked config. It runs `winnow watch --interval 10` as a daemon and posts to your channels in real time.

## Contributing

Winnow is young and opinionated — contributions are welcome.

### Good First Issues

- **Notification targets** — Discord webhooks, Telegram bot, ntfy, Pushover, generic webhooks
- **New Gmail adapters** — `gws` (Google Workspace CLI), direct Gmail API, IMAP, Outlook/Exchange
- **AI models** — OpenAI, Claude, local models via Ollama
- **Rule improvements** — Regex support, sender-based rules, time-based rules
- **Tests** — More coverage, especially classification edge cases

### Development

```bash
git clone https://github.com/cameronehrlich/winnow.git
cd winnow
npm install

# Run tests
npm test

# Dry-run scan (no Gmail changes)
./bin/winnow scan --dry-run

# Check health
./bin/winnow check
```

### Guidelines

- Keep it simple. Winnow is a CLI, not a platform.
- Plain English rules are a feature, not a limitation.
- Privacy-first: no telemetry, no cloud, no accounts.
- When in doubt, don't archive.

## License

MIT

---

<p align="center">
  <sub>
    <strong>winnow</strong> <em>(verb)</em> — to separate grain from chaff; to sift; to examine closely in order to separate the good from the bad.
  </sub>
</p>
