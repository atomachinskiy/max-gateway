#!/usr/bin/env bun
/**
 * max-gateway — standalone, supervised MAX (мессенджер от VK) transport for Claude Code.
 * Owns the MAX Bot API connection (robust long-poll on GET /updates by marker-cursor).
 * Writes incoming to the inbox, sends outgoing from the outbox. No Claude Code coupling.
 *
 * Why a separate daemon (vs. an in-process MCP like the official mcp-max-messenger):
 * the official MAX poll loop EXITS on any FetchError/429/5xx — one network blip kills
 * the channel. Here the loop never gives up (graduated backoff), a watchdog restarts a
 * wedged poller, a PID-lock guarantees one consumer, and systemd Restart=always covers
 * a crash. Same un-killable transport we built for Telegram (tg-gateway), ported to MAX.
 */
import { homedir } from "os";
import { join, basename } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, renameSync, statSync } from "fs";
import { spawnSync } from "child_process"; // node builtin — works on both bun and node runtimes

const STATE_DIR = process.env.MAX_STATE_DIR ?? join(homedir(), ".claude", "channels", "max-claude5");
const INBOX = join(STATE_DIR, "inbox");
const OUTBOX = join(STATE_DIR, "outbox");
const OUTBOX_RES = join(OUTBOX, "res");
const MARKER_FILE = join(STATE_DIR, "gateway.marker");
const STATUS_FILE = join(STATE_DIR, "gateway.status.json");
const LOCK_FILE = join(STATE_DIR, "gateway.lock");
const CONFIG_ENV_FILE = process.env.MAX_GATEWAY_ENV ?? join(STATE_DIR, "gateway.env");
// Client deployments keep config in a single `gateway.env` (written by `pair`),
// so the supervisor needn't carry a pile of env vars. Load it FIRST — before any
// const below reads process.env — but never override vars already set (prod sets
// them via systemd, so prod behaviour is unchanged).
(function loadEnvFile() {
  try {
    if (!existsSync(CONFIG_ENV_FILE)) return;
    for (const line of readFileSync(CONFIG_ENV_FILE, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
})();
const VERSION = "1.0.0";
const STALE_MS = 180_000; // no successful poll in 3 min => wedged; exit so the supervisor restarts fresh
// /sys + /menu control commands: who may run them, where the session lives, how to restart it.
// In MAX a user has a stable user_id; admins are gated by user_id (not the per-dialog chat_id).
const SYS_ADMINS = new Set((process.env.MAX_SYS_ADMINS ?? "").split(",").map(s => s.trim()).filter(Boolean));
// Chat allowlist: only these chats reach the session. Default = the admins (their dialogs).
// MAX_ALLOWED_CHATS="id1,id2" extends it; "*" opens the bot to everyone.
const ALLOWED_CHATS = new Set([
  ...(process.env.MAX_ALLOWED_CHATS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  ...SYS_ADMINS,
]);
function isAllowedChat(chatId: string, userId: string): boolean {
  return ALLOWED_CHATS.has("*") || ALLOWED_CHATS.has(chatId) || SYS_ADMINS.has(userId);
}
const TMUX_SESSION = process.env.CLAUDE5_TMUX ?? "claude5";
const SYS_RESTART_CMD = process.env.SYS_RESTART_CMD ?? ""; // path to restart script; empty = restart disabled (safe default)
const BRIDGE_HEARTBEAT = join(STATE_DIR, "bridge.heartbeat");
// MAX bots have NO emoji reactions (unlike Telegram). The transport-level "I saw it,
// I'm working" acknowledgement is the chat ACTION API: mark_seen + a kept-alive
// typing_on indicator until we reply.
const TYPING_MAX_MS = 8 * 60_000; // refresh "typing…" at most 8 min per chat, then give up
const typingChats = new Map<string, number>(); // chat_id -> ms work started; drives the typing indicator
const LOG = (m: string) => process.stderr.write(`[max-gateway ${new Date().toISOString()}] ${m}\n`);

for (const d of [STATE_DIR, INBOX, OUTBOX, OUTBOX_RES]) mkdirSync(d, { recursive: true });

// ---------- single-instance lock (MAX allows one long-poll consumer per token) ----------
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = Number(readFileSync(LOCK_FILE, "utf8").trim());
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); LOG(`FATAL: another max-gateway already running (pid ${pid}). exiting.`); process.exit(1); }
        catch { LOG(`stale lock from dead pid ${pid}, taking over`); }
      }
    }
  } catch {}
  try { writeFileSync(LOCK_FILE, String(process.pid)); } catch {}
}
function releaseLock() {
  try { if (existsSync(LOCK_FILE) && Number(readFileSync(LOCK_FILE, "utf8").trim()) === process.pid) unlinkSync(LOCK_FILE); } catch {}
}

// ---------- status / heartbeat (observability + watchdog input) ----------
const status: any = {
  pid: process.pid, version: VERSION, started: new Date().toISOString(),
  lastPollOk: null, lastInbound: null, lastError: null, updatesSeen: 0, marker: null,
};
function writeStatus() {
  try { const t = STATUS_FILE + ".tmp"; writeFileSync(t, JSON.stringify(status, null, 2)); renameSync(t, STATUS_FILE); } catch {}
}

function loadToken(): string {
  if (process.env.MAX_BOT_TOKEN) return process.env.MAX_BOT_TOKEN.trim();
  const f = join(homedir(), ".claude", "secrets", "max-bot-token");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  LOG("FATAL: no MAX_BOT_TOKEN and no secrets/max-bot-token"); process.exit(1);
}
const TOKEN = loadToken();
// platform-api2.max.ru is unreachable from data-center IPs (returns 000 from AWS);
// botapi.max.ru is the live, reachable host (clean 401 without auth). Override via MAX_API_BASE.
const BASE = (process.env.MAX_API_BASE ?? "https://botapi.max.ru").replace(/\/+$/, "");
// Updates we ask MAX to deliver (skip the chatty membership churn we don't act on).
const UPDATE_TYPES = "message_created,message_callback,bot_started,message_edited";

class MaxError extends Error { constructor(public status: number, public code: string, msg: string) { super(msg); } }

