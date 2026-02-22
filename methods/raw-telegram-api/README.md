# Method 2: Raw Telegram Bot API

**The minimalist approach — ~50 lines of bash, no frameworks, no dependencies.**

## Overview

Hit the Telegram Bot API directly with `curl`. Poll for messages, pipe them to `claude`, send the response back. That's it.

```
curl getUpdates → extract message → claude -p "message" → curl sendMessage
```

## Prerequisites

- `curl` and `jq` (already on most systems)
- Claude Code CLI authenticated
- Telegram bot token + your user ID

## Setup

```bash
cd methods/raw-telegram-api
cp .env.example .env
# Edit .env with your tokens
chmod +x relay.sh
./relay.sh
```

## How It Works

1. Script calls `getUpdates` on the Telegram Bot API with a long poll timeout
2. Parses the JSON response with `jq` to extract message text and user ID
3. Checks if the sender matches your allowed user ID
4. Runs `claude -p "message text"` and captures stdout
5. Sends the response via `sendMessage`
6. Updates the offset to acknowledge processed messages
7. Loops forever

## Architecture

```
┌─────────────┐    curl getUpdates    ┌──────────────┐
│  Telegram    │ ◄─────────────────── │  relay.sh    │
│  API         │ ────────────────►    │  (bash loop)  │
└─────────────┘    JSON response      └──────┬───────┘
                                             │ pipe to
                                             ▼
       curl sendMessage              ┌──────────────┐
       ◄──────────────────────────── │ claude -p     │
                                     │ (captures out) │
                                     └──────────────┘
```

## The Script

See `relay.sh` for the complete implementation. Here's the core loop:

```bash
#!/usr/bin/env bash
source .env

API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
OFFSET=0

while true; do
  # Long poll for updates (30 second timeout)
  UPDATES=$(curl -s "${API}/getUpdates?offset=${OFFSET}&timeout=30")

  # Process each message
  echo "$UPDATES" | jq -c '.result[]' | while read -r update; do
    MSG_TEXT=$(echo "$update" | jq -r '.message.text // empty')
    USER_ID=$(echo "$update" | jq -r '.message.from.id')
    CHAT_ID=$(echo "$update" | jq -r '.message.chat.id')
    UPDATE_ID=$(echo "$update" | jq -r '.update_id')

    # Update offset
    OFFSET=$((UPDATE_ID + 1))

    # Skip non-text or wrong user
    [ -z "$MSG_TEXT" ] && continue
    [ "$USER_ID" != "$TELEGRAM_USER_ID" ] && continue

    # Run Claude and send response
    RESPONSE=$(claude -p "$MSG_TEXT" 2>/dev/null)
    curl -s -X POST "${API}/sendMessage" \
      -d chat_id="$CHAT_ID" \
      -d text="$RESPONSE" \
      -d parse_mode="Markdown" > /dev/null
  done
done
```

## Python Version

Also included: `relay.py` — same logic, slightly cleaner, with better error handling.

```python
import os, requests, subprocess, time

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
USER_ID = int(os.environ["TELEGRAM_USER_ID"])
API = f"https://api.telegram.org/bot{TOKEN}"

offset = 0
while True:
    r = requests.get(f"{API}/getUpdates", params={"offset": offset, "timeout": 30})
    for update in r.json().get("result", []):
        offset = update["update_id"] + 1
        msg = update.get("message", {})
        if msg.get("from", {}).get("id") != USER_ID:
            continue
        text = msg.get("text", "")
        if not text:
            continue

        result = subprocess.run(["claude", "-p", text], capture_output=True, text=True, timeout=120)
        reply = result.stdout.strip() or "⚠️ Empty response"

        requests.post(f"{API}/sendMessage", json={
            "chat_id": msg["chat"]["id"],
            "text": reply[:4096],
            "parse_mode": "Markdown",
        })
```

## Pros & Cons

**Pros:**
- Zero dependencies beyond curl/jq (bash) or requests (Python)
- Dead simple — you can read the entire thing in 2 minutes
- Easy to debug, modify, extend
- No build step, no package manager, no runtime

**Cons:**
- No media handling (photos, voice, documents) without extra work
- No middleware, no plugin system
- Bash version has quirky edge cases with special characters
- Offset tracking is fragile if the script crashes mid-loop
- No typing indicator (would need a background curl call)
