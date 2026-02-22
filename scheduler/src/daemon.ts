#!/usr/bin/env bun
/**
 * OCALT Multi-Agent Scheduler Daemon
 *
 * - Multiple Claude Code agents, each with own workdir + session
 * - Cron-scheduled jobs (continue or fresh mode)
 * - Visible in tmux windows (watch agents work)
 * - Telegram: reply to agent messages or @agent prefix
 * - Discord: each agent gets its own channel
 */

import { CronJob } from "cron";
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import {
  sendAgentMessage as sendTelegramMessage,
  startTelegramListener,
  type TelegramConfig,
} from "./channels/telegram.ts";
import {
  sendAgentMessage as sendDiscordMessage,
  startDiscordListener,
  getOrCreateChannels,
  type DiscordConfig,
} from "./channels/discord.ts";
import {
  buildSharedContext,
  postToDropFolder,
  generateAgentInstructions,
  type InteragentConfig,
} from "./channels/interagent.ts";

// --- Types ---
interface Job {
  name: string;
  schedule: string;
  mode: "continue" | "fresh";
  prompt: string;
  telegram?: boolean;
  discord?: boolean;
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
  allowedTools?: string;
  timeout?: number;
}

interface Config {
  telegram?: TelegramConfig & { enabled?: boolean };
  discord?: DiscordConfig & { enabled?: boolean };
  interagent?: InteragentConfig;
  agents: Agent[];
}

// --- Paths ---
const ROOT = import.meta.dir.replace("/src", "");
const CONFIG_PATH = join(ROOT, "config.json");
const LOGS_DIR = join(ROOT, "logs");
const STATE_FILE = join(ROOT, ".state.json");
const TMUX_SESSION = "ocalt";

// --- State ---
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

