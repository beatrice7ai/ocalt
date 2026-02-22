#!/usr/bin/env bun
/**
 * Manually trigger a job.
 * Usage: bun run trigger <agent-name>/<job-name>
 *    or: bun run trigger <agent-name>   (lists that agent's jobs)
 *    or: bun run trigger                (lists all)
 */

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import { homedir } from "os";

const ROOT = import.meta.dir.replace("/src", "");
const CONFIG_PATH = join(ROOT, "config.json");

function expandPath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

if (!existsSync(CONFIG_PATH)) {
  console.error("❌ No config.json found.");
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const input = process.argv[2];

if (!input) {
  console.log("Usage: bun run trigger <agent>/<job>\n\nAvailable:\n");
  for (const agent of config.agents) {
    for (const job of agent.jobs) {
      console.log(`  ${agent.name}/${job.name}  [${job.mode}]  ${job.schedule}`);
    }
  }
  process.exit(0);
}

const [agentName, jobName] = input.includes("/")
  ? input.split("/", 2)
  : [input, null];

const agent = config.agents.find((a: any) => a.name === agentName);
if (!agent) {
  console.error(`❌ Agent "${agentName}" not found.`);
  process.exit(1);
}

if (!jobName) {
  console.log(`Jobs for ${agentName}:\n`);
  for (const job of agent.jobs) {
    console.log(`  ${agentName}/${job.name}  [${job.mode}]  ${job.schedule}`);
  }
  process.exit(0);
}

const job = agent.jobs.find((j: any) => j.name === jobName);
if (!job) {
  console.error(`❌ Job "${jobName}" not found in agent "${agentName}".`);
  process.exit(1);
}

const workdir = expandPath(agent.workdir);
const args: string[] = ["-p", job.prompt];
if (job.mode === "continue") args.push("--continue");
if (job.allowedTools) args.push("--allowedTools", job.allowedTools);

const cmd = `cd '${workdir}' && claude ${args.map((a: string) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;

console.log(`🔫 Triggering: ${agentName}/${jobName} (${job.mode})`);
console.log(`   Workdir: ${workdir}`);
console.log("---\n");

try {
  execSync(cmd, {
    encoding: "utf-8",
    timeout: (job.timeout || 120) * 1000,
    stdio: "inherit",
  });
  console.log("\n---\n✅ Done");
} catch (err: any) {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
}
