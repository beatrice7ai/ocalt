#!/usr/bin/env bun
/**
 * Manually trigger a job by name.
 * Usage: bun run trigger <job-name>
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = import.meta.dir.replace("/src", "");
const CONFIG_PATH = join(ROOT, "config.json");

const jobName = process.argv[2];

if (!jobName) {
  console.log("Usage: bun run trigger <job-name>");
  console.log("\nAvailable jobs:");

  if (existsSync(CONFIG_PATH)) {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    for (const job of config.jobs) {
      console.log(`  ${job.name} (${job.mode}) — ${job.schedule}`);
    }
  }
  process.exit(1);
}

if (!existsSync(CONFIG_PATH)) {
  console.error("❌ No config.json found.");
  process.exit(1);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
const job = config.jobs.find((j: any) => j.name === jobName);

if (!job) {
  console.error(`❌ Job "${jobName}" not found.`);
  process.exit(1);
}

// Dynamic import to reuse the runner
const { runJob } = await import("./daemon.ts");

console.log(`🔫 Triggering job: ${jobName}`);

// We can't easily reuse runJob as it's embedded in main()
// Instead, just build and exec the claude command directly
import { execSync } from "child_process";

const args: string[] = ["-p", job.prompt];
if (job.mode === "continue") {
  args.push("--continue");
  if (job.sessionName) args.push("--resume", job.sessionName);
}
if (job.allowedTools) args.push("--allowedTools", job.allowedTools);

const cmd = `claude ${args.map((a: string) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;

console.log(`Running: ${cmd.slice(0, 100)}...`);
console.log("---");

try {
  const output = execSync(cmd, {
    encoding: "utf-8",
    timeout: (job.timeout || 120) * 1000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  console.log(output);
  console.log("---");
  console.log("✅ Done");
} catch (err: any) {
  console.error("❌ Error:", err.message);
  process.exit(1);
}