function expandPath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    console.error(
      `❌ No config.json found. Copy config.example.json to config.json and edit it.`
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

// --- tmux ---
function ensureTmuxSession() {
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
  } catch {
    execSync(`tmux new-session -d -s ${TMUX_SESSION} -n dashboard`);
    console.log(`📺 Created tmux session: ${TMUX_SESSION}`);
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

// --- Agent workspace ---
function ensureAgentWorkspace(agent: Agent, config: Config, allAgents: Agent[]) {
  const workdir = expandPath(agent.workdir);
  mkdirSync(workdir, { recursive: true });

  const claudeMd = join(workdir, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    const interagentInstructions = config.interagent
      ? generateAgentInstructions(
          config.interagent,
          agent.name,
          allAgents.map((a) => ({
            name: a.name,
            workdir: a.workdir,
            allowedTools: a.allowedTools,
            timeout: a.timeout,
          }))
        )
      : "";

    writeFileSync(
      claudeMd,
      `# ${agent.name}\n\n${agent.description || "OCALT agent"}\n\n` +
        `## Working Directory\n${workdir}\n\n` +
        `## Instructions\n` +
        `You are the "${agent.name}" agent. You work in this directory.\n` +
        `Check your project files for context before starting any task.\n` +
        `Write results, notes, and logs to files in this directory.\n` +
        interagentInstructions
    );
    console.log(`   📝 Created CLAUDE.md for ${agent.name}`);
  }
}

// --- Job runner ---
async function runJob(
  agent: Agent,
  job: Job,
  config: Config,
  discordChannelMap?: Record<string, string>
): Promise<void> {
  const stateKey = `${agent.name}/${job.name}`;
  const state = loadState();
  const jobState: JobState = state[stateKey] || { runCount: 0 };
  const startTime = Date.now();
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const logFile = join(LOGS_DIR, `${agent.name}-${job.name}-${timestamp}.log`);
  const windowName = `${agent.name}-${job.name}`;
  const workdir = expandPath(agent.workdir);

  console.log(
    `\n🚀 [${new Date().toLocaleTimeString()}] ${agent.name}/${job.name} (${job.mode})`
  );

  // Build prompt — optionally inject shared context from other agents
  let prompt = job.prompt;
  if (config.interagent?.sharedDir) {
    const sharedChannels = config.interagent.discordSharedChannels || ["handoff", "findings", "standup"];
    const sharedContext = buildSharedContext(config.interagent, sharedChannels, 24);
    if (sharedContext) {
      prompt = `${prompt}\n\n---\n${sharedContext}`;
    }
  }

  // Build claude command
  const args: string[] = ["-p", prompt];
  if (job.mode === "continue") args.push("--continue");
  if (job.allowedTools || agent.allowedTools) {
    args.push("--allowedTools", job.allowedTools || agent.allowedTools!);
  }

  const claudeCmd = `claude ${args
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ")}`;
  const fullCmd = [
    `cd '${workdir}'`,
    `echo "=== ${agent.name}/${job.name} [${job.mode}] $(date) ===" | tee '${logFile}'`,
    `${claudeCmd} 2>&1 | tee -a '${logFile}'`,
    job.interactive ? "" : `echo "--- JOB COMPLETE ---" | tee -a '${logFile}'`,
  ]
    .filter(Boolean)
    .join(" && ");

  ensureTmuxSession();

  if (tmuxWindowExists(windowName)) {
    execSync(
      `tmux send-keys -t ${TMUX_SESSION}:${windowName} '${fullCmd.replace(
        /'/g,
        "'\\''"
      )}' Enter`
    );
  } else {
    execSync(
      `tmux new-window -t ${TMUX_SESSION} -n ${windowName} "bash -c \\"${fullCmd.replace(
        /"/g,
        '\\\\\\"'
      )}; ${job.interactive ? "bash" : "sleep 2"}\\""` 
    );
  }

  // Wait for completion
  return new Promise<void>((resolve) => {
    const timeoutMs = (job.timeout || agent.timeout || 120) * 1000;
    let elapsed = 0;
    const pollInterval = 3000;

    const poll = setInterval(async () => {
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

          // Notify on timeout
          if (job.telegram !== false && config.telegram?.enabled && config.telegram.botToken) {
            await sendTelegramMessage(
              config.telegram,
              agent.name,
              job.name,
              `⏰ Timed out after ${job.timeout || agent.timeout || 120}s`
            );
          }
        } else {
          console.log(
            `   ✅ ${agent.name}/${job.name} [${duration.toFixed(1)}s, ${output.length} chars]`
          );
          jobState.lastStatus = "ok";

          // Send to Telegram
          if (job.telegram !== false && config.telegram?.enabled && config.telegram.botToken && output) {
            await sendTelegramMessage(
              config.telegram,
              agent.name,
              job.name,
              output
            );
          }

          // Send to Discord
          if (job.discord !== false && config.discord?.enabled && config.discord.botToken && discordChannelMap && output) {
            await sendDiscordMessage(
              config.discord,
              discordChannelMap,
              agent.name,
              job.name,
              output
            );
          }
        }

        jobState.lastRun = new Date().toISOString();
        jobState.lastDuration = duration;
        jobState.runCount++;
        state[stateKey] = jobState;
        saveState(state);

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
╔══════════════════════════════════════════════╗
║     OCALT Multi-Agent Scheduler v3.0        ║
║     Claude Code Agents · Telegram · Discord ║
╚══════════════════════════════════════════════╝
`);

  // --- Channel status ---
  const telegramEnabled = config.telegram?.enabled && config.telegram?.botToken;
  const discordEnabled = config.discord?.enabled && config.discord?.botToken;

  console.log(`📱 Telegram: ${telegramEnabled ? "🟢 Enabled" : "⚪ Disabled"}`);
  console.log(`🎮 Discord:  ${discordEnabled ? "🟢 Enabled" : "⚪ Disabled"}`);
  console.log(`🤖 Agents:   ${config.agents.length}`);
  console.log(`📅 Jobs:     ${totalJobs}\n`);

  // --- Setup Discord channels ---
  let discordChannelMap: Record<string, string> | undefined;
  if (discordEnabled) {
    try {
      const agentInfos = config.agents.map((a) => ({
        name: a.name,
        workdir: a.workdir,
        description: a.description,
        allowedTools: a.allowedTools,
        timeout: a.timeout,
      }));
      discordChannelMap = await getOrCreateChannels(config.discord!, agentInfos);
      console.log(
        `🎮 Discord channels: ${Object.entries(discordChannelMap)
          .map(([a]) => `#${a}`)
          .join(", ")}`
      );
    } catch (err) {
      console.error("Discord setup error:", err);
    }
  }

  // --- Register cron jobs ---
  const cronJobs: CronJob[] = [];

  for (const agent of config.agents) {
    console.log(`\n  📦 ${agent.name} — ${agent.description || ""}`);
    console.log(`     Workdir: ${agent.workdir}`);
    ensureAgentWorkspace(agent, config, config.agents);

    for (const job of agent.jobs) {
      console.log(`     ├─ ${job.name} [${job.mode}] ${job.schedule}`);

      const cronJob = new CronJob(
        job.schedule,
        () => runJob(agent, job, config, discordChannelMap),
        null,
        true
      );
      cronJobs.push(cronJob);
    }
  }

  ensureTmuxSession();

  // --- Start channel listeners ---
  const agentInfos = config.agents.map((a) => ({
    name: a.name,
    workdir: a.workdir,
    description: a.description,
    allowedTools: a.allowedTools,
    timeout: a.timeout,
  }));

  if (telegramEnabled) {
    // Run listener in background (non-blocking)
    startTelegramListener(config.telegram!, agentInfos).catch((err) =>
      console.error("Telegram listener error:", err)
    );
  }

  if (discordEnabled) {
    startDiscordListener(config.discord!, agentInfos).catch((err) =>
      console.error("Discord listener error:", err)
    );
  }

  console.log(`\n👀 Watch: tmux attach -t ${TMUX_SESSION}`);
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

  setInterval(() => {}, 60_000);
}

main().catch(console.error);

// Export for trigger.ts
export { runJob };
