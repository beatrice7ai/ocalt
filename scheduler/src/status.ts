#!/usr/bin/env bun
/**
 * Show scheduler status: jobs, schedules, last run times.
 */

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const ROOT = import.meta.dir.replace("/src", "");
const CONFIG_PATH = join(ROOT, "config.json");
const STATE_FILE = join(ROOT, ".state.json");

if (!existsSync(CONFIG_PATH)) {
  console.error("❌ No config.json found.");
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

let state: Record<string, any> = {};
try {
  state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
} catch {}

console.log(`
╔══════════════════════════════════════╗
║       OCALT Scheduler Status        ║
╚══════════════════════════════════════╝
`);

// Check if tmux session is running
let tmuxRunning = false;
try {
  execSync(`tmux has-session -t ocalt 2>/dev/null`);
  tmuxRunning = true;
} catch {}

console.log(`Daemon: ${tmuxRunning ? "🟢 Running" : "🔴 Stopped"}`);
console.log(`Telegram: ${config.telegram?.botToken ? "🟢 Configured" : "⚪ Not configured"}\n`);

console.log("Jobs:\n");

for (const job of config.jobs) {
  const s = state[job.name];
  const statusEmoji = s?.lastStatus === "ok" ? "✅" :
                      s?.lastStatus === "error" ? "❌" :
                      s?.lastStatus === "timeout" ? "⏰" :
                      s?.lastStatus === "suppressed" ? "⏭️" : "⚪";

  console.log(`  ${job.name}`);
  console.log(`    Schedule:   ${job.schedule}`);
  console.log(`    Mode:       ${job.mode}`);
  console.log(`    Telegram:   ${job.telegram ? "yes" : "no"}`);
  console.log(`    Last run:   ${s?.lastRun ? new Date(s.lastRun).toLocaleString() : "never"}`);
  console.log(`    Last status: ${statusEmoji} ${s?.lastStatus || "never run"}`);
  console.log(`    Duration:   ${s?.lastDuration ? s.lastDuration.toFixed(1) + "s" : "-"}`);
  console.log(`    Total runs: ${s?.runCount || 0}`);
  console.log();
}

if (tmuxRunning) {
  console.log(`\n👀 Watch: tmux attach -t ocalt`);
  try {
    const windows = execSync(`tmux list-windows -t ocalt -F '#W' 2>/dev/null`, { encoding: "utf-8" }).trim();
    console.log(`Active windows: ${windows.split("\n").join(", ")}`);
  } catch {}
}
