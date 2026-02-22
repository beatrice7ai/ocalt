#!/usr/bin/env bun
/**
 * OCALT Scheduler Daemon
 *
 * Runs Claude Code CLI on cron schedules in visible tmux windows.
 * Two modes: "continue" (persistent session) and "fresh" (isolated).
 */

import { CronJob } from "cron";
import { spawn, execSync } from "child_process";
import { readFileSync, mkdirSync, appendFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

// --- Types ---
interface TelegramConfig {
  botToken: string;
  userId: string;
}

interface Job {
  name: string;
  schedule: string;
  mode: "continue" | "fresh";
  prompt: string;
  sessionName?: string;
  telegram?: boolean;
  suppressIfMatch?: string;
  interactive?: boolean;
  timeout?: number;
  allowedTools?: string;
}

interface Config {
  telegram?: TelegramConfig;
  jobs: Job[];
}

// --- Paths ---
const ROOT = import.meta.dir.replace("/src", "");
const CONFIG_PATH = join(ROOT, "config.json");
const LOGS_DIR = join(ROOT, "logs");
const STATE_FILE = join(ROOT, ".state.json");
const TMUX_SESSION = "ocalt";

// --- State tracking ---
interface JobState {
  lastRun?: string;
  lastStatus?: "ok" | "error" | "timeout" | "suppressed";
  lastDuration?: number;
  runCount: number;
}

function loadState(): Record<string, JobState> {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state: Record<string, JobState>) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Config ---
function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`❌ No config.json found. Copy config.example.json to config.json and edit it.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

// --- Telegram ---
async function sendTelegram(config: TelegramConfig, text: string) {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.userId,
        text: text.slice(0, 4096),
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error(`Telegram send error:`, err);
  }
}

// --- tmux helpers ---
function ensureTmuxSession() {
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
  } catch {
    // Create session with a placeholder window
    execSync(`tmux new-session -d -s ${TMUX_SESSION} -n scheduler`);
    console.log(`📺 Created tmux session: ${TMUX_SESSION}`);
    console.log(`   Attach with: tmux attach -t ${TMUX_SESSION}`);
  }
}

function tmuxWindowExists(name: string): boolean {
  try {
    execSync(`tmux list-windows -t ${TMUX_SESSION} -F '#W' 2>/dev/null | grep -q '^${name}$'`);
    return true;
  } catch {
    return false;
  }
}

// --- Job runner ---
async function runJob(job: Job, config: Config): Promise<void> {
  const state = loadState();
  const jobState: JobState = state[job.name] || { runCount: 0 };
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logFile = join(LOGS_DIR, `${job.name}-${timestamp}.log`);

  console.log(`\n🚀 [${new Date().toLocaleTimeString()}] Running job: ${job.name} (${job.mode})`);

  // Build claude command
  const args: string[] = ["-p", job.prompt];

  if (job.mode === "continue") {
    args.push("--continue");
    if (job.sessionName) {
      args.push("--resume", job.sessionName);
    }
  }

  if (job.allowedTools) {
    args.push("--allowedTools", job.allowedTools);
  }

  // Build the full command string for tmux
  const claudeCmd = `claude ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
  const fullCmd = job.interactive
    ? `${claudeCmd} 2>&1 | tee '${logFile}'`
    : `${claudeCmd} 2>&1 | tee '${logFile}'; echo "--- JOB COMPLETE ---"`;

  // Ensure tmux session exists
  ensureTmuxSession();

  // Create or reuse tmux window
  if (tmuxWindowExists(job.name)) {
    // Send command to existing window
    execSync(`tmux send-keys -t ${TMUX_SESSION}:${job.name} '${fullCmd.replace(/'/g, "'\\''")}' Enter`);
  } else {
    // Create new window with the command
    execSync(`tmux new-window -t ${TMUX_SESSION} -n ${job.name} '${fullCmd.replace(/'/g, "'\\''")}'`);
  }

  // Wait for completion by watching the log file
  return new Promise<void>((resolve) => {
    const timeoutMs = (job.timeout || 120) * 1000;
    let elapsed = 0;
    const pollInterval = 2000;

    const poll = setInterval(() => {
      elapsed += pollInterval;

      // Check if log file has completion marker or process finished
      let logContent = "";
      try {
        logContent = readFileSync(logFile, "utf-8");
      } catch {
        // File not created yet
      }

      const isComplete = logContent.includes("--- JOB COMPLETE ---") || elapsed >= timeoutMs;

      if (isComplete) {
        clearInterval(poll);
        const duration = (Date.now() - startTime) / 1000;

        // Clean up the completion marker
        const output = logContent.replace("--- JOB COMPLETE ---", "").trim();

        // Check suppression
        const shouldSuppress =
          job.suppressIfMatch && output.includes(job.suppressIfMatch);

        if (shouldSuppress) {
          console.log(`   ⏭️  Suppressed (matched: ${job.suppressIfMatch}) [${duration.toFixed(1)}s]`);
          jobState.lastStatus = "suppressed";
        } else if (elapsed >= timeoutMs) {
          console.log(`   ⏰ Timed out after ${job.timeout}s`);
          jobState.lastStatus = "timeout";

          if (job.telegram && config.telegram?.botToken) {
            sendTelegram(config.telegram, `⏰ *${job.name}* timed out after ${job.timeout}s`);
          }
        } else {
          console.log(`   ✅ Complete [${duration.toFixed(1)}s, ${output.length} chars]`);
          jobState.lastStatus = "ok";

          // Send to Telegram if configured
          if (job.telegram && config.telegram?.botToken && output) {
            const prefix = `📋 *${job.name}*\n\n`;
            sendTelegram(config.telegram, prefix + output);
          }
        }

        // Update state
        jobState.lastRun = new Date().toISOString();
        jobState.lastDuration = duration;
        jobState.runCount++;
        state[job.name] = jobState;
        saveState(state);

        // Close window if not interactive
        if (!job.interactive) {
          try {
            execSync(`tmux kill-window -t ${TMUX_SESSION}:${job.name} 2>/dev/null`);
          } catch {
            // Window may already be gone
          }
        }

        resolve();
      }
    }, pollInterval);
  });
}

