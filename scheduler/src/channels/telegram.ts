/**
 * Telegram channel — raw Bot API, no frameworks.
 *
 * Outbound: Agent results → Telegram messages (tagged with agent name)
 * Inbound:  Reply to an agent's message → routed to that agent's session
 *
 * How routing works:
 * - Every outbound message is tracked: message_id → agent_name
 * - When you reply to a message, we look up which agent sent it
 * - Your reply is piped to that agent's `claude --continue` in its workdir
 * - The response is sent back as a new message (tagged with agent name)
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

// --- Types ---
export interface TelegramConfig {
  botToken: string;
  userId: string;
  enabled?: boolean;
}

interface MessageMap {
  [messageId: string]: {
    agent: string;
    timestamp: string;
  };
}

// --- State ---
const ROOT = resolve(import.meta.dir, "../..");
const MAP_FILE = join(ROOT, ".telegram-messages.json");
let messageMap: MessageMap = {};

function loadMessageMap() {
  try {
    messageMap = JSON.parse(readFileSync(MAP_FILE, "utf-8"));
  } catch {
    messageMap = {};
  }
}

function saveMessageMap() {
  // Keep only last 500 messages to prevent bloat
  const entries = Object.entries(messageMap);
  if (entries.length > 500) {
    const sorted = entries.sort(
      (a, b) => new Date(b[1].timestamp).getTime() - new Date(a[1].timestamp).getTime()
    );
    messageMap = Object.fromEntries(sorted.slice(0, 500));
  }
  writeFileSync(MAP_FILE, JSON.stringify(messageMap, null, 2));
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

// --- Telegram API helpers ---
async function apiCall(config: TelegramConfig, method: string, body: any): Promise<any> {
  const url = `https://api.telegram.org/bot${config.botToken}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// --- Outbound: Send agent message to Telegram ---
export async function sendAgentMessage(
  config: TelegramConfig,
  agentName: string,
  jobName: string,
  text: string
): Promise<string | null> {
  const prefix = `🤖 *${agentName}* — _${jobName}_\n\n`;
  const fullText = (prefix + text).slice(0, 4096);

  const result = await apiCall(config, "sendMessage", {
    chat_id: config.userId,
    text: fullText,
    parse_mode: "Markdown",
  });

  if (result.ok) {
    const msgId = String(result.result.message_id);
    messageMap[msgId] = {
      agent: agentName,
      timestamp: new Date().toISOString(),
    };
    saveMessageMap();
    return msgId;
  }

  console.error("Telegram send error:", result);
  return null;
}

// --- Outbound: Send typing indicator ---
export async function sendTyping(config: TelegramConfig) {
  await apiCall(config, "sendChatAction", {
    chat_id: config.userId,
    action: "typing",
  });
}

// --- Inbound: Poll for messages and route to agents ---
export interface AgentInfo {
  name: string;
  workdir: string;
  allowedTools?: string;
  timeout?: number;
}

export async function startTelegramListener(
  config: TelegramConfig,
  agents: AgentInfo[],
  onResponse?: (agentName: string, response: string) => void
) {
  loadMessageMap();

  const agentMap = new Map(agents.map((a) => [a.name, a]));
  let offset = 0;

  console.log(`📱 Telegram listener started (user ${config.userId})`);

  while (true) {
    try {
      const result = await apiCall(config, "getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"],
      });

      if (!result.ok || !result.result?.length) continue;

      for (const update of result.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;
        if (String(msg.from?.id) !== config.userId) continue;

        // Check if this is a reply to an agent's message
        const replyTo = msg.reply_to_message?.message_id;
        let targetAgent: AgentInfo | undefined;

        if (replyTo) {
          const mapped = messageMap[String(replyTo)];
          if (mapped) {
            targetAgent = agentMap.get(mapped.agent);
          }
        }

        // If not a reply, check for @agent prefix: "@researcher what's new?"
        if (!targetAgent) {
          const match = msg.text.match(/^@(\w+)\s+(.+)/s);
          if (match) {
            targetAgent = agentMap.get(match[1]);
            if (targetAgent) {
              msg.text = match[2]; // Strip the @agent prefix
            }
          }
        }

        if (!targetAgent) {
          // Unknown target — list available agents
          const agentNames = agents.map((a) => `@${a.name}`).join(", ");
          await apiCall(config, "sendMessage", {
            chat_id: config.userId,
            text: `Reply to an agent's message, or use @agent prefix:\n${agentNames}`,
            reply_to_message_id: msg.message_id,
          });
          continue;
        }

        console.log(
          `💬 [${new Date().toLocaleTimeString()}] ${targetAgent.name} ← "${msg.text.slice(0, 80)}"`
        );

        // Show typing
        await sendTyping(config);

        // Run Claude in the agent's workdir with --continue
        const workdir = expandPath(targetAgent.workdir);
        const args = ["-p", msg.text, "--continue"];
        if (targetAgent.allowedTools) {
          args.push("--allowedTools", targetAgent.allowedTools);
        }

        try {
          const cmd = `cd '${workdir}' && claude ${args
            .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
            .join(" ")}`;

          const output = execSync(cmd, {
            encoding: "utf-8",
            timeout: (targetAgent.timeout || 120) * 1000,
          }).trim();

          const response = output || "(empty response)";

          // Send response and track the message
          await sendAgentMessage(config, targetAgent.name, "reply", response);

          if (onResponse) onResponse(targetAgent.name, response);
        } catch (err: any) {
          await apiCall(config, "sendMessage", {
            chat_id: config.userId,
            text: `⚠️ *${targetAgent.name}* error: ${err.message?.slice(0, 200)}`,
            parse_mode: "Markdown",
          });
        }
      }
    } catch (err) {
      console.error("Telegram poll error:", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
