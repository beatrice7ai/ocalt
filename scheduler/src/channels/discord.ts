/**
 * Discord channel — powered by discord.js
 *
 * Each agent gets its own channel in your server.
 * Messages in #researcher → routed to researcher agent's --continue session.
 * Agent output → posted in the agent's channel.
 */

import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type TextChannel,
  type CategoryChannel,
} from "discord.js";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

// --- Types ---
export interface DiscordConfig {
  botToken: string;
  guildId: string;
  categoryName?: string;
  allowedUserIds?: string[];
  enabled?: boolean;
}

export interface AgentInfo {
  name: string;
  workdir: string;
  description?: string;
  allowedTools?: string;
  timeout?: number;
}

type ChannelMap = Record<string, string>; // agent name → channel ID

// --- Paths ---
const ROOT = resolve(import.meta.dir, "../..");
const CACHE_FILE = join(ROOT, ".discord-channels.json");

function expandPath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

// --- Channel management ---
export async function getOrCreateChannels(
  config: DiscordConfig,
  agents: AgentInfo[]
): Promise<ChannelMap> {
  // Try cache first
  try {
    const cached: ChannelMap = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (agents.every((a) => cached[a.name])) return cached;
  } catch {}

  // Need the client to manage channels
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(config.botToken);

  const guild = await client.guilds.fetch(config.guildId);
  const channels = await guild.channels.fetch();
  const channelMap: ChannelMap = {};

  // Find or create category
  let category: CategoryChannel | undefined;
  if (config.categoryName) {
    category = channels.find(
      (c) =>
        c?.type === ChannelType.GuildCategory &&
        c.name.toLowerCase() === config.categoryName!.toLowerCase()
    ) as CategoryChannel | undefined;

    if (!category) {
      category = (await guild.channels.create({
        name: config.categoryName,
        type: ChannelType.GuildCategory,
      })) as CategoryChannel;
      console.log(`📁 Created Discord category: ${config.categoryName}`);
    }
  }

  // Find or create agent channels
  for (const agent of agents) {
    const channelName = agent.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const existing = channels.find(
      (c) =>
        c?.type === ChannelType.GuildText &&
        c.name === channelName &&
        (!category || c.parentId === category.id)
    );

    if (existing) {
      channelMap[agent.name] = existing.id;
    } else {
      const created = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category?.id,
        topic: agent.description || `OCALT agent: ${agent.name}`,
      });
      channelMap[agent.name] = created.id;
      console.log(`#️⃣  Created Discord channel: #${channelName}`);
    }
  }

  // Cache and cleanup
  writeFileSync(CACHE_FILE, JSON.stringify(channelMap, null, 2));
  await client.destroy();
  return channelMap;
}

// --- Outbound: Send agent message to its channel ---
export async function sendAgentMessage(
  config: DiscordConfig,
  channelMap: ChannelMap,
  agentName: string,
  jobName: string,
  text: string,
  client?: Client
): Promise<string | null> {
  const channelId = channelMap[agentName];
  if (!channelId) {
    console.error(`No Discord channel for agent: ${agentName}`);
    return null;
  }

  // If no client provided, do a one-shot REST call
  if (!client) {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
    const prefix = `**${agentName}** — _${jobName}_\n\n`;
    const fullText = prefix + text;
    const chunks: string[] = [];
    for (let i = 0; i < fullText.length; i += 2000) {
      chunks.push(fullText.slice(i, i + 2000));
    }

    let firstId: string | null = null;
    for (const chunk of chunks) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bot ${config.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: chunk }),
      });
      if (res.ok && !firstId) {
        const data = await res.json();
        firstId = data.id;
      }
    }
    return firstId;
  }

  // Use the live client
  const channel = (await client.channels.fetch(channelId)) as TextChannel;
  if (!channel) return null;

  const prefix = `**${agentName}** — _${jobName}_\n\n`;
  const fullText = prefix + text;
  const chunks: string[] = [];
  for (let i = 0; i < fullText.length; i += 2000) {
    chunks.push(fullText.slice(i, i + 2000));
  }

  let firstId: string | null = null;
  for (const chunk of chunks) {
    const msg = await channel.send(chunk);
    if (!firstId) firstId = msg.id;
  }
  return firstId;
}

// --- Inbound: Listen for messages and route to agents ---
export async function startDiscordListener(
  config: DiscordConfig,
  agents: AgentInfo[],
  onResponse?: (agentName: string, response: string) => void
) {
  const channelMap = await getOrCreateChannels(config, agents);
  const reverseMap = new Map(
    Object.entries(channelMap).map(([agent, channelId]) => [channelId, agent])
  );
  const agentMap = new Map(agents.map((a) => [a.name, a]));

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once("ready", () => {
    console.log(`🎮 Discord connected as ${client.user?.tag}`);
    console.log(
      `   Channels: ${Object.entries(channelMap)
        .map(([a]) => `#${a}`)
        .join(", ")}`
    );
  });

  client.on("messageCreate", async (message) => {
    // Ignore bots
    if (message.author.bot) return;

    // Check allowed users
    if (
      config.allowedUserIds?.length &&
      !config.allowedUserIds.includes(message.author.id)
    ) {
      return;
    }

    // Check if message is in an agent channel
    const agentName = reverseMap.get(message.channelId);
    if (!agentName) return;

    const agent = agentMap.get(agentName);
    if (!agent) return;

    console.log(
      `💬 [${new Date().toLocaleTimeString()}] Discord #${agentName} ← "${message.content.slice(0, 80)}"`
    );

    // Show typing
    const channel = message.channel as TextChannel;
    await channel.sendTyping();

    // Run Claude in the agent's workdir with --continue
    const workdir = expandPath(agent.workdir);
    const args = ["-p", message.content, "--continue"];
    if (agent.allowedTools) {
      args.push("--allowedTools", agent.allowedTools);
    }

    try {
      const cmd = `cd '${workdir}' && claude ${args
        .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
        .join(" ")}`;

      const output = execSync(cmd, {
        encoding: "utf-8",
        timeout: (agent.timeout || 120) * 1000,
      }).trim();

      const response = output || "(empty response)";

      // Send response in chunks
      const chunks: string[] = [];
      for (let i = 0; i < response.length; i += 2000) {
        chunks.push(response.slice(i, i + 2000));
      }
      for (const chunk of chunks) {
        await channel.send(chunk);
      }

      if (onResponse) onResponse(agentName, response);
    } catch (err: any) {
      await channel.send(`⚠️ Error: ${err.message?.slice(0, 500)}`);
    }
  });

  // Auto-reconnect is built into discord.js
  await client.login(config.botToken);
}
