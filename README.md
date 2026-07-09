<p align="center">
  <h1 align="center">🌾 Winnow</h1>
  <p align="center">
    <strong>Local AI email triage with Slack actions, SQLite analytics, and a private API</strong>
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

Winnow is a local email triage daemon. It scans Gmail, classifies messages with AI, archives low-value mail, posts an actionable Slack feed, and records every scan/action in SQLite for summaries and future app clients.

The current production surface is Slack plus a private localhost API. Discord/Telegram-style targets are planned adapter work, not current behavior.

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
📌 School — Check-in update received (archived)
```

## Why Winnow?

- **Email → Slack** — Every email can appear in Slack. Multiple accounts route to separate channels. Your inbox becomes a feed you can glance at without opening Gmail.
- **AI Triage** — Winnow uses Gemini to classify each email: archive it or keep it. Marketing, newsletters, and noise get auto-archived. Important emails stay in your inbox.
- **Plain-English Rules** — No regex, no filters, no query syntax. Just write what you mean: *"Archive Robinhood statements unless something looks wrong."*
- **CLI + Daemon** — Scan, triage, add rules, check stats, and run an always-on local daemon.
- **Private API + Analytics** — The daemon exposes a bearer-token localhost API and writes a durable event log to SQLite.
- **Multi-Account** — Personal and work inboxes, each with their own rules and notification channel. One tool for all your email.
- **Private** — Runs locally on your machine. Sender, subject, snippet, and a capped message body excerpt go to the AI; credentials and state stay local.
- **Safe** — Never deletes anything. Only archives. Low-confidence classifications stay in your inbox. Everything is configurable.

## Quickstart

### Prerequisites

- **Node.js** 24.18+ LTS (uses built-in SQLite support; see `.nvmrc`)
- **Homebrew** — Recommended for installing external runtime tools
- **[gogcli](https://gogcli.sh)** 0.31.1+ — Gmail CLI adapter (handles OAuth)
- **Gemini API key** — [Get one free](https://aistudio.google.com/apikey)
- **Slack Bot/App Tokens** *(optional but recommended)* — For the email feed and buttons

### Install

```bash
git clone https://github.com/cameronehrlich/winnow.git
cd winnow
brew bundle
npm install
```

`brew bundle` installs `gogcli` from the tracked `Brewfile`. If you do not use Homebrew, install `gog` separately and make sure `gog --version` reports `0.31.1` or newer.

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
  - email: work@example.com
    slack:
      channel_id: C0WORK_CHANNEL
      bot_token_env: WORK_SLACK_BOT_TOKEN
      app_token_env: WORK_SLACK_APP_TOKEN

adapter: gog

slack:
  bot_token: ""                  # prefer SLACK_BOT_TOKEN in .env
  app_token: ""                  # prefer SLACK_APP_TOKEN in .env for button actions
  channel_id: C0DEFAULT_CHANNEL  # fallback channel for accounts without a channel
  # account-level slack tokens override these for separate workspaces

model:
  name: gemini-2.5-flash

feed: true  # post every processed email to Slack

scan:
  max_messages: 50
  search_query: "in:inbox is:unread newer_than:1d"
```

Set credentials in `.env`:

```bash
GEMINI_API_KEY=your_gemini_key
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_APP_TOKEN=xapp-your-token
WORK_SLACK_BOT_TOKEN=xoxb-your-workspace-token
WORK_SLACK_APP_TOKEN=xapp-your-workspace-token
WINNOW_API_TOKEN=generate-a-long-random-token
```

Authenticate your Gmail account(s):

```bash
gog auth add you@gmail.com --services gmail
```

### Run

```bash
# One-shot scan — triage and notify
./bin/winnow scan

# Watch mode — real-time email feed (polls every 30s by default)
./bin/winnow watch

# Daemon mode — scanner + Slack actions + local API + mailbox reconciliation
./bin/winnow daemon

# Always-on with PM2
pm2 start ecosystem.config.cjs

# Verify local runtime dependencies and Gmail adapter compatibility
./bin/winnow doctor

# Verify mailbox/state health
./bin/winnow check
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
              │ Slack + API   │
              │ feed/events   │
              └───────────────┘
```

