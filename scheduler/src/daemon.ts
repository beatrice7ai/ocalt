#!/usr/bin/env bun
/**
 * OCALT Scheduler Daemon — Multi-Agent Edition
 *
 * Runs multiple Claude Code agents on cron schedules.
 * Each agent has its own:
 *   - Working directory (project context)
 *   - Session history (--continue resumes per-agent)
 *   - tmux window (watch it work)
 *
 * Two modes per job:
 *   - "continue" — resumes the agent's session (persistent memory, self-compacting)
 *   - "fresh"    — clean slate (isolated task)
 */

import { CronJob } from "cron";
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

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
  telegram?: boolean;
  suppressIfMatch?: string;
  interactive?: boolean;
  timeout?: number;
  allowedTools?: string;
}

interface Agent {
  name: string;
  description?: string;
  workdir: string;
  claudeProfile?: string;
  jobs: Job[];
}

interface Config {
  telegram?: TelegramConfig;
  agents: Agent[];
}

// --- Paths ---
const ROOT = import.meta.dir.replace("/src", "");
const CONFIG_PATH = join(ROOT, "config.json");
const LOGS_DIR = join(ROOT, "logs");
const STATE_FILE = join(ROOT, ".state.json");
const SESSION_DIR = join(ROOT, ".sessions");
const TMUX_SESSION = "ocalt";

// --- State tracking ---
interface JobState {
  lastRun?: string;
  lastStatus?: "ok" | "error" | "timeout" | "suppressed";
  lastDuration?: number;
  runCount: number;
  sessionId?: string;
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

// --- Resolve ~ in paths ---
function expandPath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
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
    execSync(`tmux new-session -d -s ${TMUX_SESSION} -n dashboard`);
    console.log(`📺 Created tmux session: ${TMUX_SESSION}`);
    console.log(`   Attach with: tmux attach -t ${TMUX_SESSION}`);
  }
}

function tmuxWindowExists(name: string): boolean {
  try {
    const windows = execSync(
      `tmux list-windows -t ${TMUX_SESSION} -F '#W' 2>/dev/null`,
      { encoding: "utf-8" }
    );
    return windows.split("\n").includes(name);
  } catch {
    return false;
  }
}

// --- Agent workspace setup ---
function ensureAgentWorkspace(agent: Agent) {
  const workdir = expandPath(agent.workdir);
  mkdirSync(workdir, { recursive: true });

  // Create a CLAUDE.md for the agent if it doesn't exist
  const claudeMd = join(workdir, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    writeFileSync(
      claudeMd,
      `# ${agent.name}\n\n${agent.description || "OCALT agent"}\n\n` +
      `## Working Directory\n${workdir}\n\n` +
      `## Instructions\n` +
      `You are the "${agent.name}" agent. You work in this directory.\n` +
      `Check your project files for context before starting any task.\n` +
      `Write results, notes, and logs to files in this directory.\n`
    );
    console.log(`   📝 Created CLAUDE.md for ${agent.name}`);
  }
}

// --- Session ID management ---
// Each agent's "continue" jobs share a session. Fresh jobs don't.
function getSessionFile(agentName: string): string {
  mkdirSync(SESSION_DIR, { recursive: true });
  return join(SESSION_DIR, `${agentName}.session`);
}