// --- Main ---
async function main() {
  const config = loadConfig();

  // Ensure logs directory
  mkdirSync(LOGS_DIR, { recursive: true });

  console.log(`
╔══════════════════════════════════════╗
║       OCALT Scheduler v1.0          ║
║   Claude Code on a Schedule         ║
╚══════════════════════════════════════╝
`);

  console.log(`📅 ${config.jobs.length} jobs configured:\n`);

  // Register cron jobs
  const cronJobs: CronJob[] = [];

  for (const job of config.jobs) {
    console.log(`   ${job.name}`);
    console.log(`     Schedule: ${job.schedule}`);
    console.log(`     Mode:     ${job.mode}`);
    console.log(`     Prompt:   ${job.prompt.slice(0, 60)}...`);
    console.log();

    const cronJob = new CronJob(job.schedule, () => runJob(job, config), null, true);
    cronJobs.push(cronJob);
  }

  // Ensure tmux session exists
  ensureTmuxSession();

  console.log(`\n👀 Watch jobs run: tmux attach -t ${TMUX_SESSION}`);
  console.log(`🛑 Stop: Ctrl+C or bun run stop\n`);
  console.log(`⏳ Waiting for next scheduled job...\n`);

  // Keep alive
  process.on("SIGINT", () => {
    console.log("\n🛑 Shutting down scheduler...");
    cronJobs.forEach((j) => j.stop());
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cronJobs.forEach((j) => j.stop());
    process.exit(0);
  });

  // Heartbeat log
  setInterval(() => {
    // Silent keepalive
  }, 60_000);
}

main().catch(console.error);