1. **Scan** — Polls Gmail for unread messages and fetches metadata, headers, and a capped body excerpt for classification.

2. **Classify** — Each email is sent to Gemini with your rules. The AI returns: archive or keep, confidence score, and a summary.

3. **Act** — Archived emails get removed from inbox and labeled. Kept emails are left untouched. OTP codes get copied to your clipboard.

4. **Track + Notify** — Every email is written to the local feed/event store. Slack receives feed posts according to your config, and structured summaries are available from the CLI/API.

### Ephemeral Emails

Some emails are briefly useful but don't need to live in your inbox:

- **🔑 OTP/2FA codes** — Extracted, copied to clipboard, macOS notification, then archived
- **📌 Delivery updates** — "Package delivered" → posted to your channel, archived
- **📌 School check-ins** — "Check-in update received" → posted, archived

## The Email Feed

The core feature: **every email becomes a message in your channel.** You get a real-time stream of your inbox without ever opening Gmail.

Each account routes to its own channel, so work and personal stay separate:

```yaml
accounts:
  - email: personal@gmail.com
    channel: C0PERSONAL    # → #personal-email
  - email: work@company.com
    channel: C0WORK        # → #work-email
  - email: partner@example.com
    slack:
      channel_id: C0PARTNER
      bot_token_env: PARTNER_SLACK_BOT_TOKEN
      app_token_env: PARTNER_SLACK_APP_TOKEN
```

For a separate Slack workspace, configure account-level `slack.bot_token_env` and `slack.app_token_env`.
Posting only needs the bot token; button actions need a Socket Mode app token for that workspace too.

Toggle the feed on or off anytime:

```bash
winnow feed on      # every email posts to your channel
winnow feed off     # CLI-only mode, no notifications
winnow feed status  # check current state
```

