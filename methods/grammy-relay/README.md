# Method 1: grammY Relay

**A typed TypeScript bot framework that spawns Claude Code CLI per message.**

## Overview

[grammY](https://grammy.dev) is a modern Telegram Bot API framework for TypeScript/Deno/Node. This method uses it as the message layer, spawning a fresh `claude` CLI process for each incoming message and sending the response back.

```
You → Telegram → grammY (long poll) → spawn `claude` CLI → capture stdout → ctx.reply()
```

## Prerequisites

- [Bun](https://bun.sh) (or Node.js 18+)
- Claude Code CLI authenticated
- Telegram bot token + your user ID

## Setup

```bash
cd methods/grammy-relay
bun install  # or npm install
cp .env.example .env
# Edit .env with your tokens
bun run relay.ts
```

## How It Works

1. grammY connects to Telegram via **long polling** (no open ports needed)
2. On each incoming message from your user ID:
   - Builds a context string (your message + timestamp + any prior context)
   - Spawns `claude` as a child process via `Bun.spawn()` / `child_process.spawn()`
   - Pipes the context into stdin (or passes as CLI args)
   - Collects stdout until the process exits
   - Sends the output back via `ctx.reply()`
3. Messages from other users are ignored (user ID filter)

## Architecture

```
┌─────────────┐     long poll      ┌──────────────┐
│  Telegram    │ ◄──────────────── │  grammY Bot   │
│  Servers     │ ──────────────►   │  (relay.ts)   │
└─────────────┘   your message     └──────┬───────┘
                                          │ spawn
                                          ▼
                                   ┌──────────────┐
                                   │ claude CLI    │
                                   │ (child proc)  │
                                   └──────┬───────┘
                                          │ stdout
                                          ▼
                                   response sent
                                   back to Telegram
```

## Key Code

```typescript
import { Bot } from "grammy";
import { spawn } from "child_process";

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
const ALLOWED_USER = Number(process.env.TELEGRAM_USER_ID);

bot.on("message:text", async (ctx) => {
  if (ctx.from?.id !== ALLOWED_USER) return;

  const message = ctx.message.text;
  const response = await runClaude(message);
  await ctx.reply(response);
});

async function runClaude(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", input], {
      env: { ...process.env },
    });

    let output = "";
    proc.stdout.on("data", (data) => (output += data.toString()));
    proc.stderr.on("data", (data) => console.error(data.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`claude exited with code ${code}`));
    });
  });
}

bot.start();
console.log("Relay running...");
```

## Adding Memory

The basic relay is stateless — each Claude invocation starts fresh. To add memory:

- **Simple:** Append conversation history to a local file, inject last N messages as context
- **Supabase (like claude-telegram-relay):** Store messages with embeddings, semantic search for relevant context before each call
- **File-based:** Write to a `MEMORY.md` that Claude reads each invocation

## Pros & Cons

**Pros:**
- Type-safe, well-documented framework
- Middleware system for logging, rate limiting, error handling
- Handles media types (photos, voice, documents) cleanly
- Active community and plugin ecosystem

**Cons:**
- Requires Bun or Node.js runtime
- More dependencies than the raw API approach
- New Claude process per message (startup overhead)
- No built-in memory — you wire that up yourself