type CallOpts = { query?: Record<string, any>; body?: any };
async function call(method: string, path: string, opts: CallOpts = {}, timeoutMs = 65000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = new URL(BASE + (path.startsWith("/") ? path : "/" + path));
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Authorization: TOKEN };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(url.href, {
      method, headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    const j: any = await r.json().catch(() => ({}));
    if (r.status !== 200) throw new MaxError(r.status, j?.code ?? "", j?.message || `${method} ${path} http ${r.status}`);
    return j;
  } finally { clearTimeout(t); }
}

// ---------- inbox ----------
function writeInbox(name: string, obj: any) {
  const tmp = join(INBOX, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, join(INBOX, name));
}
// Incoming MAX attachments expose a direct payload.url — just GET it.
async function downloadUrl(fileUrl: string, suggestExt?: string): Promise<string> {
  const ext = suggestExt ?? (fileUrl.split("?")[0].includes(".") ? fileUrl.split("?")[0].split(".").pop() : "bin");
  const dest = join(INBOX, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  const resp = await fetch(fileUrl);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(dest, buf);
  return dest;
}

// Voice/audio STT in the transport: transcribe via Groq Whisper so the transcript
// arrives INSIDE the channel message (~10-20s faster replies). The original stays
// downloadable via attachment_file_id (the payload url).
const GROQ_TOKEN_FILE = join(homedir(), ".claude", "secrets", "groq-token");
async function transcribeAudio(fileUrl: string): Promise<string | null> {
  try {
    if (!existsSync(GROQ_TOKEN_FILE)) return null;
    const token = readFileSync(GROQ_TOKEN_FILE, "utf8").trim();
    const path = await downloadUrl(fileUrl, "ogg"); // Groq rejects .oga — save as .ogg
    const fd = new FormData();
    fd.append("model", "whisper-large-v3-turbo");
    fd.append("language", "ru");
    fd.append("file", new Blob([readFileSync(path)], { type: "audio/ogg" }), "voice.ogg");
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST", headers: { authorization: `Bearer ${token}` }, body: fd, signal: ctrl.signal,
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) { LOG(`groq stt http ${r.status}: ${JSON.stringify(j).slice(0, 200)}`); return null; }
      return (j.text ?? "").trim() || null;
    } finally { clearTimeout(t); }
  } catch (e: any) { LOG(`audio stt: ${e.message}`); return null; }
}

function userName(u: any): string { return u?.username ? `@${u.username}` : (u?.name ?? "user"); }

// Visible text of the inline button whose callback payload matches `data`.
function buttonLabel(msg: any, data: string): string | null {
  const atts = msg?.body?.attachments;
  if (!Array.isArray(atts)) return null;
  for (const a of atts) {
    if (a?.type !== "inline_keyboard") continue;
    for (const row of a.payload?.buttons ?? []) for (const b of row) if (b?.payload === data) { const t = String(b.text ?? "").trim(); return t || null; }
  }
  return null;
}

// A user tapped an inline button (update_type=message_callback). Toast it, drop the
// keyboard so it can't be re-tapped, and forward the press to the session.
async function handleCallback(u: any) {
  const cb = u.callback ?? {};
  const data = cb.payload ?? "";
  const from = cb.user ?? {};
  const msg = u.message ?? {};
  const chatId = String(msg?.recipient?.chat_id ?? "");
  const messageId = msg?.body?.mid;
  // A tap that answers a pending `ask` resolves the held tool result; not forwarded.
  const askMatch = /^ask:([^:]+):(\d+)$/.exec(data);
  if (askMatch && pendingAsks.has(askMatch[1])) {
    const p = pendingAsks.get(askMatch[1]);
    const lbl = p?.options[Number(askMatch[2])] ?? "✓";
    try { await call("POST", "/answers", { query: { callback_id: cb.callback_id }, body: { notification: `✓ ${lbl}`.slice(0, 190) } }); } catch {}
    resolveAsk(askMatch[1], Number(askMatch[2]), "answered");
    return;
  }
  // Control-panel taps are handled by the daemon (auth-gated by user_id), not forwarded.
  if (data.startsWith("sys:")) {
    try { await call("POST", "/answers", { query: { callback_id: cb.callback_id }, body: {} }); } catch {}
    if (!SYS_ADMINS.has(String(from.user_id ?? ""))) return;
    LOG(`sys tap "${data}"`);
    const rest = data.slice(4);
    if (rest === "status") return void sysStatus(chatId);
    if (rest === "logs") return void sysLogs(chatId);
    if (rest === "screen") return void sysScreen(chatId);
    if (rest === "restart") return void sysRestartPrompt(chatId);
    if (rest === "restart:yes") return void doRestart(chatId, messageId);
    if (rest === "restart:no") { if (messageId) editText(chatId, messageId, "Отменено.").catch(() => {}); return; }
    if (rest.startsWith("cc:")) return void sysSendKeys(chatId, rest.slice(3));
    if (rest === "models") return void sysModels(chatId);
    if (rest === "mcp") return void sysMcp(chatId);
    if (rest.startsWith("model:")) return void sysSetModel(chatId, rest.slice(6), messageId);
    if (rest.startsWith("tui:")) return void sysTuiKey(chatId, rest.slice(4), messageId);
    return;
  }
  if (!isAllowedChat(chatId, String(from.user_id ?? ""))) {
    try { await call("POST", "/answers", { query: { callback_id: cb.callback_id }, body: {} }); } catch {}
    LOG(`DROP callback from non-allowed ${from.user_id}`); return;
  }
  // Surface the tap to the session as fresh user text (the button's label), the same
  // pattern that worked on Telegram. Toast + strip the keyboard so the choice is
  // visibly consumed and can't be tapped twice.
  const label = buttonLabel(msg, data) || data;
  try { await call("POST", "/answers", { query: { callback_id: cb.callback_id }, body: { notification: `✓ ${label}`.slice(0, 190) } }); } catch (e: any) { LOG(`answer cb: ${e.message}`); }
  if (messageId != null) { try { await editText(chatId, messageId, msg?.body?.text ?? label, undefined, []); } catch {} }
  const base: any = {
    chat_id: chatId,
    message_id: String(Date.now()),
    user: userName(from),
    user_id: String(from.user_id ?? ""),
    ts: new Date().toISOString(),
    text: label,
    callback_data: data,
  };
  writeInbox(`${Date.now()}-cbm-${cb.callback_id ?? Math.random().toString(36).slice(2)}.json`, base);
  LOG(`inbox <- button-tap chat ${chatId} data="${data}" label="${label}"`);
}

