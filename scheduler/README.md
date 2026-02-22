# OCALT Multi-Agent Scheduler

**Run multiple Claude Code agents on separate projects, on a schedule, in visible tmux sessions.**

Each agent gets:
- **Its own working directory** (project context, CLAUDE.md, files)
- **Its own session history** (`--continue` resumes per-agent, self-compacting)
- **Its own tmux windows** (watch any agent work in real time)
- **Cron-based scheduling** (any cron expression)

Two job modes:
- **`continue`** — resumes the agent's ongoing session. Claude manages context window automatically — old messages get summarized as the session grows (self-compacting).
- **`fresh`** — clean slate each run. Good for isolated tasks that don't need prior context.

## Quick Start

```bash
cd scheduler
bash setup.sh          # install deps, create config
# Edit config.json with your agents and schedules

bun run start          # start the scheduler

# Watch agents work
tmux attach -t ocalt   # see all agent windows
# Ctrl-B + n/p to switch between agents
# Ctrl-B + d to detach (agents keep running)
```

## How It Works

1. You define **agents** — each with a name, working directory, and list of jobs
2. Each agent's `workdir` is its project root — Claude reads files there for context
3. A `CLAUDE.md` is auto-created in each workdir on first run (you customize it)
4. **`continue` jobs** resume the agent's session — Claude remembers prior runs, and the session self-compacts (automatically summarizes old context as the window fills up)
5. **`fresh` jobs** start a new session each time — no memory of prior runs
6. Every job runs in a **visible tmux window** — you can watch Claude think, code, and execute tools
7. Output is logged and optionally sent to Telegram
8. Your own `claude` terminal works independently — no conflicts

## Multi-Agent Example

```json
{
  "agents": [
    {
      "name": "researcher",
      "workdir": "~/agents/researcher",
      "jobs": [
        { "name": "morning-scan", "schedule": "0 7 * * *", "mode": "continue", "prompt": "..." },
        { "name": "weekly-report", "schedule": "0 9 * * 1", "mode": "fresh", "prompt": "..." }
      ]
    },
    {
      "name": "developer",
      "workdir": "~/agents/developer",
      "jobs": [
        { "name": "overnight-coding", "schedule": "0 1 * * *", "mode": "continue", "prompt": "..." }
      ]
    }
  ]
}
```

Each agent is isolated — separate workdir, separate session, separate tmux window. They don't interfere with each other or with your interactive `claude` use.

## Watching Agents Work

```bash
# Attach to the scheduler tmux session
tmux attach -t ocalt

# You'll see windows like:
# 0:dashboard  1:researcher-morning-scan  2:developer-overnight-coding

# Switch between agent windows
# Ctrl-B + n (next)
# Ctrl-B + p (previous)
# Ctrl-B + 0-9 (by number)

# Detach without stopping anything
# Ctrl-B + d
```

## Config Reference

### Agent fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Agent name (used in tmux window names, logs) |
| `description` | string | What this agent does |
| `workdir` | string | Working directory (supports `~/`). Auto-created. |
| `claudeProfile` | string | (optional) Claude Code profile name |
| `jobs` | Job[] | List of scheduled jobs |

### Job fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Job name |
| `schedule` | string | Cron expression (e.g., `*/30 * * * *`) |
| `mode` | `continue` \| `fresh` | Persist session or start clean |
| `prompt` | string | What to send Claude |
| `telegram` | boolean | Send output to Telegram |
| `suppressIfMatch` | string | Don't notify if output contains this (e.g., `HEARTBEAT_OK`) |
| `interactive` | boolean | Keep tmux window open after job completes |
| `timeout` | number | Max seconds before killing |
| `allowedTools` | string | `--allowedTools` flag value |

## Session Self-Compaction

When using `continue` mode, Claude Code manages its own context window:
- Early messages get automatically summarized as the conversation grows
- The session stays coherent without you managing context manually
- Each agent's session is independent — `researcher`'s context doesn't affect `developer`'s

This means an agent can run for weeks on `continue` mode without running out of context.

## Using Your Own Claude Terminal

The scheduler doesn't lock anything. You can:
- Run `claude` in any terminal for interactive use
- Each agent's `--continue` resumes **its own** session, not yours
- Multiple agents can run simultaneously in separate tmux windows
- Everything is independent

## Commands

```bash
bun run start                    # Start scheduler
bun run start:bg                 # Start in background
bun run stop                     # Stop everything
bun run status                   # Show all agents + job history
bun run trigger researcher/morning-scan   # Run a job now
bun run trigger researcher       # List an agent's jobs
bun run logs researcher-morning-scan      # View latest log
```
