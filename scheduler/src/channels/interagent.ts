/**
 * Inter-agent communication layer.
 *
 * Three methods for agents to talk to each other:
 *
 * 1. DISCORD SHARED CHANNELS
 *    Agents read/write to shared Discord channels.
 *    Good for: async handoffs, broadcasting findings, standup updates.
 *
 * 2. SHARED FILESYSTEM (drop folder)
 *    Agents read/write to a common directory.
 *    Good for: passing files, structured data, when Discord isn't configured.
 *
 * 3. DIRECT DISPATCH
 *    One agent triggers another agent's session directly.
 *    Good for: "hey developer, I found a bug" → runs developer with that context.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

// --- Types ---
export interface AgentInfo {
  name: string;
  workdir: string;
  allowedTools?: string;
  timeout?: number;
}

export interface InteragentConfig {
  sharedDir?: string; // Shared filesystem drop folder (default: ~/agents/.shared)
  discordSharedChannels?: string[]; // Channel names agents can post to (e.g., ["handoff", "findings", "standup"])
}

// --- Shared filesystem ---

function expandPath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

/**
 * Post a message to the shared drop folder.
 * Creates a timestamped file that other agents can read.
 */
export function postToDropFolder(
  config: InteragentConfig,
  fromAgent: string,
  channel: string,
  message: string
) {
  const sharedDir = expandPath(config.sharedDir || "~/agents/.shared");
  const channelDir = join(sharedDir, channel);
  mkdirSync(channelDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${timestamp}-${fromAgent}.md`;
  const content = `# From: ${fromAgent}\n# Time: ${new Date().toISOString()}\n# Channel: ${channel}\n\n${message}\n`;

  writeFileSync(join(channelDir, filename), content);
}

/**
 * Read recent messages from a shared channel.
 * Returns messages from the last N hours (default 24).
 */
export function readDropFolder(
  config: InteragentConfig,
  channel: string,
  maxAgeHours: number = 24
): Array<{ from: string; time: string; content: string }> {
  const sharedDir = expandPath(config.sharedDir || "~/agents/.shared");
  const channelDir = join(sharedDir, channel);

  if (!existsSync(channelDir)) return [];

  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const files = readdirSync(channelDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();

  const messages: Array<{ from: string; time: string; content: string }> = [];

  for (const file of files) {
    const raw = readFileSync(join(channelDir, file), "utf-8");
    const fromMatch = raw.match(/^# From: (.+)$/m);
    const timeMatch = raw.match(/^# Time: (.+)$/m);
    const time = timeMatch?.[1] || "";

    if (new Date(time).getTime() < cutoff) break;

    // Strip header lines
    const content = raw
      .split("\n")
      .filter((l) => !l.startsWith("# "))
      .join("\n")
      .trim();

    messages.push({
      from: fromMatch?.[1] || "unknown",
      time,
      content,
    });
  }

  return messages;
}

/**
 * Build a context string from shared channel messages.
 * Agents include this in their prompts to see what other agents posted.
 */
export function buildSharedContext(
  config: InteragentConfig,
  channels: string[],
  maxAgeHours: number = 24
): string {
  const sections: string[] = [];

  for (const channel of channels) {
    const messages = readDropFolder(config, channel, maxAgeHours);
    if (messages.length === 0) continue;

    sections.push(`## #${channel} (last ${maxAgeHours}h)\n`);
    for (const msg of messages) {
      sections.push(`**${msg.from}** (${msg.time}):\n${msg.content}\n`);
    }
  }

  return sections.length > 0
    ? `# Messages from other agents\n\n${sections.join("\n")}`
    : "";
}

/**
 * Dispatch a message directly to another agent's session.
 * Runs claude --continue in the target agent's workdir.
 */
export function dispatchToAgent(
  targetAgent: AgentInfo,
  fromAgent: string,
  message: string
): string {
  const workdir = expandPath(targetAgent.workdir);
  const prefixedMessage = `[Message from ${fromAgent}]: ${message}`;

  const args = ["-p", prefixedMessage, "--continue"];
  if (targetAgent.allowedTools) {
    args.push("--allowedTools", targetAgent.allowedTools);
  }

  const cmd = `cd '${workdir}' && claude ${args
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ")}`;

  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: (targetAgent.timeout || 120) * 1000,
    }).trim();
    return output || "(empty response)";
  } catch (err: any) {
    return `Error: ${err.message?.slice(0, 500)}`;
  }
}

/**
 * Generate agent CLAUDE.md instructions for inter-agent communication.
 * Append this to each agent's CLAUDE.md so they know how to talk to each other.
 */
export function generateAgentInstructions(
  config: InteragentConfig,
  agentName: string,
  allAgents: AgentInfo[]
): string {
  const sharedDir = expandPath(config.sharedDir || "~/agents/.shared");
  const otherAgents = allAgents.filter((a) => a.name !== agentName);

  return `
## Inter-Agent Communication

You can communicate with other agents through shared drop folders.

### Shared Directory: ${sharedDir}

**To post a message for other agents:**
Write a markdown file to the appropriate channel folder:
\`\`\`
${sharedDir}/handoff/    — Task handoffs and requests
${sharedDir}/findings/   — Research findings and discoveries  
${sharedDir}/standup/    — Status updates
\`\`\`

File naming: \`YYYY-MM-DDTHHMMSS-${agentName}.md\`

**To read messages from other agents:**
Read recent files from any channel folder. Check timestamps — focus on the last 24h.

### Other Agents
${otherAgents.map((a) => `- **${a.name}**: ${a.workdir}`).join("\n")}

### Guidelines
- Post to #handoff when you have work for another agent
- Post to #findings when you discover something others should know
- Post to #standup at the end of each job with what you did
- Read #handoff at the start of each job for incoming requests
- Be specific — other agents don't share your session memory
`;
}