// Bot opened / `/start` pressed (update_type=bot_started). Inject as a normal inbound.
async function handleBotStarted(u: any) {
  const chatId = String(u.chat_id ?? "");
  const from = u.user ?? {};
  const userId = String(from.user_id ?? "");
  if (!isAllowedChat(chatId, userId)) { LOG(`DROP bot_started non-allowed chat ${chatId} user ${userId}`); return; }
  const base: any = {
    chat_id: chatId, message_id: String(Date.now()), user: userName(from), user_id: userId,
    ts: new Date().toISOString(), text: (u.payload ? String(u.payload) : "/start"),
  };
  writeInbox(`${Date.now()}-start.json`, base);
  LOG(`inbox <- bot_started chat ${chatId} user ${userId}`);
}

async function handleMessage(u: any) {
  const m = u.message;
  if (!m) return;
  const sender = m.sender ?? {};
  const rec = m.recipient ?? {};
  const chatId = rec.chat_id != null ? String(rec.chat_id) : "";
  const userId = String(sender.user_id ?? "");
  // Allowlist gate: unknown chats never reach the session (SILENT drop — a prober
  // can't even confirm the bot is alive). MAX has no server-side dialog allowlist.
  if (!isAllowedChat(chatId, userId)) {
    LOG(`DROP non-allowed chat ${chatId} user ${userId} (${userName(sender)}): ${(m.body?.text ?? "[media]").slice(0, 80)}`);
    return;
  }
  const text0 = (m.body?.text ?? "").trim();
  // Control commands handled by the daemon directly (work even if the session is dead).
  if (/^\/(sys|menu|ping|status|restart|screen|logs|model|models|mcp)\b/i.test(text0)) {
    if (!SYS_ADMINS.has(userId)) { await sendReply({ chat_id: chatId, text: "⛔ Команды управления доступны только владельцу." }).catch(() => {}); return; }
    return void handleSysCommand(chatId, text0).catch((e: any) => LOG(`sys cmd error: ${e.message}`));
  }
  // Instant transport ack BEFORE media/STT: mark seen + start "typing…".
  sendAction(chatId, "mark_seen").catch(() => {});
  sendAction(chatId, "typing_on").catch(() => {});
  typingChats.set(chatId, Date.now());
  const base: any = {
    chat_id: chatId,
    message_id: String(m.body?.mid ?? Date.now()),
    user: userName(sender),
    user_id: userId,
    ts: new Date(m.timestamp ?? Date.now()).toISOString(),
  };
  if (m.link?.type === "reply" && m.link?.message?.mid) base.reply_to_mid = String(m.link.message.mid);
  const atts: any[] = Array.isArray(m.body?.attachments) ? m.body.attachments : [];
  const caption = m.body?.text ?? "";
  try {
    const img = atts.find(a => a.type === "image");
    const audio = atts.find(a => a.type === "audio");
    const video = atts.find(a => a.type === "video");
    const file = atts.find(a => a.type === "file");
    if (img?.payload?.url) {
      base.text = caption;
      base.image_path = await downloadUrl(img.payload.url, "jpg");
    } else if (audio?.payload?.url) {
      base.text = caption; base.attachment_file_id = audio.payload.url; base.attachment_kind = "audio";
      const stt = await transcribeAudio(audio.payload.url);
      if (stt) { base.text = `[голосовое, расшифровано в транспорте] ${stt}`; base.voice_transcribed = true; }
    } else if (video?.payload?.url) {
      base.text = caption; base.attachment_file_id = video.payload.url; base.attachment_kind = "video";
    } else if (file?.payload?.url) {
      base.text = caption; base.attachment_file_id = file.payload.url; base.attachment_kind = "file";
      base.attachment_name = file.filename; base.attachment_size = file.size;
    } else if (text0) {
      base.text = m.body.text;
    } else {
      base.text = caption || "[unsupported message type]";
    }
  } catch (e: any) { LOG(`media handling error: ${e.message}`); base.text = base.text ?? "[media download failed]"; }
  writeInbox(`${Date.now()}-${base.message_id}.json`, base);
  LOG(`inbox <- chat ${base.chat_id} msg ${base.message_id} ${base.image_path ? "[photo]" : base.attachment_kind ? `[${base.attachment_kind}]${base.voice_transcribed ? "+stt" : ""}` : ""}`);
}

async function handleUpdate(u: any) {
  switch (u.update_type) {
    case "message_callback": return handleCallback(u);
    case "bot_started": return handleBotStarted(u);
    case "message_created":
    case "message_edited": return handleMessage(u);
    default: return; // membership churn etc — ignored
  }
}

// ---------- chat actions (MAX's substitute for Telegram reactions) ----------
async function sendAction(chatId: string, action: string) {
  if (!chatId) return;
  try { await call("POST", `/chats/${chatId}/actions`, { body: { action } }, 8000); } catch {}
}

// ---------- outgoing ----------
function chunk(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = []; let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit); if (cut < limit * 0.6) cut = limit;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest); return out;
}
// Accept buttons as a single row [{text,data}] or rows [[{text,data}],[...]].
// {text,data}->callback button (optional intent positive|negative), {text,url}->link.
function normalizeButtons(buttons: any): any {
  if (!Array.isArray(buttons) || buttons.length === 0) return undefined;
  const rows = Array.isArray(buttons[0]) ? buttons : [buttons];
  const out = rows.map((row: any[]) => row.map((b: any) => {
    if (b.url) return { type: "link", text: String(b.text), url: String(b.url) };
    const btn: any = { type: "callback", text: String(b.text), payload: String(b.data ?? b.text).slice(0, 64) };
    if (b.intent === "positive" || b.intent === "negative" || b.intent === "default") btn.intent = b.intent;
    return btn;
  }));
  return { type: "inline_keyboard", payload: { buttons: out } };
}

