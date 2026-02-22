#!/usr/bin/env bash
# OCALT — Raw Telegram Bot API relay for Claude Code
# Zero dependencies beyond curl and jq.

set -euo pipefail

# Load env
if [ -f .env ]; then
  set -a; source .env; set +a
fi

: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN}"
: "${TELEGRAM_USER_ID:?Set TELEGRAM_USER_ID}"

API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"
OFFSET=0

echo "✅ Raw API relay running. Listening for user ${TELEGRAM_USER_ID}"

while true; do
  # Long poll (30s timeout — Telegram holds the connection open)
  UPDATES=$(curl -sf "${API}/getUpdates?offset=${OFFSET}&timeout=30" || echo '{"result":[]}')

  # Count results
  COUNT=$(echo "$UPDATES" | jq '.result | length')
  [ "$COUNT" = "0" ] && continue

  # Process each update
  echo "$UPDATES" | jq -c '.result[]' | while IFS= read -r update; do
    UPDATE_ID=$(echo "$update" | jq -r '.update_id')
    OFFSET=$((UPDATE_ID + 1))

    # Extract message fields
    MSG_TEXT=$(echo "$update" | jq -r '.message.text // empty')
    USER_ID=$(echo "$update" | jq -r '.message.from.id // empty')
    CHAT_ID=$(echo "$update" | jq -r '.message.chat.id // empty')

    # Skip non-text or unauthorized users
    [ -z "$MSG_TEXT" ] && continue
    [ "$USER_ID" != "$TELEGRAM_USER_ID" ] && continue

    TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
    echo "[${TIMESTAMP}] Received: ${MSG_TEXT:0:100}"

    # Show typing (fire and forget)
    curl -sf -X POST "${API}/sendChatAction" \
      -d chat_id="$CHAT_ID" \
      -d action="typing" > /dev/null 2>&1 &

    # Run Claude Code
    RESPONSE=$(claude -p "$MSG_TEXT" 2>/dev/null || echo "⚠️ Claude error")

    # Telegram message limit: 4096 chars
    RESPONSE="${RESPONSE:0:4096}"

    # Send response
    curl -sf -X POST "${API}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg chat "$CHAT_ID" --arg text "$RESPONSE" \
        '{chat_id: $chat, text: $text, parse_mode: "Markdown"}')" > /dev/null

    echo "[${TIMESTAMP}] Replied (${#RESPONSE} chars)"
  done

  # Persist offset across subshell (the while-read runs in a pipe subshell)
  LATEST=$(echo "$UPDATES" | jq '[.result[].update_id] | max')
  OFFSET=$((LATEST + 1))
done
