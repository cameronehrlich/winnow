#!/usr/bin/env bash
# Winnow action hook: auto-remove a TestFlight beta tester on request
# Called by Winnow when an email matches the testflight-removal-request rule.
#
# Env vars provided by Winnow:
#   WINNOW_FROM       - sender "Name <email>" string
#   WINNOW_SUBJECT    - email subject
#   WINNOW_ACCOUNT    - receiving Gmail account
#
# Stitch It app ID: 554594252

set -euo pipefail

ASC="$HOME/App-Store-Connect-CLI/asc"
APP_ID="554594252"

# Extract email address from From header (handles both "Name <email>" and bare email)
FROM_EMAIL=$(echo "$WINNOW_FROM" | grep -oE '[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}' | head -1)

if [[ -z "$FROM_EMAIL" ]]; then
  echo "[testflight-removal] Could not parse email from: $WINNOW_FROM"
  exit 1
fi

echo "[testflight-removal] Looking up tester for: $FROM_EMAIL"

# Search all testers for this app to find the one matching the sender email
MATCH=$("$ASC" testflight beta-testers list --app "$APP_ID" --limit 200 2>&1 \
  | FROM_EMAIL="$FROM_EMAIL" python3 -c "
import json, sys, os
txt = sys.stdin.read()
data = json.loads(txt)
target = os.environ.get('FROM_EMAIL','').lower()
for t in data.get('data', []):
    attrs = t.get('attributes', {})
    email = attrs.get('email','').lower()
    if email == target:
        print(email)
        break
	")

if [[ -z "$MATCH" ]]; then
  echo "[testflight-removal] No TestFlight tester found with email: $FROM_EMAIL"
  echo "[testflight-removal] They may have already been removed or used a different email to sign up."
  exit 0
fi

echo "[testflight-removal] Found tester: $MATCH — removing from app $APP_ID..."
RESULT=$("$ASC" testflight beta-testers remove --app "$APP_ID" --email "$MATCH" 2>&1)
echo "[testflight-removal] Result: $RESULT"
echo "[testflight-removal] ✅ Done."