// Upload a local file to MAX and return an attachment-request object, or null.
async function uploadMedia(path: string): Promise<any | null> {
  try {
    const name = basename(path);
    const type = /\.(jpe?g|png|webp|gif|bmp)$/i.test(name) ? "image"
      : /\.(mp4|mov|webm|mkv|avi)$/i.test(name) ? "video"
      : /\.(mp3|ogg|oga|wav|m4a|flac)$/i.test(name) ? "audio" : "file";
    const up = await call("POST", "/uploads", { query: { type } }); // { url, token? }
    const buf = readFileSync(path);
    const fd = new FormData();
    fd.append("data", new Blob([buf]), name);
    const r = await fetch(up.url, { method: "POST", body: fd });
    const resp: any = await r.json().catch(() => ({}));
    if (type === "image") {
      const photos = resp?.photos ?? (resp && typeof resp === "object" && !resp.token ? resp : null);
      if (photos && Object.keys(photos).length) return { type: "image", payload: { photos } };
    }
    const token = up.token ?? resp?.token;
    if (token) return { type, payload: { token } };
    LOG(`upload ${name}: no token (resp ${JSON.stringify(resp).slice(0, 160)})`);
    return null;
  } catch (e: any) { LOG(`upload failed ${path}: ${e.message}`); return null; }
}

// POST one message; retry on attachment.not.ready (media still processing) and
// fall back to plain (no format) if MAX rejects the markup.
async function sendOne(chat_id: string, body: any, tries = 0): Promise<string> {
  try {
    const r = await call("POST", "/messages", { query: { chat_id }, body });
    return String(r?.message?.body?.mid ?? "");
  } catch (e: any) {
    if (e instanceof MaxError && e.code === "attachment.not.ready" && tries < 6) { await sleep(1500); return sendOne(chat_id, body, tries + 1); }
    if (body.format && tries < 7) { const { format, ...plain } = body; return sendOne(chat_id, plain, tries + 1); }
    throw e;
  }
}

async function sendReply(args: any): Promise<any> {
  const { chat_id, text, format, reply_to, files, disable_notification } = args;
  typingChats.delete(String(chat_id)); // a reply is going out → stop the "typing…" loop
  const fmt = (format === "markdown" || format === "html") ? format : undefined;
  const kb = normalizeButtons(args.buttons);
  const link = reply_to ? { type: "reply", mid: String(reply_to) } : undefined;
  const ids: string[] = [];
  if (files && files.length) {
    const attachments: any[] = [];
    for (const p of files) { const a = await uploadMedia(p); if (a) attachments.push(a); }
    if (kb) attachments.push(kb);
    const body: any = { text: text ?? "", notify: !disable_notification };
    if (attachments.length) body.attachments = attachments;
    if (fmt) body.format = fmt;
    if (link) body.link = link;
    if (!attachments.length) LOG(`reply with files but all uploads failed; sending text only`);
    ids.push(await sendOne(String(chat_id), body));
    return { message_ids: ids };
  }
  const parts = chunk(text ?? "");
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const quiet = disable_notification || !last; // silence all but the last chunk → one ping
    const body: any = { text: parts[i], notify: !quiet };
    if (fmt) body.format = fmt;
    if (kb && last) body.attachments = [kb];
    if (link && i === 0) body.link = link;
    ids.push(await sendOne(String(chat_id), body));
  }
  return { message_ids: ids };
}

async function editText(chat_id: string, message_id: any, text: string, format?: string, buttons?: any): Promise<any> {
  const body: any = { text };
  if (format === "markdown" || format === "html") body.format = format;
  const kb = normalizeButtons(buttons);
  // buttons present → set; explicit [] → clear keyboard (drop after a tap); undefined → leave text-only
  if (kb) body.attachments = [kb];
  else if (Array.isArray(buttons)) body.attachments = [];
  try { return await call("PUT", "/messages", { query: { message_id: String(message_id) }, body }); }
  catch (e: any) {
    if (!body.format) throw e;
    const { format: _f, ...plain } = body; return call("PUT", "/messages", { query: { message_id: String(message_id) }, body: plain });
  }
}

async function execTool(tool: string, args: any): Promise<any> {
  switch (tool) {
    case "reply": return sendReply(args);
    case "send_action": { await sendAction(String(args.chat_id), String(args.action ?? "typing_on")); return { ok: true }; }
    case "edit_message": return editText(args.chat_id, args.message_id, args.text, args.format, args.buttons ?? (args.drop_buttons ? [] : undefined));
    case "delete_message": return call("DELETE", "/messages", { query: { message_id: String(args.message_id) } });
    case "download_attachment": return { path: await downloadUrl(String(args.file_id)) };
    case "status": return { ...status, now: new Date().toISOString() };
    default: throw new Error(`unknown tool ${tool}`);
  }
}

// ---------- interactive ask (AskUserQuestion rendered as buttons) ----------
const ASK_TIMEOUT_MS = 600_000; // 10 min for a human to tap
const pendingAsks = new Map<string, { chat_id: string; options: string[]; messageId: string; timer: any }>();

function writeRes(res: any) {
  const rt = join(OUTBOX_RES, `.${res.id}.tmp`);
  writeFileSync(rt, JSON.stringify(res)); renameSync(rt, join(OUTBOX_RES, `${res.id}.json`));
}

async function startAsk(reqId: string, args: any) {
  const chat_id = String(args.chat_id ?? "");
  const question = String(args.question ?? "");
  const options = (Array.isArray(args.options) ? args.options : []).map(String).slice(0, 20);
  if (!chat_id || options.length === 0) { writeRes({ id: reqId, ok: false, error: "ask needs chat_id and non-empty options" }); return; }
  const buttons = options.map((o, i) => [{ text: o, data: `ask:${reqId}:${i}` }]);
  const sent = await sendReply({ chat_id, text: question, format: args.format, buttons });
  const messageId = sent.message_ids[sent.message_ids.length - 1];
  const timer = setTimeout(() => resolveAsk(reqId, -1, "timeout"), ASK_TIMEOUT_MS);
  pendingAsks.set(reqId, { chat_id, options, messageId, timer });
  LOG(`ask ${reqId} sent (${options.length} options) msg ${messageId}`);
}

