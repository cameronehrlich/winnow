<p align="center">
  <h1 align="center">🌾 Winnow</h1>
  <p align="center">
    <strong>AI email triage for your terminal — separate the grain from the chaff</strong>
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

Winnow watches your Gmail inbox and uses AI to decide what matters and what doesn't. Marketing emails, automated notifications, newsletters — archived before you ever see them. Important stuff stays in your inbox untouched.

No cloud service. No subscription. Just a CLI that runs on your machine.

```
📥 Jane Smith — Meeting tomorrow at 3pm
📥 Your Bank — Wire transfer received
🗂️ LinkedIn — You appeared in 3 searches (archived, 92%)
🗂️ Promo — 50% off everything! (archived, 95%)
🔑 GitHub — Your verification code is 847291 (copied to clipboard)
📌 USPS — Package delivered to front door (archived)
```

## Why Winnow?

- **Private** — Runs locally. Your emails never leave your machine. Classification happens via Gemini API with just the sender, subject, and snippet — not full email bodies.
- **Plain-English Rules** — No regex, no filters, no query syntax. Just write what you mean: *"Archive Robinhood statements unless something looks wrong."*
- **Multi-Account** — Triage personal and work inboxes independently, each with their own rules and Slack channel.
- **Real-Time** — Watch mode polls every 15 seconds. Emails get triaged before your phone even buzzes.
- **Safe** — Never deletes anything. Only archives. Low-confidence classifications default to keeping emails in your inbox. Sensible baseline rules protect 2FA codes, calendar invites, and payment emails out of the box — but everything is configurable.

## Quickstart

### Prerequisites

