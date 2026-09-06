# Shared mailboxes and branded replies

An account's `email` is the mailbox key used by SQLite and assistant scope.
It is not necessarily the address customers should see in outgoing mail.

For reply and forward proposals, Winnow reads the focused Gmail message and
the mailbox's Gmail send-as settings. It chooses the addressed verified alias
(To, then Cc, then original/delivered recipient headers); sent-message follow-ups
retain the original From identity. It never selects an identity from the body
or a display name. Multiple aliases in the same recipient tier require explicit
resolution in Gmail rather than guessing. The primary mailbox remains the
fallback when no owned recipient identity is visible.

The resolved From address is part of the confirmation digest and shown in the
confirmation screen. Confirmation rechecks the message and Gmail settings;
revoked or changed identities require a new proposal. The adapter passes an
explicit `--from` to both reply and forward. Replies exclude the mailbox and
its known aliases from recipients, and remove inferred gog reply recipients
that were not included in the approved draft.

## Configuration

`receiving_aliases` lists additional incoming identities (including aliases not
yet configured for sending). It does not create routing or grant send authority.
If such an alias was addressed but is not a verified Gmail send-as identity,
Winnow reports that setup is required instead of silently substituting the
primary mailbox. Gmail's native routing and verified send-as settings remain
the sources of truth for delivery and sending permissions.

Account-specific customer-support rules should be added to the new shared
mailbox deliberately. Do not copy unrelated old archive rules across brands.
Use the existing rule import API to make account YAML guidance editable.

## Retired source mailboxes

Gmail mailbox imports can assign different message/thread IDs. Do not rewrite
old SQLite account keys to the destination account and assume IDs survived.
Keep old links/history against the source mailbox using `auth_account` for its
renamed gog login, `read_only: true`, and `sync_enabled: false`. The account's
stable `email` key remains unchanged. Background polling excludes it; original
messages remain readable using the renamed credentials, while mutations are
blocked. The client labels that content as retired history and disables mailbox
actions and automatic mark-read. New mail is ingested under the destination
account. Historical assistant conversations continue referencing their original
messages; a proposal made before the account was retired cannot execute.

These settings do not delete source data, migrate OAuth identity ownership, or
cancel the old Workspace. Retiring source access or consolidating historical
rows further requires an explicit migration with message-ID reconciliation.
