#!/usr/bin/env bun
/**
 * Integration harness: acts as Claude Code would over `--channels`.
 * Spawns the bridge via stdio, then verifies tools/list + inbox forwarding.
 * (Network round-trip needs a paired daemon; status will err if none is running.)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, renameSync, mkdirSync } from "fs";
import { join } from "path";

const STATE = process.env.MAX_STATE_DIR || "/tmp/max-bridge-test";
const INBOX = join(STATE, "inbox");
mkdirSync(INBOX, { recursive: true });

const got: any[] = [];
const client = new Client({ name: "test-harness", version: "0.0.1" }, { capabilities: {} });
client.fallbackNotificationHandler = async (n: any) => {
  if (n.method === "notifications/claude/channel") { got.push(n.params); console.log("  CHANNEL NOTIF:", JSON.stringify(n.params)); }
};

const transport = new StdioClientTransport({
  command: process.env.BUN_BIN || "bun",
  args: [join(import.meta.dir, "server.ts")],
  env: { ...process.env, MAX_STATE_DIR: STATE },
  stderr: "inherit",
});
await client.connect(transport);
console.log("connected to bridge");

const tools = await client.listTools();
const names = tools.tools.map((t: any) => t.name);
const want = ["reply", "send_action", "download_attachment", "status", "ask", "edit_message", "delete_message"];
console.log("1) TOOLS:", names.join(", "), want.every(w => names.includes(w)) && names.length === want.length ? "[OK 7]" : `[expected 7, got ${names.length}]`);

const msg = { chat_id: "777", message_id: "9991", user: "@owner", user_id: "111", ts: new Date().toISOString(), text: "synthetic channel test", callback_data: "approve" };
const tmp = join(INBOX, ".syn.tmp"); writeFileSync(tmp, JSON.stringify(msg)); renameSync(tmp, join(INBOX, `${Date.now()}-9991.json`));
for (let i = 0; i < 40 && got.length === 0; i++) await new Promise(r => setTimeout(r, 100));
const ok2 = got.length && got[0].meta.is_callback === true && got[0].meta.callback_data === "approve" && got[0].content === "synthetic channel test";
console.log("2) CHANNEL FORWARD + callback meta:", ok2 ? "[OK]" : "[FAIL]", JSON.stringify(got[0]?.meta ?? null));

await client.close();
process.exit(0);
