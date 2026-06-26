#!/usr/bin/env bash
# Winnow action hook: post Procare sign-in/sign-out summary to Slack
#
# Env vars provided by Winnow:
#   WINNOW_FROM, WINNOW_SUBJECT, WINNOW_ACCOUNT, WINNOW_THREAD_ID, WINNOW_MESSAGE_ID

set -euo pipefail

SLACK_TOKEN="${SLACK_TOKEN:-${SLACK_BOT_TOKEN:-}}"
CHANNEL="${PROCARE_SLACK_CHANNEL:-C0AJX65MJTW}"
ACCOUNT="${WINNOW_ACCOUNT:-cameronehrlich@gmail.com}"

if [[ -z "$SLACK_TOKEN" ]]; then
  echo "[procare-notify] SLACK_TOKEN/SLACK_BOT_TOKEN is not set, skipping"
  exit 0
fi

# Fetch the most recent Procare email body (today's summary)
BODY=$(gog gmail messages search 'from:procare subject:"Daily summary" newer_than:1d' \
  --max 1 \
  --account "$ACCOUNT" \
  --json \
  --include-body 2>/dev/null \
  | python3 -c "import json,sys; msgs=json.load(sys.stdin).get('messages',[]); print(msgs[0].get('body','') if msgs else '')" 2>/dev/null || true)

if [[ -z "$BODY" ]]; then
  echo "[procare-notify] Could not fetch email body, skipping"
  exit 0
fi

# Parse sign-ins and sign-outs and post to Slack
BODY="$BODY" SLACK_TOKEN="$SLACK_TOKEN" CHANNEL="$CHANNEL" python3 << 'PYEOF'
import os, re, json
import urllib.request

body = os.environ.get('BODY', '')
slack_token = os.environ.get('SLACK_TOKEN', '')
channel = os.environ.get('CHANNEL', '')

sign_ins = []
sign_outs = []
current_section = None

for line in body.splitlines():
    stripped = line.strip()
    # Section headers (surrounded by ---- lines in Procare format)
    if re.search(r'\bSign-Ins\b', stripped, re.IGNORECASE):
        current_section = 'in'
    elif re.search(r'\bSign-Outs\b', stripped, re.IGNORECASE):
        current_section = 'out'
    elif re.match(r'^-{3,}$', stripped):
        # Only reset if we haven't just entered a section
        # (Procare puts --- before AND after the section header)
        pass  # Don't reset — headers appear between dashes, ignore the dashes
    elif current_section == 'in':
        m = re.search(r'Signed in to (.+?) at (.+)', stripped, re.IGNORECASE)
        if m:
            sign_ins.append(f"{m.group(2).strip()} ({m.group(1).strip()})")
    elif current_section == 'out':
        m = re.search(r'Signed out from (.+?) at (.+)', stripped, re.IGNORECASE)
        if m:
            sign_outs.append(f"{m.group(2).strip()} ({m.group(1).strip()})")
        # Stop after the sign-outs section
        elif stripped.startswith('The Daily Summary') or stripped.startswith('View the complete'):
            current_section = None

parts = []
if sign_ins:
    parts.append("In: " + ", ".join(sign_ins))
if sign_outs:
    parts.append("Out: " + ", ".join(sign_outs))

if parts:
    text = "🏫 *Noa* — " + " · ".join(parts)
else:
    text = "🏫 *Noa* — Procare daily summary received"

print(f"[procare-notify] Posting: {text}")

payload = json.dumps({"channel": channel, "text": text, "unfurl_links": False}).encode()
req = urllib.request.Request(
    "https://slack.com/api/chat.postMessage",
    data=payload,
    headers={
        "Authorization": f"Bearer {slack_token}",
        "Content-Type": "application/json",
    },
    method="POST"
)
with urllib.request.urlopen(req) as resp:
    r = json.loads(resp.read())
    if r.get('ok'):
        print("[procare-notify] Slack OK")
        print("WINNOW_SUPPRESS_FEED=1")
    else:
        print(f"[procare-notify] Slack error: {r}")
PYEOF