### Notification Targets

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
      Patient portal messages from doctors or care teams should NOT be archived.
      Only archive portal marketing or surveys.
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
| `winnow watch` | Real-time watch mode (polls every 30s by default) |
| `winnow daemon` | Run scanner, Slack actions, local API, and mailbox reconciliation |
| `winnow run` | Scan all accounts + print today's structured summary |
| `winnow rescan --since 7d` | Re-classify emails with current rules |
| `winnow summary --today` | Show daily action counters and lists |
| `winnow summary --date YYYY-MM-DD --json` | Export structured daily analytics |
| `winnow rules` | List all active rules |
| `winnow rule add <desc> -a <email>` | Add a custom rule |
| `winnow rule remove <id> -a <email>` | Remove a custom rule |
| `winnow stats` | Processing statistics and daily breakdown |
| `winnow doctor` | System check — verify Node, `gog`, auth, and JSON compatibility |
| `winnow check` | Mailbox/state health check |
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
├── Brewfile                # External runtime dependencies
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
│   ├── api.js              # Local private HTTP API
│   ├── mcp.js              # MCP JSON-RPC tool surface
│   ├── status.js           # Shared runtime/account status helpers
│   ├── daemon.js           # Combined runtime process
│   ├── store.js            # SQLite feed/event/analytics store
│   ├── config.js           # Config & account routing
│   ├── state.js            # Persistent state (processed IDs, stats)
│   ├── check.js            # Health checks & auto-fix
│   ├── watch.js            # Real-time watch mode
│   └── adapters/
│       └── gog.js          # Gmail adapter via gog CLI
├── scripts/                # Optional local action hook docs
├── data/
│   ├── state.json          # Legacy processing state (gitignored)
│   └── winnow.db           # SQLite feed/event store (gitignored)
└── test/                   # Node test suite
```

### Gmail Adapters

Winnow accesses Gmail through a pluggable adapter interface. Swap backends without touching classification or notification logic.

| Adapter | Status | Description |
|---------|--------|-------------|
| **[gogcli](https://gogcli.sh)** | ✅ Supported | Google CLI with OAuth. Current default. Tracked as an external dependency in `Brewfile`. |
| **[gws](https://github.com/googleworkspace/cli)** | 🔜 Planned | Google's official Workspace CLI. Structured JSON output. |
| **Gmail API** | 🔜 Planned | Direct Gmail REST API — no CLI dependency. |
| **IMAP** | 💡 Future | For non-Gmail providers (Outlook, Fastmail, etc.) |

Want to add an adapter? Implement the `GmailAdapter` interface in `src/adapters/` — see `gog.js` for reference.

### Design Decisions

- **Never delete** — Only archive. Everything is recoverable from Gmail's All Mail.
- **Capped AI input** — Classification uses sender, subject, snippet, and a bounded body excerpt so summaries are more useful without sending unlimited message content.
- **Low-confidence = keep** — Below 70% confidence, emails stay in the inbox.
- **Local hooks stay local** — Rule action hooks can automate personal workflows, so `scripts/*.sh` is ignored by default. See `scripts/README.md`.
- **Pluggable everything** — Gmail adapters, notification targets, AI models — all swappable.

## Running with PM2

For always-on email feed:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # auto-start on boot
```

`ecosystem.config.cjs` loads `.env` automatically, so normal PM2 restarts pick up local credentials without hardcoded secrets in the tracked config. It runs `winnow daemon`, which starts scanning, Slack actions, the local API, and mailbox reconciliation using the configured daemon interval.

After updating `gogcli`, run:

```bash
./bin/winnow doctor
./bin/winnow check
pm2 restart ecosystem.config.cjs --only winnow-watch --update-env
pm2 save
```

Scheduled Slack archive digests are retired. Use `winnow summary` or the local API for on-demand daily analytics.

## Local API

The daemon exposes a private local API for the future iOS app. Set `WINNOW_API_TOKEN` in `.env`, then call API routes with `Authorization: Bearer <token>`.

Defaults:

```yaml
api:
  host: 127.0.0.1
  port: 3777
```

Useful endpoints:

```bash
curl http://127.0.0.1:3777/health
curl -H "Authorization: Bearer $WINNOW_API_TOKEN" \
  "http://127.0.0.1:3777/v1/status"
curl -H "Authorization: Bearer $WINNOW_API_TOKEN" \
  "http://127.0.0.1:3777/v1/accounts"
curl -H "Authorization: Bearer $WINNOW_API_TOKEN" \
  "http://127.0.0.1:3777/v1/summaries/daily?date=2026-06-29"
curl -H "Authorization: Bearer $WINNOW_API_TOKEN" \
  "http://127.0.0.1:3777/v1/emails?state=all&limit=50"
```

`POST /v1/scans` defaults to `dryRun: true`; pass `{"dryRun": false}` only when an API client should apply Gmail/Slack side effects.
The same bearer token also protects `/mcp`, a Streamable-HTTP-style JSON-RPC endpoint exposing Winnow status, account routing, email lists, summaries, events, dry-run scans, and email actions as MCP tools.

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
brew bundle
npm install

# Run tests
npm test

# Verify runtime dependencies
./bin/winnow doctor

# Dry-run scan (no Gmail changes)
./bin/winnow scan --dry-run

# Check health
./bin/winnow check
```

### Guidelines

- Keep it simple. Winnow is a CLI, not a platform.
- Plain English rules are a feature, not a limitation.
- Privacy-first: no telemetry, no cloud, no accounts.
- Do not commit local credentials, personal rule files, data stores, logs, or action hooks.
- When in doubt, don't archive.

## License

MIT. See `LICENSE`.

---

<p align="center">
  <sub>
    <strong>winnow</strong> <em>(verb)</em> — to separate grain from chaff; to sift; to examine closely in order to separate the good from the bad.
  </sub>
</p>
