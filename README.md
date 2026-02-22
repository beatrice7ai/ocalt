# OCALT — OpenClaw Alternatives

**Patterns for running Claude Code as a service via Telegram.**

Three lightweight methods to connect Claude Code CLI to Telegram — from a full bot framework to zero-code visual automation. No OpenClaw required.

## Methods

| # | Method | Complexity | Dependencies | Best For |
|---|--------|-----------|--------------|----------|
| 1 | [grammY Relay](methods/grammy-relay/) | Medium | Bun, grammY, Supabase | Devs who want a typed, extensible bot framework |
| 2 | [Raw Telegram Bot API](methods/raw-telegram-api/) | Low | Bash or Python, curl | Minimalists, quick & dirty, ~50 lines of code |
| 3 | [n8n Webhook](methods/n8n-webhook/) | Low | n8n (Docker) | Non-coders, visual builder, zero code |

## Scheduler

The [OCALT Scheduler](scheduler/) runs Claude Code on cron-like schedules in **visible tmux windows** — you can literally watch Claude work.

Two job modes:
- **`continue`** — resumes the existing session (persistent memory, like heartbeats)
- **`fresh`** — clean slate each run (isolated tasks, like overnight workers)

Works alongside your own `claude` terminal — no conflicts. See [scheduler/README.md](scheduler/README.md).

## How They All Work

Every method follows the same core loop:

```
Telegram message → [receive] → Claude Code CLI → [capture stdout] → Telegram reply
```

The differences are in what sits in the middle.

## Requirements (All Methods)

- **Claude Code CLI** installed and authenticated (`claude` command works)
- **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)
- **Your Telegram User ID** from [@userinfobot](https://t.me/userinfobot)
- A machine that stays on (VPS, Mac Mini, whatever)

## Security Notes

- All methods filter by `TELEGRAM_USER_ID` so only you can talk to the bot
- Claude Code runs with your user's full filesystem/shell access — don't run on machines with sensitive data you wouldn't trust Claude with
- For production/multi-user deployments, use [OpenClaw](https://github.com/openclaw/openclaw) which adds Docker isolation, non-root users, and capability restrictions

## License

MIT
