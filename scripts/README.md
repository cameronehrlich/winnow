# Action Hooks

Winnow can run optional local action hooks from rules. Hooks are intentionally not tracked by default because they often contain personal routing, account IDs, workspace paths, or service-specific automation.

Tracked examples should be generic and safe to share. Local hooks can live anywhere on disk; point to them from your private `config/rules-*.yaml` files.

Rules receive these environment variables when a hook runs:

- `WINNOW_FROM`
- `WINNOW_SUBJECT`
- `WINNOW_ACCOUNT`
- `WINNOW_THREAD_ID`
- `WINNOW_MESSAGE_ID`

If a hook handles its own notification and the normal feed card should be skipped, print:

```text
WINNOW_SUPPRESS_FEED=1
```