function resolveAsk(reqId: string, index: number, reason: string) {
  const p = pendingAsks.get(reqId);
  if (!p) return;
  clearTimeout(p.timer); pendingAsks.delete(reqId);
  if (index >= 0 && index < p.options.length) {
    writeRes({ id: reqId, ok: true, result: { choice: p.options[index], index } });
    editText(p.chat_id, p.messageId, `✅ ${p.options[index]}`, undefined, []).catch(() => {});
    LOG(`ask ${reqId} answered: ${p.options[index]}`);
  } else {
    writeRes({ id: reqId, ok: false, error: `no answer (${reason})` });
    editText(p.chat_id, p.messageId, `⌛ Без ответа`, undefined, []).catch(() => {});
    LOG(`ask ${reqId} unresolved: ${reason}`);
  }
}

// ---------- /sys + /menu control plane (works even when the session is dead) ----------
function sh(cmd: string[], timeoutMs = 6000): { ok: boolean; out: string } {
  try {
    const p = spawnSync(cmd[0], cmd.slice(1), { timeout: timeoutMs, encoding: "utf8", env: { ...process.env, TMUX: "" } });
    const out = ((p.stdout ?? "") + (p.stderr ?? "")).trim();
    return { ok: p.status === 0, out };
  } catch (e: any) { return { ok: false, out: e.message }; }
}
function uptimeStr(): string {
  const s = Math.round((Date.now() - new Date(status.started).getTime()) / 1000);
  return `${Math.floor(s / 3600)}ч ${Math.floor((s % 3600) / 60)}м`;
}
function sessionState(): { alive: boolean; detail: string } {
  try { const st = statSync(BRIDGE_HEARTBEAT); const age = Date.now() - st.mtimeMs; if (age < 60_000) return { alive: true, detail: `мост ${Math.round(age / 1000)}с назад` }; } catch {}
  const p = sh(["pgrep", "-af", "claude --channels"]);
  if (p.ok && p.out) return { alive: true, detail: "claude --channels запущен" };
  return { alive: false, detail: "нет heartbeat моста и процесса claude --channels" };
}
function lastPollAgo(): number { return status.lastPollOk ? Math.round((Date.now() - new Date(status.lastPollOk).getTime()) / 1000) : -1; }

