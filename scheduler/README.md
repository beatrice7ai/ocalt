# OCALT Scheduler

**Run Claude Code on a schedule — in visible tmux sessions you can watch in real time.**

Two job types:
- **Continued session** (`continue`) — resumes the last conversation, preserves full context (like OpenClaw heartbeats)
- **New session** (`fresh`) — clean slate each run (like OpenClaw isolated cron jobs)

All jobs run in named tmux windows so you can attach and watch Claude Code work.

## Quick Start

```bash
cd scheduler
bun install
cp config.example.json config.json
# Edit config.json with your schedules

# Start the scheduler daemon
bun run start

# Watch it work — attach to the tmux session
tmux attach -t ocalt
```

## How It Works

1. The scheduler reads `config.json` for job definitions
2. Each job has a cron expression and a mode (`continue` or `fresh`)
3. When a job fires, it spawns `claude` in a **named tmux window**
4. You can `tmux attach -t ocalt` to watch any job running live
5. Output is logged to `logs/` and optionally sent to Telegram
6. Your own `claude` terminal works independently — no conflicts

## Watching Claude Work

```bash
# See all running sessions
tmux list-windows -t ocalt

# Attach and watch a specific job
tmux select-window -t ocalt:heartbeat
tmux attach -t ocalt

# Switch between job windows
# Ctrl-B + n (next window)
# Ctrl-B + p (previous window)
# Ctrl-B + 0-9 (window by number)

# Detach without stopping anything
# Ctrl-B + d
```

## Config

See `config.example.json`. Each job has:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Job name (also the tmux window name) |
| `schedule` | string | Cron expression (e.g., `*/30 * * * *`) |
| `mode` | `continue` \| `fresh` | Continue existing session or start new |
| `prompt` | string | What to send Claude |
| `sessionName` | string | (optional) Named session for `continue` mode |
| `telegram` | boolean | (optional) Send output to Telegram |
| `interactive` | boolean | (optional) Keep tmux window open after completion |
| `timeout` | number | (optional) Max seconds before killing the job |
| `allowedTools` | string | (optional) `--allowedTools` flag value |

## Using Your Own Claude Terminal

The scheduler doesn't lock anything. Claude Code sessions are identified by conversation ID, not by process. You can:

- Run `claude` in any terminal for your own interactive use
- The scheduler's `--continue` jobs resume *their* session, not yours
- Multiple `fresh` jobs can run simultaneously in separate tmux windows
- Everything is independent

## Logs

Job output is saved to `logs/JOBNAME-YYYY-MM-DD-HHMMSS.log`. View recent:

```bash
ls -la logs/
tail -f logs/heartbeat-*.log  # follow heartbeat output
```

## Commands

```bash
bun run start          # Start scheduler daemon
bun run start:bg       # Start in background (detached tmux)
bun run stop           # Stop scheduler
bun run status         # Show job schedule + last run times
bun run trigger <name> # Manually trigger a job now
bun run logs <name>    # Tail logs for a job
```
