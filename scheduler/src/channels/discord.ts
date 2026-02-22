/**
 * Discord channel — each agent gets its own channel in your server.
 *
 * Setup:
 * 1. Create a Discord bot + add to your server
 * 2. Create channels: #researcher, #developer, #content, #ops (matching agent names)
 *    OR let the bot auto-create them under a category
 * 3. Messages in #researcher → routed to the researcher agent
 * 4. Agent output → posted in the agent's channel
 *
 * Uses Discord Gateway (WebSocket) for real-time message listening.
 * No discord.js — raw WebSocket + REST API to keep it lean.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

// --- Types ---
export interface DiscordConfig {
  botToken: string;
  guildId: string;
  categoryName?: string; // Auto-create channels under this category
  allowedUserIds?: string[]; // Only respond to these users
  enabled?: boolean;
}

interface ChannelMap {
  [agentName: string]: string; // agent name → channel ID
}

export interface AgentInfo {
  name: string;
  workdir: string;
  description?: string;
  allowedTools?: string;
  timeout?: number;
}

// --- Discord REST API ---
const API_BASE = "https://discord.com/api/v10";

async function discordApi(
  config: DiscordConfig,
  method: string,
  path: string,
  body?: any
): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

// --- Channel management ---
export async function getOrCreateChannels(
  config: DiscordConfig,
  agents: AgentInfo[]
): Promise<ChannelMap> {
  const ROOT = resolve(import.meta.dir, "../..");
  const CACHE_FILE = join(ROOT, ".discord-channels.json");

  // Try cache first
  try {
    const cached: ChannelMap = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    const allPresent = agents.every((a) => cached[a.name]);
    if (allPresent) return cached;
  } catch {}

  // Get existing channels
  const channels: any[] = await discordApi(
    config,
    "GET",
    `/guilds/${config.guildId}/channels`
  );

  const channelMap: ChannelMap = {};

  // Find or create category
  let categoryId: string | undefined;
  if (config.categoryName) {
    const existing = channels.find(
      (c) => c.type === 4 && c.name.toLowerCase() === config.categoryName!.toLowerCase()
    );
    if (existing) {
      categoryId = existing.id;
    } else {
      const created = await discordApi(
        config,
        "POST",
        `/guilds/${config.guildId}/channels`,
        {
          name: config.categoryName,
          type: 4, // GUILD_CATEGORY
        }
      );
      categoryId = created.id;
      console.log(`📁 Created Discord category: ${config.categoryName}`);
    }
  }

  // Find or create agent channels
  for (const agent of agents) {
    const channelName = agent.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const existing = channels.find(
      (c) =>
        c.type === 0 &&
        c.name === channelName &&
        (!categoryId || c.parent_id === categoryId)
    );

    if (existing) {
      channelMap[agent.name] = existing.id;
    } else {
      const created = await discordApi(
        config,
        "POST",
        `/guilds/${config.guildId}/channels`,
        {
          name: channelName,
          type: 0, // GUILD_TEXT
          parent_id: categoryId,
          topic: agent.description || `OCALT agent: ${agent.name}`,
        }
      );
      channelMap[agent.name] = created.id;
      console.log(`#️⃣  Created Discord channel: #${channelName}`);
    }
  }

  // Cache
  writeFileSync(CACHE_FILE, JSON.stringify(channelMap, null, 2));
  return channelMap;
}

// --- Outbound: Send agent message to its Discord channel ---
export async function sendAgentMessage(
  config: DiscordConfig,
  channelMap: ChannelMap,
  agentName: string,
  jobName: string,
  text: string
): Promise<string | null> {
  const channelId = channelMap[agentName];
  if (!channelId) {
    console.error(`No Discord channel for agent: ${agentName}`);
    return null;
  }

  // Discord message limit is 2000 chars
  const chunks: string[] = [];
  const prefix = `**${agentName}** — _${jobName}_\n\n`;
  const fullText = prefix + text;

  for (let i = 0; i < fullText.length; i += 2000) {
    chunks.push(fullText.slice(i, i + 2000));
  }

  let firstMsgId: string | null = null;
  for (const chunk of chunks) {
    const result = await discordApi(
      config,
      "POST",
      `/channels/${channelId}/messages`,
      { content: chunk }
    );
    if (!firstMsgId) firstMsgId = result.id;
  }

  return firstMsgId;
}

// --- Outbound: Send typing indicator ---
export async function sendTyping(config: DiscordConfig, channelId: string) {
  await discordApi(config, "POST", `/channels/${channelId}/typing`);
}

// --- Inbound: Listen via Discord Gateway WebSocket ---
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

  // Get Gateway URL
  const gateway = await discordApi(config, "GET", "/gateway/bot");
  const wsUrl = `${gateway.url}?v=10&encoding=json`;

  console.log(`🎮 Discord listener starting...`);
  console.log(`   Channels: ${Object.entries(channelMap).map(([a, c]) => `#${a}=${c}`).join(", ")}`);

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let lastSequence: number | null = null;
  let sessionId: string | null = null;

  function connect() {
    const ws = new WebSocket(wsUrl);

    ws.onmessage = async (event) => {
      const data = JSON.parse(String(event.data));

      if (data.s) lastSequence = data.s;

      switch (data.op) {
        case 10: // Hello
          // Start heartbeating
          const interval = data.d.heartbeat_interval;
          heartbeatInterval = setInterval(() => {
            ws.send(JSON.stringify({ op: 1, d: lastSequence }));
          }, interval);

          // Identify
          ws.send(
            JSON.stringify({
              op: 2,
              d: {
                token: config.botToken,
                intents: 1 << 9 | 1 << 15, // GUILD_MESSAGES + MESSAGE_CONTENT
                properties: {
                  os: "linux",
                  browser: "ocalt",
                  device: "ocalt",
                },
              },
            })
          );
          break;

        case 0: // Dispatch
          if (data.t === "READY") {
            sessionId = data.d.session_id;
            console.log(`🎮 Discord connected as ${data.d.user.username}`);
          }

          if (data.t === "MESSAGE_CREATE") {
            const msg = data.d;

            // Ignore bot messages
            if (msg.author.bot) break;

            // Check if user is allowed
            if (
              config.allowedUserIds?.length &&
              !config.allowedUserIds.includes(msg.author.id)
            ) {
              break;
            }

            // Check if message is in an agent channel
            const agentName = reverseMap.get(msg.channel_id);
            if (!agentName) break;

            const agent = agentMap.get(agentName);
            if (!agent) break;

            console.log(
              `💬 [${new Date().toLocaleTimeString()}] Discord #${agentName} ← "${msg.content.slice(0, 80)}"`
            );

            // Show typing
            await sendTyping(config, msg.channel_id);

            // Run Claude in the agent's workdir
            const workdir = expandPath(agent.workdir);
            const args = ["-p", msg.content, "--continue"];
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

              // Send response in chunks (2000 char limit)
              const chunks: string[] = [];
              for (let i = 0; i < response.length; i += 2000) {
                chunks.push(response.slice(i, i + 2000));
              }
              for (const chunk of chunks) {
                await discordApi(
                  config,
                  "POST",
                  `/channels/${msg.channel_id}/messages`,
                  { content: chunk }
                );
              }

              if (onResponse) onResponse(agentName, response);
            } catch (err: any) {
              await discordApi(
                config,
                "POST",
                `/channels/${msg.channel_id}/messages`,
                {
                  content: `⚠️ Error: ${err.message?.slice(0, 500)}`,
                }
              );
            }
          }
          break;

        case 7: // Reconnect
          ws.close();
          break;

        case 9: // Invalid session
          ws.close();
          break;

        case 11: // Heartbeat ACK
          break;
      }
    };

    ws.onclose = () => {
      console.log("🎮 Discord disconnected, reconnecting in 5s...");
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      setTimeout(connect, 5000);
    };

    ws.onerror = (err) => {
      console.error("Discord WS error:", err);
    };
  }

  connect();
}
