#!/usr/bin/env python3
"""OCALT — Raw Telegram Bot API relay for Claude Code (Python version)."""

import os
import subprocess
import sys
import time

import requests

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
USER_ID = os.environ.get("TELEGRAM_USER_ID")

if not TOKEN or not USER_ID:
    print("Set TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID")
    sys.exit(1)

USER_ID = int(USER_ID)
API = f"https://api.telegram.org/bot{TOKEN}"
offset = 0

print(f"✅ Raw API relay (Python) running. Listening for user {USER_ID}")

while True:
    try:
        r = requests.get(
            f"{API}/getUpdates",
            params={"offset": offset, "timeout": 30},
            timeout=35,
        )
        updates = r.json().get("result", [])
    except Exception as e:
        print(f"Poll error: {e}")
        time.sleep(5)
        continue

    for update in updates:
        offset = update["update_id"] + 1
        msg = update.get("message", {})

        # Filter: only text from allowed user
        if msg.get("from", {}).get("id") != USER_ID:
            continue
        text = msg.get("text", "")
        if not text:
            continue

        chat_id = msg["chat"]["id"]
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}] Received: {text[:100]}")

        # Typing indicator
        try:
            requests.post(f"{API}/sendChatAction", json={"chat_id": chat_id, "action": "typing"})
        except Exception:
            pass

        # Run Claude Code
        try:
            result = subprocess.run(
                ["claude", "-p", text],
                capture_output=True,
                text=True,
                timeout=120,
            )
            reply = result.stdout.strip() or "⚠️ Empty response from Claude"
        except subprocess.TimeoutExpired:
            reply = "⚠️ Claude timed out (120s)"
        except Exception as e:
            reply = f"⚠️ Error: {e}"

        # Send response (4096 char limit)
        reply = reply[:4096]
        try:
            requests.post(f"{API}/sendMessage", json={
                "chat_id": chat_id,
                "text": reply,
                "parse_mode": "Markdown",
            })
            print(f"Replied ({len(reply)} chars)")
        except Exception as e:
            print(f"Send error: {e}")
