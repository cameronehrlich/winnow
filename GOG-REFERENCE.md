# gog CLI Reference for Winnow

This documents the `gog` CLI commands needed for the Gmail adapter layer.

## Authentication
Accounts are already authenticated. Use `--account <email>` to target a specific account.
Available: `user@example.com` (Phase 1 only)

## Key Commands

### Search unread messages
```bash
gog gmail messages search "is:unread newer_than:1d" --max 50 --account user@example.com --json --no-input
```

### Get a message (full content)
```bash
gog gmail get <messageId> --account user@example.com --json --no-input
```

### Get a thread
```bash
gog gmail thread get <threadId> --account user@example.com --json --no-input
```

### Labels

#### List labels
```bash
gog gmail labels list --account user@example.com --json --no-input
```

#### Create a label
```bash
gog gmail labels create "winnow/low" --account user@example.com --json --no-input
```

#### Modify labels on threads (add/remove)
```bash
# Add label + archive (remove INBOX)
gog gmail labels modify <threadId> --add "winnow/low" --remove "INBOX" --account user@example.com --force --no-input

# Add label + mark as read (remove UNREAD)
gog gmail labels modify <threadId> --add "winnow/normal" --remove "UNREAD" --account user@example.com --force --no-input

# Add urgent label (leave INBOX and UNREAD intact)
gog gmail labels modify <threadId> --add "winnow/urgent" --account user@example.com --force --no-input
```

### Common flags
- `--json` — JSON output (essential for parsing)
- `--no-input` — Never prompt (for scripting)
- `--force` — Skip confirmations
- `--account <email>` — Target account
- `--plain` — TSV output (alternative to JSON)

## Gmail Label IDs (system labels)
- `INBOX` — Inbox
- `UNREAD` — Unread marker
- `STARRED` — Starred
- `IMPORTANT` — Important
- `SPAM` — Spam
- `TRASH` — Trash

## Notes
- To "archive" = remove the INBOX label
- To "mark as read" = remove the UNREAD label
- Custom labels like `winnow/low` use `/` for nesting (shows as folder hierarchy in Gmail)
- Always use `--json --no-input --force` for scripting