function sysMenu(chat_id: string) {
  return sendReply({ chat_id, text: "🎛 Панель управления claude5 (MAX)", buttons: [
    [{ text: "📊 Статус", data: "sys:status" }, { text: "🔄 Рестарт", data: "sys:restart" }],
    [{ text: "📜 Логи", data: "sys:logs" }, { text: "🖥 Экран", data: "sys:screen" }],
    [{ text: "🗜 /compact", data: "sys:cc:/compact" }, { text: "🧹 /clear", data: "sys:cc:/clear" }],
    [{ text: "🧠 Модель", data: "sys:models" }, { text: "🔌 MCP", data: "sys:mcp" }],
  ] });
}
async function sysStatus(chat_id: string) {
  const s = sessionState();
  const proc = sh(["pgrep", "-af", "claude --channels"]);
  const pid = proc.ok && proc.out ? proc.out.split("\n")[0].split(/\s+/)[0] : "-";
  let mem = "-";
  if (pid !== "-") { const m = sh(["ps", "-o", "rss=", "-p", pid]); if (m.ok && m.out) mem = `${Math.round(Number(m.out.trim()) / 1024)}МБ`; }
  const lines = [
    `🎛 max-gateway v${VERSION}: 🟢 uptime ${uptimeStr()}`,
    `обновлений ${status.updatesSeen}, marker ${status.marker ?? "—"}, последний опрос ${lastPollAgo()}с назад`,
    `сессия: ${s.alive ? "🟢 онлайн" : "🔴 DOWN"} (${s.detail})`,
    `claude pid ${pid}, память ${mem}`,
    status.lastError ? `последняя ошибка: ${status.lastError}` : "ошибок нет",
  ];
  return sendReply({ chat_id, text: lines.join("\n") });
}
function sysLogs(chat_id: string) {
  const j = sh(["journalctl", "--user", "-u", "max-gateway.service", "-n", "20", "--no-pager"]);
  const body = j.ok && j.out ? j.out.slice(-3500) : `journalctl недоступен (тест-инстанс?). Последняя ошибка: ${status.lastError ?? "нет"}`;
  return sendReply({ chat_id, text: "📜 Лог max-gateway:\n\n" + body });
}
function sysScreen(chat_id: string) {
  const c = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  if (!c.ok) return sendReply({ chat_id, text: `🖥 Экран недоступен: ${c.out || "нет сессии " + TMUX_SESSION}` });
  const out = c.out.split("\n").filter(l => l.trim()).slice(-40).join("\n").slice(-3500);
  return sendReply({ chat_id, text: "🖥 Экран claude5:\n\n" + (out || "(пусто)") });
}
async function sysMcp(chat_id: string) {
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return sendReply({ chat_id, text: `🔴 Сессия ${TMUX_SESSION} не запущена — панель /mcp показывать негде.` });
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", "/mcp"]);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  await sleep(2000);
  const cap = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  const out = cap.ok ? cap.out.split("\n").filter(l => l.trim()).slice(-45).join("\n").slice(-3500) : "(экран недоступен)";
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"]);
  await sleep(250);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"]);
  return sendReply({ chat_id, text: `🔌 Панель /mcp в сессии:\n\n${out || "(пусто)"}` });
}
async function sysSendKeys(chat_id: string, keys: string) {
  keys = keys.trim();
  if (!keys) return sendReply({ chat_id, text: "Формат: /sys cc <команда>, напр. /sys cc /compact" });
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok) return sendReply({ chat_id, text: `🔴 Сессия ${TMUX_SESSION} не запущена - команду некуда слать.` });
  const r1 = sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", keys]);
  const r2 = sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  if (!r1.ok || !r2.ok) return sendReply({ chat_id, text: `send-keys ошибка: ${r1.out || r2.out}` });
  await sleep(1500);
  const cap = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  const out = cap.ok ? cap.out.split("\n").filter(l => l.trim()).slice(-30).join("\n").slice(-3000) : "(экран недоступен)";
  return sendReply({ chat_id, text: `⌨️ Отправил в claude5: ${keys}\n\n🖥 Экран:\n${out}` });
}
const MODELS: Array<{ label: string; id: string }> = [
  { label: "Opus 4.8 (1M)", id: "claude-opus-4-8[1m]" },
  { label: "Opus 4.8", id: "claude-opus-4-8" },
  { label: "Sonnet 4.6", id: "claude-sonnet-4-6" },
  { label: "Haiku 4.5", id: "claude-haiku-4-5-20251001" },
  { label: "Fable 5", id: "claude-fable-5" },
];
function sysModels(chat_id: string) {
  const buttons = MODELS.map((m, i) => [{ text: m.label, data: `sys:model:${i}` }]);
  return sendReply({ chat_id, text: "🧠 Выбери модель (переключение на лету, без рестарта):", buttons });
}
async function sysSetModel(chat_id: string, idx: string, messageId?: any) {
  const m = MODELS[Number(idx)];
  if (!m) return void sendReply({ chat_id, text: "Неизвестная модель." });
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok) return void sendReply({ chat_id, text: `🔴 Сессия ${TMUX_SESSION} не запущена — переключать некого.` });
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", `/model ${m.id}`]);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  await sleep(2500);
  let confirmed = false;
  if (/Switch model\?/i.test(paneTail())) { sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]); confirmed = true; await sleep(1200); }
  const txt = `🧠 Переключил на ${m.label}\n(${m.id})${confirmed ? "\n✅ диалог подтверждения нажал за тебя" : ""}`;
  if (messageId) editText(chat_id, messageId, txt).catch(() => sendReply({ chat_id, text: txt }));
  else sendReply({ chat_id, text: txt });
}
// ---------- TUI prompt relay: terminal dialogs -> MAX buttons ----------
const PROMPT_POLL_MS = 5000;
let promptFp = "", promptSeen = 0, alertedFp = "";
function paneTail(lines = 30): string {
  const c = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  return c.ok ? c.out.split("\n").filter(l => l.trim()).slice(-lines).join("\n") : "";
}
function detectPrompt(): { fp: string; block: string; nOpts: number } | null {
  const tail = paneTail();
  if (!/❯\s*\d+\./.test(tail)) return null;
  const lines = tail.split("\n");
  const opts: string[] = [];
  let firstOpt = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:│\s*)?❯?\s*(\d+)\.\s+(.+)$/.exec(lines[i]);
    if (m) { opts.push(`${m[1]}. ${m[2].trim()}`); if (firstOpt < 0) firstOpt = i; }
  }
  if (!opts.length) return null;
  const ctx = lines.slice(Math.max(0, firstOpt - 6), firstOpt).join("\n");
  const block = `${ctx}\n\n${opts.join("\n")}`.trim().slice(-1500);
  return { fp: opts.join("|").slice(0, 300), block, nOpts: Math.min(opts.length, 8) };
}
async function relayPrompt(p: { block: string; nOpts: number }) {
  const digits = Array.from({ length: p.nOpts }, (_, i) => ({ text: String(i + 1), data: `sys:tui:${i + 1}` }));
  const ctl = [{ text: "⌨️ Enter", data: "sys:tui:enter" }, { text: "✖️ Esc", data: "sys:tui:esc" }, { text: "🖥 Экран", data: "sys:screen" }];
  for (const admin of SYS_ADMINS) {
    await sendReply({ chat_id: admin, text: `⚠️ В терминале сессии висит вопрос — выбери ответ кнопкой:\n\n${p.block}`, buttons: [digits, ctl] })
      .catch((e: any) => LOG(`relayPrompt: ${e.message}`));
  }
  LOG(`relayed TUI prompt (${p.nOpts} options)`);
}
async function sysTuiKey(chat_id: string, key: string, messageId?: any) {
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok) return void sendReply({ chat_id, text: `🔴 Сессия ${TMUX_SESSION} не запущена.` });
  if (key === "enter") sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  else if (key === "esc") sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"]);
  else { sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", key]); sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]); }
  alertedFp = promptFp;
  await sleep(1500);
  const out = paneTail(15).slice(-1200);
  const txt = `⌨️ Нажал «${key}»\n\n🖥 Экран:\n${out || "(пусто)"}`;
  if (messageId) editText(chat_id, messageId, txt).catch(() => sendReply({ chat_id, text: txt }));
  else sendReply({ chat_id, text: txt });
}
function sysRestartPrompt(chat_id: string) {
  return sendReply({ chat_id, text: "🔄 Перезапустить сессию claude5? Демон убьёт и поднимет её заново; входящие в это время буферизуются и догрузятся.", buttons: [
    [{ text: "✅ Подтвердить", data: "sys:restart:yes", intent: "positive" }, { text: "❌ Отмена", data: "sys:restart:no", intent: "negative" }],
  ] });
}
let lastRestartAt = 0;
async function doRestart(chat_id: string, messageId?: any) {
  const editOrSend = (t: string) => messageId ? editText(chat_id, messageId, t).catch(() => {}) : sendReply({ chat_id, text: t });
  if (!SYS_RESTART_CMD) return void editOrSend("⚠️ Рестарт не настроен на этом инстансе (SYS_RESTART_CMD пуст).");
  if (Date.now() - lastRestartAt < 60_000) return void editOrSend("⏳ Рестарт уже запускался <1 мин назад. Подожди.");
  lastRestartAt = Date.now();
  await editOrSend("🔄 Перезапускаю сессию claude5...");
  const r = sh(["bash", SYS_RESTART_CMD], 20_000);
  await sendReply({ chat_id, text: r.ok ? "✅ Рестарт запущен. Сессия поднимется за ~15с, новый инстанс ответит как будет готов." : `❌ Рестарт не удался: ${r.out}` });
}
// MAX bot commands registration (so the bot's command list shows them).
const BOT_COMMANDS = [
  { name: "menu", description: "🎛 Панель управления" },
  { name: "ping", description: "Проверить живость" },
  { name: "status", description: "Подробный статус" },
  { name: "screen", description: "Показать экран сессии" },
  { name: "restart", description: "Перезапустить сессию" },
  { name: "model", description: "🧠 Выбрать модель" },
  { name: "mcp", description: "🔌 Статус MCP-серверов" },
  { name: "logs", description: "Лог gateway" },
];
async function registerCommands() {
  // MAX sets bot commands via PATCH /me { commands: [{name, description}] }.
  try { await call("PATCH", "/me", { body: { commands: BOT_COMMANDS } }); LOG(`registered ${BOT_COMMANDS.length} bot commands`); }
  catch (e: any) { LOG(`register commands failed: ${e.message}`); }
}