- **Node.js** 18+
- **[gog](https://github.com/xlab-si/gog)** — Gmail CLI adapter (handles OAuth)
- **Gemini API key** — [Get one free](https://aistudio.google.com/apikey)
- **Slack Bot Token** *(optional)* — For notifications and daily digest

### Install

```bash
git clone https://github.com/cameronehrlich/winnow.git
cd winnow
npm install
```

### Configure

```bash
cp config/config.yaml.example config/config.yaml
```

Edit `config/config.yaml`:

```yaml
accounts:
  - email: you@gmail.com
    channel: C0YOUR_CHANNEL  # optional: per-account Slack channel

adapter: gog

slack:
  bot_token: xoxb-your-token
  channel_id: C0DEFAULT_CHANNEL

model:
  name: gemini-2.5-flash

feed: true  # post every email to Slack as it's processed

scan:
  max_messages: 50
  search_query: "in:inbox is:unread newer_than:1d"
```

Set your Gemini API key:

```bash
export GEMINI_API_KEY=your_key_here
```

Authenticate your Gmail account(s) with gog:

```bash
gog auth login you@gmail.com
```

### Run

```bash
# One-shot scan
./bin/winnow scan

# Watch mode (real-time triage)
./bin/winnow watch

# Or with PM2 for always-on
pm2 start ecosystem.config.cjs
```

## How It Works

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Gmail    │────▶│  Winnow  │────▶│  Gemini  │────▶│  Gmail   │
│  (unread) │     │  (scan)  │     │  (classify)    │  (archive │
│           │     │          │     │          │     │  + label) │
└──────────┘     └────┬─────┘     └──────────┘     └──────────┘
                      │
                      ▼
                ┌──────────┐
                │  Slack   │
                │  (feed)  │
                └──────────┘
```

1. **Scan** — Winnow polls Gmail for unread messages using `gog` (a local Gmail CLI). Only fetches sender, subject, snippet, and headers. Never reads full email bodies.

2. **Classify** — Each email is sent to Gemini with your custom rules + baseline rules. The AI returns a JSON decision: archive or keep, with a confidence score and summary.

3. **Safety Net** — If confidence is below 70%, the email stays in your inbox regardless of classification. Baseline rules protect 2FA codes, calendar invites, payment emails, and threads you've replied to — all configurable.

4. **Act** — Archived emails get removed from inbox, marked read, and labeled `winnow/archived`. Kept emails are left completely untouched. Ephemeral emails (OTPs, delivery updates) get a Slack notification and auto-archive.

5. **Notify** — Every processed email posts to Slack in real-time. Daily archive reports summarize what was auto-archived.

### Ephemeral Emails

Some emails are briefly useful but don't need to live in your inbox:

- **🔑 OTP/2FA codes** — Extracted, copied to your clipboard via `pbcopy`, macOS notification sent, then archived
- **📌 Delivery updates** — "Your package was delivered" → Slack FYI, archived
- **📌 Daycare check-ins** — "Noa checked in at 8:15am" → Slack FYI, archived

## Rules

Winnow uses a three-layer rule system:

### 1. Baseline Rules (`config/baseline-rules.yaml`)

Ship with Winnow. Sensible defaults that work for most people:

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

### 2. Per-Account Rules (`config/rules-<email>.yaml`)

Custom rules for each account. Written in plain English:

```yaml
# config/rules-you@gmail.com.yaml
rules:
  - id: nextdoor-digest
    match: "Nextdoor neighborhood digest emails and popular posts notifications"
    archive: true

  - id: mychart-messages
    match: >-
      MyChart messages from doctors or care teams should NOT be archived.
      Only archive MyChart marketing or surveys.
    archive: false
```

### Confidence Threshold

If the AI's confidence is below 70%, the email stays in your inbox no matter what the rules say. This is the only hardcoded behavior — everything else is configurable through rules.

### Managing Rules

```bash
# List all rules for an account
winnow rules -a you@gmail.com

# Add a rule
winnow rule add "Archive LinkedIn recruiter InMail" -a you@gmail.com

# Keep instead of archive
winnow rule add "Emails from my doctor" -a you@gmail.com --keep

# Remove a rule
winnow rule remove nextdoor-digest -a you@gmail.com
```

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
| `winnow feed on/off/status` | Toggle real-time Slack feed |
| `winnow alerts on/off/status` | Mute/unmute Slack notifications |

### Common Options

```bash
--account, -a <email>   Target a specific account
--dry-run               Classify without taking any Gmail actions
--since <duration>      Time window (e.g., 7d, 24h)
```

## Multi-Account Setup

Each account gets its own:
- **Rules file** — `config/rules-<email>.yaml`
- **Slack channel** — notifications route to the right place
- **Independent scanning** — one account's rules don't affect another

```yaml
# config/config.yaml
accounts:
  - email: personal@gmail.com
    channel: C0PERSONAL    # → #personal-email
  - email: work@company.com
    channel: C0WORK        # → #work-email
```

## Architecture

```
winnow/
├── bin/winnow              # CLI entrypoint
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
│   ├── notify.js           # Slack notifications & feed
│   ├── digest.js           # Daily archive report
│   ├── config.js           # Config loading & account routing
│   ├── state.js            # Persistent state (processed IDs, stats)
│   ├── check.js            # Health checks & auto-fix
│   ├── watch.js            # Real-time watch mode
│   └── adapters/
│       └── gog.js          # Gmail adapter via gog CLI
├── data/
│   └── state.json          # Processing state (gitignored)
└── test/
    └── notify.test.js      # Notification tests
```

### Gmail Adapters

Winnow accesses Gmail through a pluggable adapter interface. All Gmail operations (fetch, archive, label) go through a base `GmailAdapter` class, so swapping backends is straightforward.

| Adapter | Status | Description |
|---------|--------|-------------|
| **[gog](https://github.com/xlab-si/gog)** | ✅ Supported | Google CLI with OAuth. Current default. |
| **[gws](https://github.com/googleworkspace/cli)** | 🔜 Planned | Google's official Workspace CLI (`@googleworkspace/cli`). Structured JSON output, 100+ agent skills. |
| **Gmail API** | 🔜 Planned | Direct Gmail REST API — no CLI dependency. |
| **IMAP** | 💡 Future | For non-Gmail providers (Outlook, Fastmail, etc.) |

To set your adapter in `config.yaml`:

```yaml
adapter: gog  # or "gws" once supported
```

Want to add an adapter? Implement the `GmailAdapter` interface in `src/adapters/` — see `gog.js` for reference.

### Key Design Decisions

- **Never delete** — Only archive. Everything is recoverable from Gmail's All Mail.
- **Snippet-only classification** — Winnow sends sender + subject + snippet to the AI, never full email bodies. Faster, cheaper, and more private.
- **Low-confidence = keep** — Below 70% confidence, emails stay in the inbox no matter what.
- **Stateless scanning** — Each scan is independent. State tracks processed IDs to avoid re-processing, but a fresh scan works fine without it.
- **Pluggable adapters** — Gmail access goes through a clean adapter interface. Swap backends by implementing `GmailAdapter` and updating your config.

## Running with PM2

For always-on triage:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # auto-start on boot
```

This runs `winnow watch` as a background daemon, polling every 15 seconds.

## Contributing

Winnow is young and opinionated — contributions are welcome.

### Good First Issues

- **New adapters** — `gws` (Google Workspace CLI), direct Gmail API, IMAP, Outlook/Exchange
- **Notification targets** — Discord, Telegram, email digest, desktop notifications
- **Rule improvements** — Regex support, sender-based rules, time-based rules ("archive after 24h")
- **Better classification** — Support for other LLMs (OpenAI, Claude, local models via Ollama)
- **Tests** — More test coverage, especially for classification edge cases

### Development

```bash
git clone https://github.com/cameronehrlich/winnow.git
cd winnow
npm install

# Run tests
node --test test/

# Dry-run scan (no Gmail changes)
GEMINI_API_KEY=your_key ./bin/winnow scan --dry-run

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
