# gog CLI Reference for Winnow

This documents the `gog` CLI commands needed for the Gmail adapter layer. Winnow expects `gogcli` 0.31.1 or newer.

## Authentication
Use `--account <email>` to target a specific account.

```bash
gog auth add user@example.com --services gmail
gog auth list --check
```

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

`gogcli` 0.31.1 returns labels as `{ "labels": [...] }`. Older builds returned a bare array; the adapter accepts both shapes.

#### Create a label
```bash
gog gmail labels create "winnow/archived" --account user@example.com --json --no-input
```

#### Modify labels on threads (add/remove)
```bash
# Add label + archive (remove INBOX)
gog gmail labels modify <threadId> --add "winnow/archived" --remove "INBOX" --account user@example.com --force --no-input

# Add label + mark as read (remove UNREAD)
gog gmail labels modify <threadId> --add "winnow/kept" --remove "UNREAD" --account user@example.com --force --no-input

# Move an archived message back to the inbox
gog gmail labels modify <threadId> --add "INBOX" --remove "winnow/archived" --account user@example.com --force --no-input
```

### Common flags
- `--json` — JSON output (essential for parsing)
- `--no-input` — Never prompt (for scripting)
- `--force` — Skip confirmations for mutating commands
- `--account <email>` — Target account
- `--plain` — TSV output (alternative to JSON)
- `--results-only` — Drop JSON envelopes when a command supports it

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
- Custom labels like `winnow/archived` use `/` for nesting (shows as folder hierarchy in Gmail)
- Always use `--json --no-input` for scripting; add `--force` to mutating commands.
- Run `winnow doctor` after upgrading `gogcli` to verify version, auth, and JSON compatibility.