async function handleSysCommand(chat_id: string, text: string) {
  LOG(`sys cmd "${text}"`);
  let cmd: string;
  if (/^\/menu\b/i.test(text)) cmd = "menu";
  else if (/^\/sys\b/i.test(text)) cmd = (text.split(/\s+/)[1] ?? "help").toLowerCase();
  else cmd = text.split(/\s+/)[0].replace(/^\//, "").toLowerCase();
  switch (cmd) {
    case "menu": return sysMenu(chat_id);
    case "ping": {
      const s = sessionState();
      return sendReply({ chat_id, text: `🟢 max-gateway v${VERSION} жив. Сессия: ${s.alive ? "🟢 онлайн" : "🔴 DOWN"} (${s.detail}). Последний опрос ${lastPollAgo()}с назад.` });
    }
    case "status": return sysStatus(chat_id);
    case "logs": return sysLogs(chat_id);
    case "screen": return sysScreen(chat_id);
    case "restart": return sysRestartPrompt(chat_id);
    case "model": case "models": return sysModels(chat_id);
    case "mcp": return sysMcp(chat_id);
    case "cc": return sysSendKeys(chat_id, text.replace(/^\/sys\s+cc\s*/i, ""));
    default: return sendReply({ chat_id, text: "Команды: /menu · /sys ping · /sys status · /sys logs · /sys screen · /sys restart · /sys mcp · /sys cc <команда> (напр. /sys cc /compact)" });
  }
}

// ---------- outbox watcher ----------
async function pumpOutbox() {
  let files: string[] = [];
  try { files = readdirSync(OUTBOX).filter(f => f.startsWith("req-") && f.endsWith(".json")); } catch { return; }
  for (const f of files) {
    const full = join(OUTBOX, f);
    let req: any;
    try { req = JSON.parse(readFileSync(full, "utf8")); } catch { unlinkSync(full); continue; }
    unlinkSync(full);
    if (req.tool === "ask") { // deferred: res written by resolveAsk on tap/timeout
      try { await startAsk(req.id, req.args); } catch (e: any) { writeRes({ id: req.id, ok: false, error: e.message }); LOG(`outbox ask error: ${e.message}`); }
      continue;
    }
    let res: any;
    try { res = { id: req.id, ok: true, result: await execTool(req.tool, req.args) }; }
    catch (e: any) { res = { id: req.id, ok: false, error: e.message }; LOG(`outbox ${req.tool} error: ${e.message}`); }
    writeRes(res);
  }
}

// ---------- brain-silent alert + res cleanup ----------
const BRAIN_STALE_MS = 150_000;
let brainWasAlive: boolean | null = null;
function checkBrain() {
  let age = Infinity;
  try { age = Date.now() - statSync(BRIDGE_HEARTBEAT).mtimeMs; } catch {}
  const alive = age < BRAIN_STALE_MS;
  const tell = (t: string) => { for (const a of SYS_ADMINS) sendReply({ chat_id: a, text: t }).catch(() => {}); };
  if (brainWasAlive === null) {
    brainWasAlive = alive;
    if (!alive) tell(`🔴 Сессия claude5 не на связи (heartbeat моста ${age === Infinity ? "отсутствует" : "устарел"}). Входящие буферизуются. Подними её: /restart`);
  } else if (brainWasAlive && !alive) {
    brainWasAlive = false;
    tell(`🔴 Сессия claude5 молчит ~${Math.round(age / 60_000)} мин — мост перестал слать heartbeat. Входящие буферизуются и доедут. Жми /restart, детали: /status`);
  } else if (!brainWasAlive && alive) {
    brainWasAlive = true;
    tell("🟢 Сессия claude5 снова на связи — heartbeat пошёл, бэклог сообщений доезжает.");
  }
}
function cleanupRes() {
  try {
    for (const f of readdirSync(OUTBOX_RES)) {
      const p = join(OUTBOX_RES, f);
      try { if (Date.now() - statSync(p).mtimeMs > 3600_000) unlinkSync(p); } catch {}
    }
  } catch {}
}

// ---------- robust long-poll loop (marker-cursor) ----------
let marker: number | undefined;
try { const m = Number(readFileSync(MARKER_FILE, "utf8")); if (m) marker = m; } catch {}
function saveMarker() { try { if (marker != null) writeFileSync(MARKER_FILE, String(marker)); } catch {} }

let netBackoff = 1000, running = true;
process.on("SIGTERM", () => { LOG("SIGTERM, stopping"); saveMarker(); releaseLock(); process.exit(0); });
process.on("SIGINT", () => { saveMarker(); releaseLock(); process.exit(0); });
process.on("uncaughtException", (e: any) => { LOG(`FATAL uncaughtException: ${e?.stack || e}`); releaseLock(); process.exit(1); });
process.on("unhandledRejection", (e: any) => { LOG(`FATAL unhandledRejection: ${e?.stack || e}`); releaseLock(); process.exit(1); });

// Long-poll uses a generous server hold; our fetch timeout sits just above it.
const POLL_TIMEOUT_S = 50;

async function freeLongPoll() {
  // A live webhook subscription blocks long-poll. Drop any (best-effort) so /updates works.
  try {
    const subs = await call("GET", "/subscriptions", {}, 10000);
    const list = Array.isArray(subs?.subscriptions) ? subs.subscriptions : [];
    for (const s of list) { if (s?.url) { try { await call("DELETE", "/subscriptions", { query: { url: s.url } }, 10000); LOG(`removed webhook ${s.url}`); } catch {} } }
  } catch (e: any) { LOG(`subscriptions check: ${e.message}`); }
}

async function main() {
  acquireLock();
  LOG(`starting v${VERSION}. base=${BASE} state=${STATE_DIR} marker=${marker ?? "—"}`);
  status.lastPollOk = new Date().toISOString(); // seed so the watchdog doesn't fire during startup
  status.marker = marker ?? null;
  writeStatus();
  // Verify token + host before committing to the loop (clean 401 -> fatal exit).
  try { const me = await call("GET", "/me", {}, 15000); LOG(`authed as bot @${me?.username ?? me?.name ?? "?"} (id ${me?.user_id ?? "?"})`); }
  catch (e: any) {
    if (e instanceof MaxError && e.status === 401) { LOG("FATAL 401: bad MAX token"); releaseLock(); process.exit(1); }
    LOG(`/me check failed (continuing): ${e.message}`);
  }
  await freeLongPoll();
  registerCommands().catch(() => {});
  setInterval(() => { pumpOutbox().catch(e => LOG(`outbox pump: ${e.message}`)); }, 400);
  setInterval(() => {
    try {
      const p = detectPrompt();
      if (!p) { promptFp = ""; promptSeen = 0; return; }
      if (p.fp === promptFp) promptSeen++; else { promptFp = p.fp; promptSeen = 1; }
      if (promptSeen === 2 && alertedFp !== p.fp) { alertedFp = p.fp; relayPrompt(p); }
    } catch (e: any) { LOG(`prompt watcher: ${e.message}`); }
  }, PROMPT_POLL_MS);
  // keep "typing…" alive for chats awaiting a reply (MAX clears it after a few sec)
  setInterval(() => {
    const now = Date.now();
    for (const [chat, started] of typingChats) {
      if (now - started > TYPING_MAX_MS) { typingChats.delete(chat); continue; }
      sendAction(chat, "typing_on").catch(() => {});
    }
  }, 4500);
  setInterval(() => {
    writeStatus();
    const age = Date.now() - new Date(status.lastPollOk).getTime();
    if (age > STALE_MS) { LOG(`FATAL: no successful poll in ${Math.round(age / 1000)}s — wedged. exiting for supervisor restart.`); releaseLock(); process.exit(1); }
    checkBrain();
    cleanupRes();
  }, 15000);
  while (running) {
    try {
      const q: any = { timeout: POLL_TIMEOUT_S, limit: 100, types: UPDATE_TYPES };
      if (marker != null) q.marker = marker;
      const res = await call("GET", "/updates", { query: q }, (POLL_TIMEOUT_S + 15) * 1000);
      netBackoff = 1000; // healthy, reset
      status.lastPollOk = new Date().toISOString();
      for (const u of res?.updates ?? []) { await handleUpdate(u); status.updatesSeen++; status.lastInbound = new Date().toISOString(); }
      if (res?.marker != null) { marker = res.marker; status.marker = marker; saveMarker(); }
    } catch (e: any) {
      status.lastError = `${new Date().toISOString()} ${e.message}`;
      if (e instanceof MaxError && e.status === 401) { LOG("FATAL 401 Unauthorized: bad token"); releaseLock(); process.exit(1); }
      // Everything else — 429, 5xx, network, abort — is transient. Back off and KEEP
      // GOING (the official client's bug is that it returns here and dies). Never give up.
      LOG(`poll error: ${e.message}. backoff ${netBackoff / 1000}s`);
      await sleep(netBackoff); netBackoff = Math.min(netBackoff * 2, 60000);
    }
  }
  saveMarker(); writeStatus(); releaseLock(); LOG("stopped"); process.exit(0);
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ---------- `pair` setup mode: capture the owner's user_id + chat_id, write gateway.env ----------
function writeEnvFile(kv: Record<string, string>) {
  const existing: Record<string, string> = {};
  try {
    for (const line of readFileSync(CONFIG_ENV_FILE, "utf8").split("\n")) {
      const s = line.trim();
      if (s && !s.startsWith("#") && s.includes("=")) { const i = s.indexOf("="); existing[s.slice(0, i).trim()] = s.slice(i + 1).trim(); }
    }
  } catch {}
  const merged = { ...existing, ...kv };
  const body = "# max-gateway config (written by `pair`). Keep private — contains the bot token.\n" +
    Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = CONFIG_ENV_FILE + ".tmp";
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, CONFIG_ENV_FILE);
}

async function pairMode() {
  process.stderr.write("\n[pair] Открой MAX, найди своего бота и нажми «Старт» (или отправь любое сообщение).\n[pair] Жду до 5 минут...\n\n");
  await freeLongPoll();
  let m: number | undefined;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    let res: any;
    try { const q: any = { timeout: 25, limit: 100, types: UPDATE_TYPES }; if (m != null) q.marker = m; res = await call("GET", "/updates", { query: q }, 40000); }
    catch (e: any) { process.stderr.write(`[pair] опрос не удался: ${e.message}\n`); await sleep(2000); continue; }
    for (const u of res?.updates ?? []) {
      const sender = u.update_type === "bot_started" ? u.user : u.message?.sender;
      const chatId = u.update_type === "bot_started" ? u.chat_id : u.message?.recipient?.chat_id;
      if (!sender?.user_id || chatId == null) continue;
      const uid = String(sender.user_id), cid = String(chatId);
      const who = userName(sender);
      writeEnvFile({ MAX_BOT_TOKEN: TOKEN, MAX_SYS_ADMINS: uid, MAX_ALLOWED_CHATS: cid });
      try { await call("POST", "/messages", { query: { chat_id: cid }, body: { text: "✅ Спарено. Этот чат управляет твоим Claude; для остальных бот закрыт.", notify: true } }); } catch {}
      process.stderr.write(`[pair] OK — user_id=${uid}, chat_id=${cid} (${who}), конфиг записан: ${CONFIG_ENV_FILE}\n`);
      process.exit(0);
    }
    if (res?.marker != null) m = res.marker;
  }
  process.stderr.write("[pair] Таймаут: за 5 минут не пришло ни одного сообщения. Запусти setup ещё раз.\n");
  process.exit(1);
}

const MODE = process.argv.slice(2).find(a => !a.startsWith("-"));
if (MODE === "pair" || MODE === "setup") pairMode();
else main();
