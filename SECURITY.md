# Security Policy

Winnow is designed to run as a private local daemon. It handles email metadata, message snippets, Slack tokens, Gmail OAuth state through `gogcli`, and optional API bearer tokens.

## Supported Use

- Bind the HTTP API to `127.0.0.1` unless you understand the network exposure.
- Use a long random `WINNOW_API_TOKEN` for all `/v1/*` routes.
- Keep `.env`, `config/config.yaml`, `config/rules-*.yaml`, `data/`, and logs out of Git.
- Treat local action hooks as trusted code because they run with your user permissions.

## Reporting Issues

Please do not open public issues containing tokens, email contents, personal data, or live account details. Open a minimal issue with reproduction steps and redact secrets. If a private report is needed, contact the repository owner directly.

## Public Release Checklist

Before making a private checkout public, run a secrets scan against both the current tree and Git history. If the repo previously contained personal config, tokens, local hooks, or private examples, publish from a fresh clean repository or rewrite history before changing repository visibility.
