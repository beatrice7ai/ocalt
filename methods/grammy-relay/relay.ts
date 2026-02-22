import { Bot } from "grammy";
import { spawn } from "child_process";

// --- Config ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER = Number(process.env.TELEGRAM_USER_ID);

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
if (!ALLOWED_USER) throw new Error("TELEGRAM_USER_ID not set");

const bot = new Bot(BOT_TOKEN);

// --- Claude Code CLI runner ---
async function runClaude(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", ["-p", input], {
      env: { ...process.env },
      timeout: 120_000, // 2 min max
    });

    let output = "";
    let stderr = "";

    proc.stdout.on("data", (data) => (output += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));

    proc.on("close", (code) => {
      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else if (code === 0) {
        resolve("(Claude returned empty response)");
      } else {
        console.error(`claude stderr: ${stderr}`);
        reject(new Error(`claude exited with code ${code}`));
      }
    });

    proc.on("error", (err) => reject(err));
  });
}

// --- Message handler ---
bot.on("message:text", async (ctx) => {
  // Only respond to allowed user
  if (ctx.from?.id !== ALLOWED_USER) {
    console.log(`Ignored message from user ${ctx.from?.id}`);
    return;
  }

  const message = ctx.message.text;
  console.log(`[${new Date().toISOString()}] Received: ${message.slice(0, 100)}`);

  try {
    // Show typing indicator
    await ctx.replyWithChatAction("typing");

    const response = await runClaude(message);

    // Telegram has a 4096 char limit per message
    if (response.length > 4096) {
      const chunks = response.match(/[\s\S]{1,4096}/g) || [];
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } else {
      await ctx.reply(response);
    }
  } catch (err) {
    console.error("Error:", err);
    await ctx.reply("⚠️ Claude encountered an error. Check logs.");
  }
});

// --- Start ---
bot.start();
console.log(`✅ grammY relay running. Listening for user ${ALLOWED_USER}`);
