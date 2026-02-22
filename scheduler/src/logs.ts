#!/usr/bin/env bun
/**
 * Tail logs for a specific job.
 * Usage: bun run logs <job-name>
 */

import { readdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const ROOT = import.meta.dir.replace("/src", "");
const LOGS_DIR = join(ROOT, "logs");

const jobName = process.argv[2];

if (!jobName) {
  console.log("Usage: bun run logs <job-name>\n");
  try {
    const files = readdirSync(LOGS_DIR).sort().reverse().slice(0, 20);
    console.log("Recent logs:");
    for (const f of files) {
      console.log(`  ${f}`);
    }
  } catch {
    console.log("No logs yet.");
  }
  process.exit(0);
}

// Find most recent log for this job
try {
  const files = readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith(jobName))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log(`No logs found for job: ${jobName}`);
    process.exit(1);
  }

  const latest = join(LOGS_DIR, files[0]);
  console.log(`📄 ${latest}\n---`);
  execSync(`cat '${latest}'`, { stdio: "inherit" });
} catch (err: any) {
  console.error("Error:", err.message);
}
