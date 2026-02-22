# Method 3: n8n Webhook

**Zero code. Visual workflow builder. Telegram → Claude Code → reply.**

## Overview

n8n is a self-hosted automation platform with a drag-and-drop workflow builder. This method uses n8n's built-in Telegram trigger node to receive messages, an Execute Command node to run `claude`, and a Telegram node to send the response back.

No code. You build the entire thing by clicking and connecting nodes.

```
Telegram Trigger → Filter (user ID) → Execute Command (claude) → Telegram Send
```

## Prerequisites

- n8n running (Docker recommended)
- Claude Code CLI authenticated on the same machine
- Telegram bot token + your user ID

## Setup

### Option A: Import the workflow

1. Open your n8n instance
2. Go to **Workflows → Import from File**
3. Import `workflow.json` from this directory
4. Update credentials:
   - Telegram bot token
   - Your user ID in the IF node
5. Activate the workflow

### Option B: Build it manually

1. **Telegram Trigger** node → set bot token, trigger on "message"
2. **IF** node → condition: `{{ $json.message.from.id }}` equals `YOUR_USER_ID`
3. **Execute Command** node → command: `claude -p "{{ $json.message.text }}"`
4. **Telegram** node → action: Send Message, chat ID: `{{ $('Telegram Trigger').item.json.message.chat.id }}`, text: `{{ $json.stdout }}`
5. Connect: Trigger → IF (true) → Execute Command → Telegram Send
6. Activate

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                        n8n                                │
│                                                          │
│  ┌───────────┐   ┌────────┐   ┌──────────┐   ┌───────┐ │
│  │ Telegram   │──▶│  IF     │──▶│ Execute  │──▶│ Tele- │ │
│  │ Trigger    │   │ user_id │   │ Command  │   │ gram  │ │
│  │ (webhook)  │   │ check   │   │ (claude) │   │ Send  │ │
│  └───────────┘   └────────┘   └──────────┘   └───────┘ │
│       ▲                            │                     │
│       │                            ▼                     │
│   Telegram API              claude -p "msg"              │
└──────────────────────────────────────────────────────────┘
```

## Workflow JSON

The `workflow.json` file contains a ready-to-import n8n workflow. Key nodes:

### 1. Telegram Trigger
- **Type:** `n8n-nodes-base.telegramTrigger`
- **Config:** Trigger on `message` events
- Receives incoming messages via Telegram Bot API webhook

### 2. User ID Filter (IF)
- **Type:** `n8n-nodes-base.if`
- **Condition:** `message.from.id == YOUR_USER_ID`
- Drops messages from unauthorized users

### 3. Execute Command
- **Type:** `n8n-nodes-base.executeCommand`
- **Command:** `claude -p "{{ $json.message.text }}"`
- Spawns Claude Code CLI, captures stdout
- Timeout: 120 seconds

### 4. Telegram Send
- **Type:** `n8n-nodes-base.telegram`
- **Action:** Send Message
- **Chat ID:** Dynamic from trigger node
- **Text:** stdout from Execute Command

## Handling Long Responses

Telegram's message limit is 4096 characters. To handle longer Claude responses, add a **Code** node between Execute Command and Telegram Send:

```javascript
// Split long responses into chunks
const text = $input.first().json.stdout;
const chunks = [];
for (let i = 0; i < text.length; i += 4096) {
  chunks.push({ json: { text: text.slice(i, i + 4096), chat_id: $('Telegram Trigger').first().json.message.chat.id } });
}
return chunks;
```

Then set the Telegram Send node to iterate over items.

## Adding Memory

n8n makes memory easy without code:

- **File-based:** Add a "Read File" node before Execute Command to load `MEMORY.md`, inject it into the Claude prompt. Add a "Write File" node after to append the exchange.
- **Database:** Use n8n's Postgres/SQLite nodes to store and retrieve conversation history.
- **Google Sheets:** Quick and dirty — append each exchange to a sheet, read last N rows as context.

## Running Claude inside Docker

If n8n runs in Docker but Claude Code is on the host:

```yaml
# docker-compose.yml
services:
  n8n:
    image: n8nio/n8n
    volumes:
      - /usr/local/bin/claude:/usr/local/bin/claude:ro  # Mount CLI
      - /home/you/.claude:/home/node/.claude:ro          # Mount auth
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
```

Or use n8n's HTTP Request node to hit a local API wrapper around Claude instead of Execute Command.

## Pros & Cons

**Pros:**
- Zero code — entirely visual
- Easy to extend (add more nodes for logging, database, error handling)
- n8n has 400+ integrations — chain Claude with anything
- Built-in retry/error handling
- Workflow versioning and backup

**Cons:**
- Requires n8n running (Docker recommended, ~512MB RAM)
- Telegram trigger uses webhooks (needs n8n to be internet-accessible or tunneled)
- Execute Command node can be finicky with environment variables
- Slightly more latency than direct approaches
- n8n's Telegram trigger requires a publicly accessible URL (use Cloudflare Tunnel or ngrok)