function getSessionId(agentName: string): string | null {
  const file = getSessionFile(agentName);
  try {
    return readFileSync(file, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function saveSessionId(agentName: string, sessionId: string) {
  writeFileSync(getSessionFile(agentName), sessionId);
}

// --- Job runner ---
async function runJob(agent: Agent, job: Job, config: Config): Promise<void> {
  const stateKey = `${agent.name}/${job.name}`;
  const state = loadState();
  const jobState: JobState = state[stateKey] || { runCount: 0 };
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logFile = join(LOGS_DIR, `${agent.name}-${job.name}-${timestamp}.log`);
  const windowName = `${agent.name}-${job.name}`;
  const workdir = expandPath(agent.workdir);

  console.log(
    `\n🚀 [${new Date().toLocaleTimeString()}] ${agent.name}/${job.name} (${job.mode})`
  );

  // Build claude command
  const args: string[] = ["-p", job.prompt];

  if (job.mode === "continue") {
    // Use --continue to resume the agent's ongoing session
    args.push("--continue");
  }

  if (job.allowedTools) {
    args.push("--allowedTools", job.allowedTools);
  }

  // Build command — cd to agent workdir first
  const claudeCmd = `claude ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
  const fullCmd = [
    `cd '${workdir}'`,
    `echo "=== ${agent.name}/${job.name} [${job.mode}] $(date) ===" | tee '${logFile}'`,
    `${claudeCmd} 2>&1 | tee -a '${logFile}'`,
    job.interactive ? "" : `echo "--- JOB COMPLETE ---" | tee -a '${logFile}'`,
  ]
    .filter(Boolean)
    .join(" && ");

  // Ensure tmux session exists
  ensureTmuxSession();

  // Run in tmux window
  if (tmuxWindowExists(windowName)) {
    execSync(
      `tmux send-keys -t ${TMUX_SESSION}:${windowName} '${fullCmd.replace(/'/g, "'\\''")}' Enter`
    );
  } else {
    execSync(
      `tmux new-window -t ${TMUX_SESSION} -n ${windowName} "bash -c \\"${fullCmd.replace(/"/g, '\\\\\\"')}; ${job.interactive ? 'bash' : 'sleep 2'}\\""` 
    );
  }

  // Wait for completion
  return new Promise<void>((resolve) => {
    const timeoutMs = (job.timeout || 120) * 1000;
    let elapsed = 0;
    const pollInterval = 3000;

    const poll = setInterval(() => {
      elapsed += pollInterval;

      let logContent = "";
      try {
        logContent = readFileSync(logFile, "utf-8");
      } catch {}

      const isComplete =
        logContent.includes("--- JOB COMPLETE ---") || elapsed >= timeoutMs;

      if (isComplete) {
        clearInterval(poll);
        const duration = (Date.now() - startTime) / 1000;
        const output = logContent.replace("--- JOB COMPLETE ---", "").trim();

        // Check suppression
        const shouldSuppress =
          job.suppressIfMatch && output.includes(job.suppressIfMatch);

        if (shouldSuppress) {
          console.log(
            `   ⏭️  ${agent.name}/${job.name} suppressed [${duration.toFixed(1)}s]`
          );
          jobState.lastStatus = "suppressed";
        } else if (elapsed >= timeoutMs) {
          console.log(`   ⏰ ${agent.name}/${job.name} timed out`);
          jobState.lastStatus = "timeout";
          if (job.telegram && config.telegram?.botToken) {
            sendTelegram(
              config.telegram,
              `⏰ *${agent.name}/${job.name}* timed out after ${job.timeout}s`
            );
          }
        } else {
          console.log(
            `   ✅ ${agent.name}/${job.name} [${duration.toFixed(1)}s, ${output.length} chars]`
          );
          jobState.lastStatus = "ok";
          if (job.telegram && config.telegram?.botToken && output) {
            const prefix = `🤖 *${agent.name}* — _${job.name}_\n\n`;
            sendTelegram(config.telegram, prefix + output);
          }
        }

        jobState.lastRun = new Date().toISOString();
        jobState.lastDuration = duration;
        jobState.runCount++;
        state[stateKey] = jobState;
        saveState(state);

        // Close window if not interactive
        if (!job.interactive) {
          try {
            execSync(
              `tmux kill-window -t ${TMUX_SESSION}:${windowName} 2>/dev/null`
            );
          } catch {}
        }

        resolve();
      }
    }, pollInterval);
  });
}

// --- Main ---
async function main() {
  const config = loadConfig();
  mkdirSync(LOGS_DIR, { recursive: true });

  const totalJobs = config.agents.reduce((n, a) => n + a.jobs.length, 0);

  console.log(`
╔══════════════════════════════════════════╗
║    OCALT Multi-Agent Scheduler v2.0     ║
║    Claude Code Agents on a Schedule     ║
╚══════════════════════════════════════════╝
`);

  console.log(`🤖 ${config.agents.length} agents, ${totalJobs} jobs\n`);

  const cronJobs: CronJob[] = [];

  for (const agent of config.agents) {
    console.log(`  📦 ${agent.name} — ${agent.description || ""}`);
    console.log(`     Workdir: ${agent.workdir}`);

    // Ensure workspace exists
    ensureAgentWorkspace(agent);

    for (const job of agent.jobs) {
      console.log(`     ├─ ${job.name} [${job.mode}] ${job.schedule}`);

      const cronJob = new CronJob(
        job.schedule,
        () => runJob(agent, job, config),
        null,
        true
      );
      cronJobs.push(cronJob);
    }
    console.log();
  }

  ensureTmuxSession();

  console.log(`👀 Watch: tmux attach -t ${TMUX_SESSION}`);
  console.log(`   Switch windows: Ctrl-B + n/p`);
  console.log(`   Each agent/job gets its own window\n`);
  console.log(`⏳ Waiting for next scheduled job...\n`);

  process.on("SIGINT", () => {
    console.log("\n🛑 Shutting down...");
    cronJobs.forEach((j) => j.stop());
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cronJobs.forEach((j) => j.stop());
    process.exit(0);
  });

  // Keepalive
  setInterval(() => {}, 60_000);
}

main().catch(console.error);
