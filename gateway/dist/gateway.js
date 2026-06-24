#!/usr/bin/env bun
// @bun

// gateway/gateway.ts
import { homedir } from "os";
import { join, basename } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, renameSync, statSync } from "fs";
import { spawnSync } from "child_process";
var STATE_DIR = process.env.MAX_STATE_DIR ?? join(homedir(), ".claude", "channels", "max-claude5");
var INBOX = join(STATE_DIR, "inbox");
var OUTBOX = join(STATE_DIR, "outbox");
var OUTBOX_RES = join(OUTBOX, "res");
var MARKER_FILE = join(STATE_DIR, "gateway.marker");
var STATUS_FILE = join(STATE_DIR, "gateway.status.json");
var LOCK_FILE = join(STATE_DIR, "gateway.lock");
var CONFIG_ENV_FILE = process.env.MAX_GATEWAY_ENV ?? join(STATE_DIR, "gateway.env");
(function loadEnvFile() {
  try {
    if (!existsSync(CONFIG_ENV_FILE))
      return;
    for (const line of readFileSync(CONFIG_ENV_FILE, "utf8").split(`
`)) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("="))
        continue;
      const i = s.indexOf("=");
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && process.env[k] === undefined)
        process.env[k] = v;
    }
  } catch {}
})();
var VERSION = "1.0.0";
var STALE_MS = 180000;
var SYS_ADMINS = new Set((process.env.MAX_SYS_ADMINS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
var ALLOWED_CHATS = new Set([
  ...(process.env.MAX_ALLOWED_CHATS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ...SYS_ADMINS
]);
function isAllowedChat(chatId, userId) {
  return ALLOWED_CHATS.has("*") || ALLOWED_CHATS.has(chatId) || SYS_ADMINS.has(userId);
}
var TMUX_SESSION = process.env.CLAUDE5_TMUX ?? "claude5";
var SYS_RESTART_CMD = process.env.SYS_RESTART_CMD ?? "";
var BRIDGE_HEARTBEAT = join(STATE_DIR, "bridge.heartbeat");
var TYPING_MAX_MS = 8 * 60000;
var typingChats = new Map;
var LOG = (m) => process.stderr.write(`[max-gateway ${new Date().toISOString()}] ${m}
`);
for (const d of [STATE_DIR, INBOX, OUTBOX, OUTBOX_RES])
  mkdirSync(d, { recursive: true });
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = Number(readFileSync(LOCK_FILE, "utf8").trim());
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          LOG(`FATAL: another max-gateway already running (pid ${pid}). exiting.`);
          process.exit(1);
        } catch {
          LOG(`stale lock from dead pid ${pid}, taking over`);
        }
      }
    }
  } catch {}
  try {
    writeFileSync(LOCK_FILE, String(process.pid));
  } catch {}
}
function releaseLock() {
  try {
    if (existsSync(LOCK_FILE) && Number(readFileSync(LOCK_FILE, "utf8").trim()) === process.pid)
      unlinkSync(LOCK_FILE);
  } catch {}
}
var status = {
  pid: process.pid,
  version: VERSION,
  started: new Date().toISOString(),
  lastPollOk: null,
  lastInbound: null,
  lastError: null,
  updatesSeen: 0,
  marker: null
};
function writeStatus() {
  try {
    const t = STATUS_FILE + ".tmp";
    writeFileSync(t, JSON.stringify(status, null, 2));
    renameSync(t, STATUS_FILE);
  } catch {}
}
function loadToken() {
  if (process.env.MAX_BOT_TOKEN)
    return process.env.MAX_BOT_TOKEN.trim();
  const f = join(homedir(), ".claude", "secrets", "max-bot-token");
  if (existsSync(f))
    return readFileSync(f, "utf8").trim();
  LOG("FATAL: no MAX_BOT_TOKEN and no secrets/max-bot-token");
  process.exit(1);
}
var TOKEN = loadToken();
var BASE = (process.env.MAX_API_BASE ?? "https://botapi.max.ru").replace(/\/+$/, "");
var UPDATE_TYPES = "message_created,message_callback,bot_started,message_edited";

class MaxError extends Error {
  status;
  code;
  constructor(status2, code, msg) {
    super(msg);
    this.status = status2;
    this.code = code;
  }
}
async function call(method, path, opts = {}, timeoutMs = 65000) {
  const ctrl = new AbortController;
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = new URL(BASE + (path.startsWith("/") ? path : "/" + path));
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null || v === "")
        continue;
      url.searchParams.set(k, String(v));
    }
    const headers = { Authorization: TOKEN };
    if (opts.body !== undefined)
      headers["content-type"] = "application/json";
    const r = await fetch(url.href, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal
    });
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200)
      throw new MaxError(r.status, j?.code ?? "", j?.message || `${method} ${path} http ${r.status}`);
    return j;
  } finally {
    clearTimeout(t);
  }
}
function writeInbox(name, obj) {
  const tmp = join(INBOX, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, join(INBOX, name));
}
async function downloadUrl(fileUrl, suggestExt) {
  const ext = suggestExt ?? (fileUrl.split("?")[0].includes(".") ? fileUrl.split("?")[0].split(".").pop() : "bin");
  const dest = join(INBOX, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  const resp = await fetch(fileUrl);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(dest, buf);
  return dest;
}
var GROQ_TOKEN_FILE = join(homedir(), ".claude", "secrets", "groq-token");
async function transcribeAudio(fileUrl) {
  try {
    if (!existsSync(GROQ_TOKEN_FILE))
      return null;
    const token = readFileSync(GROQ_TOKEN_FILE, "utf8").trim();
    const path = await downloadUrl(fileUrl, "ogg");
    const fd = new FormData;
    fd.append("model", "whisper-large-v3-turbo");
    fd.append("language", "ru");
    fd.append("file", new Blob([readFileSync(path)], { type: "audio/ogg" }), "voice.ogg");
    const ctrl = new AbortController;
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: fd,
        signal: ctrl.signal
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        LOG(`groq stt http ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
        return null;
      }
      return (j.text ?? "").trim() || null;
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    LOG(`audio stt: ${e.message}`);
    return null;
  }
}
function userName(u) {
  return u?.username ? `@${u.username}` : u?.name ?? "user";
}
function buttonLabel(msg, data) {
  const atts = msg?.body?.attachments;
  if (!Array.isArray(atts))
    return null;
  for (const a of atts) {
    if (a?.type !== "inline_keyboard")
      continue;
    for (const row of a.payload?.buttons ?? [])
      for (const b of row)
        if (b?.payload === data) {
          const t = String(b.text ?? "").trim();
          return t || null;
        }
  }
  return null;
}
async function handleCallback(u) {
  const cb = u.callback ?? {};
  const data = cb.payload ?? "";
  const from = cb.user ?? {};
  const msg = u.message ?? {};
  const chatId = String(msg?.recipient?.chat_id ?? "");
  const messageId = msg?.body?.mid;
  const askMatch = /^ask:([^:]+):(\d+)$/.exec(data);
  if (askMatch && pendingAsks.has(askMatch[1])) {
    const p = pendingAsks.get(askMatch[1]);
    const lbl = p?.options[Number(askMatch[2])] ?? "\u2713";
    try {
      await call("POST", "/answers", { query: { callback_id: cb.callback_id }, body: { notification: `\u2713 ${lbl}`.slice(0, 190) } });
    } catch {}
    resolveAsk(askMatch[1], Number(askMatch[2]), "answered");
    return;
  }
  if (data.startsWith("sys:")) {
    try {
      await call("POST", "/answers", { query: { callback_id: cb.callback_id }, body: {} });
    } catch {}
    if (!SYS_ADMINS.has(String(from.user_id ?? "")))
      return;
    LOG(`sys tap "${data}"`);
    const rest = data.slice(4);
    if (rest === "status")
      return void sysStatus(chatId);
    if (rest === "logs")
      return void sysLogs(chatId);
    if (rest === "screen")
      return void sysScreen(chatId);
    if (rest === "restart")
      return void sysRestartPrompt(chatId);
    if (rest === "restart:yes")
      return void doRestart(chatId, messageId);
    if (rest === "restart:no") {
      if (messageId)
        editText(chatId, messageId, "\u041E\u0442\u043C\u0435\u043D\u0435\u043D\u043E.").catch(() => {});
      return;
    }
    if (rest.startsWith("cc:"))
      return void sysSendKeys(chatId, rest.slice(3));
    if (rest === "models")
      return void sysModels(chatId);
    if (rest === "mcp")
      return void sysMcp(chatId);
    if (rest.startsWith("model:"))
      return void sysSetModel(chatId, rest.slice(6), messageId);
    if (rest.startsWith("tui:"))
      return void sysTuiKey(chatId, rest.slice(4), messageId);
    return;
  }
  if (!isAllowedChat(chatId, String(from.user_id ?? ""))) {
    try {
      await call("POST", "/answers", { query: { callback_id: cb.callback_id }, body: {} });
    } catch {}
    LOG(`DROP callback from non-allowed ${from.user_id}`);
    return;
  }
  const label = buttonLabel(msg, data) || data;
  try {
    await call("POST", "/answers", { query: { callback_id: cb.callback_id }, body: { notification: `\u2713 ${label}`.slice(0, 190) } });
  } catch (e) {
    LOG(`answer cb: ${e.message}`);
  }
  if (messageId != null) {
    try {
      await editText(chatId, messageId, msg?.body?.text ?? label, undefined, []);
    } catch {}
  }
  const base = {
    chat_id: chatId,
    message_id: String(Date.now()),
    user: userName(from),
    user_id: String(from.user_id ?? ""),
    ts: new Date().toISOString(),
    text: label,
    callback_data: data
  };
  writeInbox(`${Date.now()}-cbm-${cb.callback_id ?? Math.random().toString(36).slice(2)}.json`, base);
  LOG(`inbox <- button-tap chat ${chatId} data="${data}" label="${label}"`);
}
async function handleBotStarted(u) {
  const chatId = String(u.chat_id ?? "");
  const from = u.user ?? {};
  const userId = String(from.user_id ?? "");
  if (!isAllowedChat(chatId, userId)) {
    LOG(`DROP bot_started non-allowed chat ${chatId} user ${userId}`);
    return;
  }
  const base = {
    chat_id: chatId,
    message_id: String(Date.now()),
    user: userName(from),
    user_id: userId,
    ts: new Date().toISOString(),
    text: u.payload ? String(u.payload) : "/start"
  };
  writeInbox(`${Date.now()}-start.json`, base);
  LOG(`inbox <- bot_started chat ${chatId} user ${userId}`);
}
async function handleMessage(u) {
  const m = u.message;
  if (!m)
    return;
  const sender = m.sender ?? {};
  const rec = m.recipient ?? {};
  const chatId = rec.chat_id != null ? String(rec.chat_id) : "";
  const userId = String(sender.user_id ?? "");
  if (!isAllowedChat(chatId, userId)) {
    LOG(`DROP non-allowed chat ${chatId} user ${userId} (${userName(sender)}): ${(m.body?.text ?? "[media]").slice(0, 80)}`);
    return;
  }
  const text0 = (m.body?.text ?? "").trim();
  if (/^\/(sys|menu|ping|status|restart|screen|logs|model|models|mcp)\b/i.test(text0)) {
    if (!SYS_ADMINS.has(userId)) {
      await sendReply({ chat_id: chatId, text: "\u26D4 \u041A\u043E\u043C\u0430\u043D\u0434\u044B \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0443." }).catch(() => {});
      return;
    }
    return void handleSysCommand(chatId, text0).catch((e) => LOG(`sys cmd error: ${e.message}`));
  }
  sendAction(chatId, "mark_seen").catch(() => {});
  sendAction(chatId, "typing_on").catch(() => {});
  typingChats.set(chatId, Date.now());
  const base = {
    chat_id: chatId,
    message_id: String(m.body?.mid ?? Date.now()),
    user: userName(sender),
    user_id: userId,
    ts: new Date(m.timestamp ?? Date.now()).toISOString()
  };
  if (m.link?.type === "reply" && m.link?.message?.mid)
    base.reply_to_mid = String(m.link.message.mid);
  const atts = Array.isArray(m.body?.attachments) ? m.body.attachments : [];
  const caption = m.body?.text ?? "";
  try {
    const img = atts.find((a) => a.type === "image");
    const audio = atts.find((a) => a.type === "audio");
    const video = atts.find((a) => a.type === "video");
    const file = atts.find((a) => a.type === "file");
    if (img?.payload?.url) {
      base.text = caption;
      base.image_path = await downloadUrl(img.payload.url, "jpg");
    } else if (audio?.payload?.url) {
      base.text = caption;
      base.attachment_file_id = audio.payload.url;
      base.attachment_kind = "audio";
      const stt = await transcribeAudio(audio.payload.url);
      if (stt) {
        base.text = `[\u0433\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435, \u0440\u0430\u0441\u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u043E \u0432 \u0442\u0440\u0430\u043D\u0441\u043F\u043E\u0440\u0442\u0435] ${stt}`;
        base.voice_transcribed = true;
      }
    } else if (video?.payload?.url) {
      base.text = caption;
      base.attachment_file_id = video.payload.url;
      base.attachment_kind = "video";
    } else if (file?.payload?.url) {
      base.text = caption;
      base.attachment_file_id = file.payload.url;
      base.attachment_kind = "file";
      base.attachment_name = file.filename;
      base.attachment_size = file.size;
    } else if (text0) {
      base.text = m.body.text;
    } else {
      base.text = caption || "[unsupported message type]";
    }
  } catch (e) {
    LOG(`media handling error: ${e.message}`);
    base.text = base.text ?? "[media download failed]";
  }
  writeInbox(`${Date.now()}-${base.message_id}.json`, base);
  LOG(`inbox <- chat ${base.chat_id} msg ${base.message_id} ${base.image_path ? "[photo]" : base.attachment_kind ? `[${base.attachment_kind}]${base.voice_transcribed ? "+stt" : ""}` : ""}`);
}
async function handleUpdate(u) {
  switch (u.update_type) {
    case "message_callback":
      return handleCallback(u);
    case "bot_started":
      return handleBotStarted(u);
    case "message_created":
    case "message_edited":
      return handleMessage(u);
    default:
      return;
  }
}
async function sendAction(chatId, action) {
  if (!chatId)
    return;
  try {
    await call("POST", `/chats/${chatId}/actions`, { body: { action } }, 8000);
  } catch {}
}
function chunk(text, limit = 3900) {
  if (text.length <= limit)
    return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(`
`, limit);
    if (cut < limit * 0.6)
      cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest)
    out.push(rest);
  return out;
}
function normalizeButtons(buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0)
    return;
  const rows = Array.isArray(buttons[0]) ? buttons : [buttons];
  const out = rows.map((row) => row.map((b) => {
    if (b.url)
      return { type: "link", text: String(b.text), url: String(b.url) };
    const btn = { type: "callback", text: String(b.text), payload: String(b.data ?? b.text).slice(0, 64) };
    if (b.intent === "positive" || b.intent === "negative" || b.intent === "default")
      btn.intent = b.intent;
    return btn;
  }));
  return { type: "inline_keyboard", payload: { buttons: out } };
}
async function uploadMedia(path) {
  try {
    const name = basename(path);
    const type = /\.(jpe?g|png|webp|gif|bmp)$/i.test(name) ? "image" : /\.(mp4|mov|webm|mkv|avi)$/i.test(name) ? "video" : /\.(mp3|ogg|oga|wav|m4a|flac)$/i.test(name) ? "audio" : "file";
    const up = await call("POST", "/uploads", { query: { type } });
    const buf = readFileSync(path);
    const fd = new FormData;
    fd.append("data", new Blob([buf]), name);
    const r = await fetch(up.url, { method: "POST", body: fd });
    const resp = await r.json().catch(() => ({}));
    if (type === "image") {
      const photos = resp?.photos ?? (resp && typeof resp === "object" && !resp.token ? resp : null);
      if (photos && Object.keys(photos).length)
        return { type: "image", payload: { photos } };
    }
    const token = up.token ?? resp?.token;
    if (token)
      return { type, payload: { token } };
    LOG(`upload ${name}: no token (resp ${JSON.stringify(resp).slice(0, 160)})`);
    return null;
  } catch (e) {
    LOG(`upload failed ${path}: ${e.message}`);
    return null;
  }
}
async function sendOne(chat_id, body, tries = 0) {
  try {
    const r = await call("POST", "/messages", { query: { chat_id }, body });
    return String(r?.message?.body?.mid ?? "");
  } catch (e) {
    if (e instanceof MaxError && e.code === "attachment.not.ready" && tries < 6) {
      await sleep(1500);
      return sendOne(chat_id, body, tries + 1);
    }
    if (body.format && tries < 7) {
      const { format, ...plain } = body;
      return sendOne(chat_id, plain, tries + 1);
    }
    throw e;
  }
}
async function sendReply(args) {
  const { chat_id, text, format, reply_to, files, disable_notification } = args;
  typingChats.delete(String(chat_id));
  const fmt = format === "markdown" || format === "html" ? format : undefined;
  const kb = normalizeButtons(args.buttons);
  const link = reply_to ? { type: "reply", mid: String(reply_to) } : undefined;
  const ids = [];
  if (files && files.length) {
    const attachments = [];
    for (const p of files) {
      const a = await uploadMedia(p);
      if (a)
        attachments.push(a);
    }
    if (kb)
      attachments.push(kb);
    const body = { text: text ?? "", notify: !disable_notification };
    if (attachments.length)
      body.attachments = attachments;
    if (fmt)
      body.format = fmt;
    if (link)
      body.link = link;
    if (!attachments.length)
      LOG(`reply with files but all uploads failed; sending text only`);
    ids.push(await sendOne(String(chat_id), body));
    return { message_ids: ids };
  }
  const parts = chunk(text ?? "");
  for (let i = 0;i < parts.length; i++) {
    const last = i === parts.length - 1;
    const quiet = disable_notification || !last;
    const body = { text: parts[i], notify: !quiet };
    if (fmt)
      body.format = fmt;
    if (kb && last)
      body.attachments = [kb];
    if (link && i === 0)
      body.link = link;
    ids.push(await sendOne(String(chat_id), body));
  }
  return { message_ids: ids };
}
async function editText(chat_id, message_id, text, format, buttons) {
  const body = { text };
  if (format === "markdown" || format === "html")
    body.format = format;
  const kb = normalizeButtons(buttons);
  if (kb)
    body.attachments = [kb];
  else if (Array.isArray(buttons))
    body.attachments = [];
  try {
    return await call("PUT", "/messages", { query: { message_id: String(message_id) }, body });
  } catch (e) {
    if (!body.format)
      throw e;
    const { format: _f, ...plain } = body;
    return call("PUT", "/messages", { query: { message_id: String(message_id) }, body: plain });
  }
}
async function execTool(tool, args) {
  switch (tool) {
    case "reply":
      return sendReply(args);
    case "send_action": {
      await sendAction(String(args.chat_id), String(args.action ?? "typing_on"));
      return { ok: true };
    }
    case "edit_message":
      return editText(args.chat_id, args.message_id, args.text, args.format, args.buttons ?? (args.drop_buttons ? [] : undefined));
    case "delete_message":
      return call("DELETE", "/messages", { query: { message_id: String(args.message_id) } });
    case "download_attachment":
      return { path: await downloadUrl(String(args.file_id)) };
    case "status":
      return { ...status, now: new Date().toISOString() };
    default:
      throw new Error(`unknown tool ${tool}`);
  }
}
var ASK_TIMEOUT_MS = 600000;
var pendingAsks = new Map;
function writeRes(res) {
  const rt = join(OUTBOX_RES, `.${res.id}.tmp`);
  writeFileSync(rt, JSON.stringify(res));
  renameSync(rt, join(OUTBOX_RES, `${res.id}.json`));
}
async function startAsk(reqId, args) {
  const chat_id = String(args.chat_id ?? "");
  const question = String(args.question ?? "");
  const options = (Array.isArray(args.options) ? args.options : []).map(String).slice(0, 20);
  if (!chat_id || options.length === 0) {
    writeRes({ id: reqId, ok: false, error: "ask needs chat_id and non-empty options" });
    return;
  }
  const buttons = options.map((o, i) => [{ text: o, data: `ask:${reqId}:${i}` }]);
  const sent = await sendReply({ chat_id, text: question, format: args.format, buttons });
  const messageId = sent.message_ids[sent.message_ids.length - 1];
  const timer = setTimeout(() => resolveAsk(reqId, -1, "timeout"), ASK_TIMEOUT_MS);
  pendingAsks.set(reqId, { chat_id, options, messageId, timer });
  LOG(`ask ${reqId} sent (${options.length} options) msg ${messageId}`);
}
function resolveAsk(reqId, index, reason) {
  const p = pendingAsks.get(reqId);
  if (!p)
    return;
  clearTimeout(p.timer);
  pendingAsks.delete(reqId);
  if (index >= 0 && index < p.options.length) {
    writeRes({ id: reqId, ok: true, result: { choice: p.options[index], index } });
    editText(p.chat_id, p.messageId, `\u2705 ${p.options[index]}`, undefined, []).catch(() => {});
    LOG(`ask ${reqId} answered: ${p.options[index]}`);
  } else {
    writeRes({ id: reqId, ok: false, error: `no answer (${reason})` });
    editText(p.chat_id, p.messageId, `\u231B \u0411\u0435\u0437 \u043E\u0442\u0432\u0435\u0442\u0430`, undefined, []).catch(() => {});
    LOG(`ask ${reqId} unresolved: ${reason}`);
  }
}
function sh(cmd, timeoutMs = 6000) {
  try {
    const p = spawnSync(cmd[0], cmd.slice(1), { timeout: timeoutMs, encoding: "utf8", env: { ...process.env, TMUX: "" } });
    const out = ((p.stdout ?? "") + (p.stderr ?? "")).trim();
    return { ok: p.status === 0, out };
  } catch (e) {
    return { ok: false, out: e.message };
  }
}
function uptimeStr() {
  const s = Math.round((Date.now() - new Date(status.started).getTime()) / 1000);
  return `${Math.floor(s / 3600)}\u0447 ${Math.floor(s % 3600 / 60)}\u043C`;
}
function sessionState() {
  try {
    const st = statSync(BRIDGE_HEARTBEAT);
    const age = Date.now() - st.mtimeMs;
    if (age < 60000)
      return { alive: true, detail: `\u043C\u043E\u0441\u0442 ${Math.round(age / 1000)}\u0441 \u043D\u0430\u0437\u0430\u0434` };
  } catch {}
  const p = sh(["pgrep", "-af", "claude --channels"]);
  if (p.ok && p.out)
    return { alive: true, detail: "claude --channels \u0437\u0430\u043F\u0443\u0449\u0435\u043D" };
  return { alive: false, detail: "\u043D\u0435\u0442 heartbeat \u043C\u043E\u0441\u0442\u0430 \u0438 \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430 claude --channels" };
}
function lastPollAgo() {
  return status.lastPollOk ? Math.round((Date.now() - new Date(status.lastPollOk).getTime()) / 1000) : -1;
}
function sysMenu(chat_id) {
  return sendReply({ chat_id, text: "\uD83C\uDF9B \u041F\u0430\u043D\u0435\u043B\u044C \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F claude5 (MAX)", buttons: [
    [{ text: "\uD83D\uDCCA \u0421\u0442\u0430\u0442\u0443\u0441", data: "sys:status" }, { text: "\uD83D\uDD04 \u0420\u0435\u0441\u0442\u0430\u0440\u0442", data: "sys:restart" }],
    [{ text: "\uD83D\uDCDC \u041B\u043E\u0433\u0438", data: "sys:logs" }, { text: "\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D", data: "sys:screen" }],
    [{ text: "\uD83D\uDDDC /compact", data: "sys:cc:/compact" }, { text: "\uD83E\uDDF9 /clear", data: "sys:cc:/clear" }],
    [{ text: "\uD83E\uDDE0 \u041C\u043E\u0434\u0435\u043B\u044C", data: "sys:models" }, { text: "\uD83D\uDD0C MCP", data: "sys:mcp" }]
  ] });
}
async function sysStatus(chat_id) {
  const s = sessionState();
  const proc = sh(["pgrep", "-af", "claude --channels"]);
  const pid = proc.ok && proc.out ? proc.out.split(`
`)[0].split(/\s+/)[0] : "-";
  let mem = "-";
  if (pid !== "-") {
    const m = sh(["ps", "-o", "rss=", "-p", pid]);
    if (m.ok && m.out)
      mem = `${Math.round(Number(m.out.trim()) / 1024)}\u041C\u0411`;
  }
  const lines = [
    `\uD83C\uDF9B max-gateway v${VERSION}: \uD83D\uDFE2 uptime ${uptimeStr()}`,
    `\u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0439 ${status.updatesSeen}, marker ${status.marker ?? "\u2014"}, \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0439 \u043E\u043F\u0440\u043E\u0441 ${lastPollAgo()}\u0441 \u043D\u0430\u0437\u0430\u0434`,
    `\u0441\u0435\u0441\u0441\u0438\u044F: ${s.alive ? "\uD83D\uDFE2 \u043E\u043D\u043B\u0430\u0439\u043D" : "\uD83D\uDD34 DOWN"} (${s.detail})`,
    `claude pid ${pid}, \u043F\u0430\u043C\u044F\u0442\u044C ${mem}`,
    status.lastError ? `\u043F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u043E\u0448\u0438\u0431\u043A\u0430: ${status.lastError}` : "\u043E\u0448\u0438\u0431\u043E\u043A \u043D\u0435\u0442"
  ];
  return sendReply({ chat_id, text: lines.join(`
`) });
}
function sysLogs(chat_id) {
  const j = sh(["journalctl", "--user", "-u", "max-gateway.service", "-n", "20", "--no-pager"]);
  const body = j.ok && j.out ? j.out.slice(-3500) : `journalctl \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D (\u0442\u0435\u0441\u0442-\u0438\u043D\u0441\u0442\u0430\u043D\u0441?). \u041F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u043E\u0448\u0438\u0431\u043A\u0430: ${status.lastError ?? "\u043D\u0435\u0442"}`;
  return sendReply({ chat_id, text: `\uD83D\uDCDC \u041B\u043E\u0433 max-gateway:

` + body });
}
function sysScreen(chat_id) {
  const c = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  if (!c.ok)
    return sendReply({ chat_id, text: `\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D: ${c.out || "\u043D\u0435\u0442 \u0441\u0435\u0441\u0441\u0438\u0438 " + TMUX_SESSION}` });
  const out = c.out.split(`
`).filter((l) => l.trim()).slice(-40).join(`
`).slice(-3500);
  return sendReply({ chat_id, text: `\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D claude5:

` + (out || "(\u043F\u0443\u0441\u0442\u043E)") });
}
async function sysMcp(chat_id) {
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return sendReply({ chat_id, text: `\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${TMUX_SESSION} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 \u2014 \u043F\u0430\u043D\u0435\u043B\u044C /mcp \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0442\u044C \u043D\u0435\u0433\u0434\u0435.` });
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", "/mcp"]);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  await sleep(2000);
  const cap = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  const out = cap.ok ? cap.out.split(`
`).filter((l) => l.trim()).slice(-45).join(`
`).slice(-3500) : "(\u044D\u043A\u0440\u0430\u043D \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D)";
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"]);
  await sleep(250);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"]);
  return sendReply({ chat_id, text: `\uD83D\uDD0C \u041F\u0430\u043D\u0435\u043B\u044C /mcp \u0432 \u0441\u0435\u0441\u0441\u0438\u0438:

${out || "(\u043F\u0443\u0441\u0442\u043E)"}` });
}
async function sysSendKeys(chat_id, keys) {
  keys = keys.trim();
  if (!keys)
    return sendReply({ chat_id, text: "\u0424\u043E\u0440\u043C\u0430\u0442: /sys cc <\u043A\u043E\u043C\u0430\u043D\u0434\u0430>, \u043D\u0430\u043F\u0440. /sys cc /compact" });
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return sendReply({ chat_id, text: `\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${TMUX_SESSION} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 - \u043A\u043E\u043C\u0430\u043D\u0434\u0443 \u043D\u0435\u043A\u0443\u0434\u0430 \u0441\u043B\u0430\u0442\u044C.` });
  const r1 = sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", keys]);
  const r2 = sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  if (!r1.ok || !r2.ok)
    return sendReply({ chat_id, text: `send-keys \u043E\u0448\u0438\u0431\u043A\u0430: ${r1.out || r2.out}` });
  await sleep(1500);
  const cap = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  const out = cap.ok ? cap.out.split(`
`).filter((l) => l.trim()).slice(-30).join(`
`).slice(-3000) : "(\u044D\u043A\u0440\u0430\u043D \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D)";
  return sendReply({ chat_id, text: `\u2328\uFE0F \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u043B \u0432 claude5: ${keys}

\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D:
${out}` });
}
var MODELS = [
  { label: "Opus 4.8 (1M)", id: "claude-opus-4-8[1m]" },
  { label: "Opus 4.8", id: "claude-opus-4-8" },
  { label: "Sonnet 4.6", id: "claude-sonnet-4-6" },
  { label: "Haiku 4.5", id: "claude-haiku-4-5-20251001" },
  { label: "Fable 5", id: "claude-fable-5" }
];
function sysModels(chat_id) {
  const buttons = MODELS.map((m, i) => [{ text: m.label, data: `sys:model:${i}` }]);
  return sendReply({ chat_id, text: "\uD83E\uDDE0 \u0412\u044B\u0431\u0435\u0440\u0438 \u043C\u043E\u0434\u0435\u043B\u044C (\u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u043D\u0430 \u043B\u0435\u0442\u0443, \u0431\u0435\u0437 \u0440\u0435\u0441\u0442\u0430\u0440\u0442\u0430):", buttons });
}
async function sysSetModel(chat_id, idx, messageId) {
  const m = MODELS[Number(idx)];
  if (!m)
    return void sendReply({ chat_id, text: "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043C\u043E\u0434\u0435\u043B\u044C." });
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return void sendReply({ chat_id, text: `\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${TMUX_SESSION} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430 \u2014 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0430\u0442\u044C \u043D\u0435\u043A\u043E\u0433\u043E.` });
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", `/model ${m.id}`]);
  sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  await sleep(2500);
  let confirmed = false;
  if (/Switch model\?/i.test(paneTail())) {
    sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
    confirmed = true;
    await sleep(1200);
  }
  const txt = `\uD83E\uDDE0 \u041F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0438\u043B \u043D\u0430 ${m.label}
(${m.id})${confirmed ? `
\u2705 \u0434\u0438\u0430\u043B\u043E\u0433 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F \u043D\u0430\u0436\u0430\u043B \u0437\u0430 \u0442\u0435\u0431\u044F` : ""}`;
  if (messageId)
    editText(chat_id, messageId, txt).catch(() => sendReply({ chat_id, text: txt }));
  else
    sendReply({ chat_id, text: txt });
}
var PROMPT_POLL_MS = 5000;
var promptFp = "";
var promptSeen = 0;
var alertedFp = "";
function paneTail(lines = 30) {
  const c = sh(["tmux", "capture-pane", "-t", TMUX_SESSION, "-p"]);
  return c.ok ? c.out.split(`
`).filter((l) => l.trim()).slice(-lines).join(`
`) : "";
}
function detectPrompt() {
  const tail = paneTail();
  if (!/\u276F\s*\d+\./.test(tail))
    return null;
  const lines = tail.split(`
`);
  const opts = [];
  let firstOpt = -1;
  for (let i = 0;i < lines.length; i++) {
    const m = /^\s*(?:\u2502\s*)?\u276F?\s*(\d+)\.\s+(.+)$/.exec(lines[i]);
    if (m) {
      opts.push(`${m[1]}. ${m[2].trim()}`);
      if (firstOpt < 0)
        firstOpt = i;
    }
  }
  if (!opts.length)
    return null;
  const ctx = lines.slice(Math.max(0, firstOpt - 6), firstOpt).join(`
`);
  const block = `${ctx}

${opts.join(`
`)}`.trim().slice(-1500);
  return { fp: opts.join("|").slice(0, 300), block, nOpts: Math.min(opts.length, 8) };
}
async function relayPrompt(p) {
  const digits = Array.from({ length: p.nOpts }, (_, i) => ({ text: String(i + 1), data: `sys:tui:${i + 1}` }));
  const ctl = [{ text: "\u2328\uFE0F Enter", data: "sys:tui:enter" }, { text: "\u2716\uFE0F Esc", data: "sys:tui:esc" }, { text: "\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D", data: "sys:screen" }];
  for (const admin of SYS_ADMINS) {
    await sendReply({ chat_id: admin, text: `\u26A0\uFE0F \u0412 \u0442\u0435\u0440\u043C\u0438\u043D\u0430\u043B\u0435 \u0441\u0435\u0441\u0441\u0438\u0438 \u0432\u0438\u0441\u0438\u0442 \u0432\u043E\u043F\u0440\u043E\u0441 \u2014 \u0432\u044B\u0431\u0435\u0440\u0438 \u043E\u0442\u0432\u0435\u0442 \u043A\u043D\u043E\u043F\u043A\u043E\u0439:

${p.block}`, buttons: [digits, ctl] }).catch((e) => LOG(`relayPrompt: ${e.message}`));
  }
  LOG(`relayed TUI prompt (${p.nOpts} options)`);
}
async function sysTuiKey(chat_id, key, messageId) {
  if (!sh(["tmux", "has-session", "-t", TMUX_SESSION]).ok)
    return void sendReply({ chat_id, text: `\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F ${TMUX_SESSION} \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D\u0430.` });
  if (key === "enter")
    sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  else if (key === "esc")
    sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Escape"]);
  else {
    sh(["tmux", "send-keys", "-t", TMUX_SESSION, "-l", key]);
    sh(["tmux", "send-keys", "-t", TMUX_SESSION, "Enter"]);
  }
  alertedFp = promptFp;
  await sleep(1500);
  const out = paneTail(15).slice(-1200);
  const txt = `\u2328\uFE0F \u041D\u0430\u0436\u0430\u043B \xAB${key}\xBB

\uD83D\uDDA5 \u042D\u043A\u0440\u0430\u043D:
${out || "(\u043F\u0443\u0441\u0442\u043E)"}`;
  if (messageId)
    editText(chat_id, messageId, txt).catch(() => sendReply({ chat_id, text: txt }));
  else
    sendReply({ chat_id, text: txt });
}
function sysRestartPrompt(chat_id) {
  return sendReply({ chat_id, text: "\uD83D\uDD04 \u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E claude5? \u0414\u0435\u043C\u043E\u043D \u0443\u0431\u044C\u0451\u0442 \u0438 \u043F\u043E\u0434\u043D\u0438\u043C\u0435\u0442 \u0435\u0451 \u0437\u0430\u043D\u043E\u0432\u043E; \u0432\u0445\u043E\u0434\u044F\u0449\u0438\u0435 \u0432 \u044D\u0442\u043E \u0432\u0440\u0435\u043C\u044F \u0431\u0443\u0444\u0435\u0440\u0438\u0437\u0443\u044E\u0442\u0441\u044F \u0438 \u0434\u043E\u0433\u0440\u0443\u0437\u044F\u0442\u0441\u044F.", buttons: [
    [{ text: "\u2705 \u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C", data: "sys:restart:yes", intent: "positive" }, { text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0430", data: "sys:restart:no", intent: "negative" }]
  ] });
}
var lastRestartAt = 0;
async function doRestart(chat_id, messageId) {
  const editOrSend = (t) => messageId ? editText(chat_id, messageId, t).catch(() => {}) : sendReply({ chat_id, text: t });
  if (!SYS_RESTART_CMD)
    return void editOrSend("\u26A0\uFE0F \u0420\u0435\u0441\u0442\u0430\u0440\u0442 \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D \u043D\u0430 \u044D\u0442\u043E\u043C \u0438\u043D\u0441\u0442\u0430\u043D\u0441\u0435 (SYS_RESTART_CMD \u043F\u0443\u0441\u0442).");
  if (Date.now() - lastRestartAt < 60000)
    return void editOrSend("\u23F3 \u0420\u0435\u0441\u0442\u0430\u0440\u0442 \u0443\u0436\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u043B\u0441\u044F <1 \u043C\u0438\u043D \u043D\u0430\u0437\u0430\u0434. \u041F\u043E\u0434\u043E\u0436\u0434\u0438.");
  lastRestartAt = Date.now();
  await editOrSend("\uD83D\uDD04 \u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430\u044E \u0441\u0435\u0441\u0441\u0438\u044E claude5...");
  const r = sh(["bash", SYS_RESTART_CMD], 20000);
  await sendReply({ chat_id, text: r.ok ? "\u2705 \u0420\u0435\u0441\u0442\u0430\u0440\u0442 \u0437\u0430\u043F\u0443\u0449\u0435\u043D. \u0421\u0435\u0441\u0441\u0438\u044F \u043F\u043E\u0434\u043D\u0438\u043C\u0435\u0442\u0441\u044F \u0437\u0430 ~15\u0441, \u043D\u043E\u0432\u044B\u0439 \u0438\u043D\u0441\u0442\u0430\u043D\u0441 \u043E\u0442\u0432\u0435\u0442\u0438\u0442 \u043A\u0430\u043A \u0431\u0443\u0434\u0435\u0442 \u0433\u043E\u0442\u043E\u0432." : `\u274C \u0420\u0435\u0441\u0442\u0430\u0440\u0442 \u043D\u0435 \u0443\u0434\u0430\u043B\u0441\u044F: ${r.out}` });
}
var BOT_COMMANDS = [
  { name: "menu", description: "\uD83C\uDF9B \u041F\u0430\u043D\u0435\u043B\u044C \u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F" },
  { name: "ping", description: "\u041F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C \u0436\u0438\u0432\u043E\u0441\u0442\u044C" },
  { name: "status", description: "\u041F\u043E\u0434\u0440\u043E\u0431\u043D\u044B\u0439 \u0441\u0442\u0430\u0442\u0443\u0441" },
  { name: "screen", description: "\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u044D\u043A\u0440\u0430\u043D \u0441\u0435\u0441\u0441\u0438\u0438" },
  { name: "restart", description: "\u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0441\u0435\u0441\u0441\u0438\u044E" },
  { name: "model", description: "\uD83E\uDDE0 \u0412\u044B\u0431\u0440\u0430\u0442\u044C \u043C\u043E\u0434\u0435\u043B\u044C" },
  { name: "mcp", description: "\uD83D\uDD0C \u0421\u0442\u0430\u0442\u0443\u0441 MCP-\u0441\u0435\u0440\u0432\u0435\u0440\u043E\u0432" },
  { name: "logs", description: "\u041B\u043E\u0433 gateway" }
];
async function registerCommands() {
  try {
    await call("PATCH", "/me", { body: { commands: BOT_COMMANDS } });
    LOG(`registered ${BOT_COMMANDS.length} bot commands`);
  } catch (e) {
    LOG(`register commands failed: ${e.message}`);
  }
}
async function handleSysCommand(chat_id, text) {
  LOG(`sys cmd "${text}"`);
  let cmd;
  if (/^\/menu\b/i.test(text))
    cmd = "menu";
  else if (/^\/sys\b/i.test(text))
    cmd = (text.split(/\s+/)[1] ?? "help").toLowerCase();
  else
    cmd = text.split(/\s+/)[0].replace(/^\//, "").toLowerCase();
  switch (cmd) {
    case "menu":
      return sysMenu(chat_id);
    case "ping": {
      const s = sessionState();
      return sendReply({ chat_id, text: `\uD83D\uDFE2 max-gateway v${VERSION} \u0436\u0438\u0432. \u0421\u0435\u0441\u0441\u0438\u044F: ${s.alive ? "\uD83D\uDFE2 \u043E\u043D\u043B\u0430\u0439\u043D" : "\uD83D\uDD34 DOWN"} (${s.detail}). \u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0439 \u043E\u043F\u0440\u043E\u0441 ${lastPollAgo()}\u0441 \u043D\u0430\u0437\u0430\u0434.` });
    }
    case "status":
      return sysStatus(chat_id);
    case "logs":
      return sysLogs(chat_id);
    case "screen":
      return sysScreen(chat_id);
    case "restart":
      return sysRestartPrompt(chat_id);
    case "model":
    case "models":
      return sysModels(chat_id);
    case "mcp":
      return sysMcp(chat_id);
    case "cc":
      return sysSendKeys(chat_id, text.replace(/^\/sys\s+cc\s*/i, ""));
    default:
      return sendReply({ chat_id, text: "\u041A\u043E\u043C\u0430\u043D\u0434\u044B: /menu \xB7 /sys ping \xB7 /sys status \xB7 /sys logs \xB7 /sys screen \xB7 /sys restart \xB7 /sys mcp \xB7 /sys cc <\u043A\u043E\u043C\u0430\u043D\u0434\u0430> (\u043D\u0430\u043F\u0440. /sys cc /compact)" });
  }
}
async function pumpOutbox() {
  let files = [];
  try {
    files = readdirSync(OUTBOX).filter((f) => f.startsWith("req-") && f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of files) {
    const full = join(OUTBOX, f);
    let req;
    try {
      req = JSON.parse(readFileSync(full, "utf8"));
    } catch {
      unlinkSync(full);
      continue;
    }
    unlinkSync(full);
    if (req.tool === "ask") {
      try {
        await startAsk(req.id, req.args);
      } catch (e) {
        writeRes({ id: req.id, ok: false, error: e.message });
        LOG(`outbox ask error: ${e.message}`);
      }
      continue;
    }
    let res;
    try {
      res = { id: req.id, ok: true, result: await execTool(req.tool, req.args) };
    } catch (e) {
      res = { id: req.id, ok: false, error: e.message };
      LOG(`outbox ${req.tool} error: ${e.message}`);
    }
    writeRes(res);
  }
}
var BRAIN_STALE_MS = 150000;
var brainWasAlive = null;
function checkBrain() {
  let age = Infinity;
  try {
    age = Date.now() - statSync(BRIDGE_HEARTBEAT).mtimeMs;
  } catch {}
  const alive = age < BRAIN_STALE_MS;
  const tell = (t) => {
    for (const a of SYS_ADMINS)
      sendReply({ chat_id: a, text: t }).catch(() => {});
  };
  if (brainWasAlive === null) {
    brainWasAlive = alive;
    if (!alive)
      tell(`\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F claude5 \u043D\u0435 \u043D\u0430 \u0441\u0432\u044F\u0437\u0438 (heartbeat \u043C\u043E\u0441\u0442\u0430 ${age === Infinity ? "\u043E\u0442\u0441\u0443\u0442\u0441\u0442\u0432\u0443\u0435\u0442" : "\u0443\u0441\u0442\u0430\u0440\u0435\u043B"}). \u0412\u0445\u043E\u0434\u044F\u0449\u0438\u0435 \u0431\u0443\u0444\u0435\u0440\u0438\u0437\u0443\u044E\u0442\u0441\u044F. \u041F\u043E\u0434\u043D\u0438\u043C\u0438 \u0435\u0451: /restart`);
  } else if (brainWasAlive && !alive) {
    brainWasAlive = false;
    tell(`\uD83D\uDD34 \u0421\u0435\u0441\u0441\u0438\u044F claude5 \u043C\u043E\u043B\u0447\u0438\u0442 ~${Math.round(age / 60000)} \u043C\u0438\u043D \u2014 \u043C\u043E\u0441\u0442 \u043F\u0435\u0440\u0435\u0441\u0442\u0430\u043B \u0441\u043B\u0430\u0442\u044C heartbeat. \u0412\u0445\u043E\u0434\u044F\u0449\u0438\u0435 \u0431\u0443\u0444\u0435\u0440\u0438\u0437\u0443\u044E\u0442\u0441\u044F \u0438 \u0434\u043E\u0435\u0434\u0443\u0442. \u0416\u043C\u0438 /restart, \u0434\u0435\u0442\u0430\u043B\u0438: /status`);
  } else if (!brainWasAlive && alive) {
    brainWasAlive = true;
    tell("\uD83D\uDFE2 \u0421\u0435\u0441\u0441\u0438\u044F claude5 \u0441\u043D\u043E\u0432\u0430 \u043D\u0430 \u0441\u0432\u044F\u0437\u0438 \u2014 heartbeat \u043F\u043E\u0448\u0451\u043B, \u0431\u044D\u043A\u043B\u043E\u0433 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u0434\u043E\u0435\u0437\u0436\u0430\u0435\u0442.");
  }
}
function cleanupRes() {
  try {
    for (const f of readdirSync(OUTBOX_RES)) {
      const p = join(OUTBOX_RES, f);
      try {
        if (Date.now() - statSync(p).mtimeMs > 3600000)
          unlinkSync(p);
      } catch {}
    }
  } catch {}
}
var marker;
try {
  const m = Number(readFileSync(MARKER_FILE, "utf8"));
  if (m)
    marker = m;
} catch {}
function saveMarker() {
  try {
    if (marker != null)
      writeFileSync(MARKER_FILE, String(marker));
  } catch {}
}
var netBackoff = 1000;
var running = true;
process.on("SIGTERM", () => {
  LOG("SIGTERM, stopping");
  saveMarker();
  releaseLock();
  process.exit(0);
});
process.on("SIGINT", () => {
  saveMarker();
  releaseLock();
  process.exit(0);
});
process.on("uncaughtException", (e) => {
  LOG(`FATAL uncaughtException: ${e?.stack || e}`);
  releaseLock();
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  LOG(`FATAL unhandledRejection: ${e?.stack || e}`);
  releaseLock();
  process.exit(1);
});
var POLL_TIMEOUT_S = 50;
async function freeLongPoll() {
  try {
    const subs = await call("GET", "/subscriptions", {}, 1e4);
    const list = Array.isArray(subs?.subscriptions) ? subs.subscriptions : [];
    for (const s of list) {
      if (s?.url) {
        try {
          await call("DELETE", "/subscriptions", { query: { url: s.url } }, 1e4);
          LOG(`removed webhook ${s.url}`);
        } catch {}
      }
    }
  } catch (e) {
    LOG(`subscriptions check: ${e.message}`);
  }
}
async function main() {
  acquireLock();
  LOG(`starting v${VERSION}. base=${BASE} state=${STATE_DIR} marker=${marker ?? "\u2014"}`);
  status.lastPollOk = new Date().toISOString();
  status.marker = marker ?? null;
  writeStatus();
  try {
    const me = await call("GET", "/me", {}, 15000);
    LOG(`authed as bot @${me?.username ?? me?.name ?? "?"} (id ${me?.user_id ?? "?"})`);
  } catch (e) {
    if (e instanceof MaxError && e.status === 401) {
      LOG("FATAL 401: bad MAX token");
      releaseLock();
      process.exit(1);
    }
    LOG(`/me check failed (continuing): ${e.message}`);
  }
  await freeLongPoll();
  registerCommands().catch(() => {});
  setInterval(() => {
    pumpOutbox().catch((e) => LOG(`outbox pump: ${e.message}`));
  }, 400);
  setInterval(() => {
    try {
      const p = detectPrompt();
      if (!p) {
        promptFp = "";
        promptSeen = 0;
        return;
      }
      if (p.fp === promptFp)
        promptSeen++;
      else {
        promptFp = p.fp;
        promptSeen = 1;
      }
      if (promptSeen === 2 && alertedFp !== p.fp) {
        alertedFp = p.fp;
        relayPrompt(p);
      }
    } catch (e) {
      LOG(`prompt watcher: ${e.message}`);
    }
  }, PROMPT_POLL_MS);
  setInterval(() => {
    const now = Date.now();
    for (const [chat, started] of typingChats) {
      if (now - started > TYPING_MAX_MS) {
        typingChats.delete(chat);
        continue;
      }
      sendAction(chat, "typing_on").catch(() => {});
    }
  }, 4500);
  setInterval(() => {
    writeStatus();
    const age = Date.now() - new Date(status.lastPollOk).getTime();
    if (age > STALE_MS) {
      LOG(`FATAL: no successful poll in ${Math.round(age / 1000)}s \u2014 wedged. exiting for supervisor restart.`);
      releaseLock();
      process.exit(1);
    }
    checkBrain();
    cleanupRes();
  }, 15000);
  while (running) {
    try {
      const q = { timeout: POLL_TIMEOUT_S, limit: 100, types: UPDATE_TYPES };
      if (marker != null)
        q.marker = marker;
      const res = await call("GET", "/updates", { query: q }, (POLL_TIMEOUT_S + 15) * 1000);
      netBackoff = 1000;
      status.lastPollOk = new Date().toISOString();
      for (const u of res?.updates ?? []) {
        await handleUpdate(u);
        status.updatesSeen++;
        status.lastInbound = new Date().toISOString();
      }
      if (res?.marker != null) {
        marker = res.marker;
        status.marker = marker;
        saveMarker();
      }
    } catch (e) {
      status.lastError = `${new Date().toISOString()} ${e.message}`;
      if (e instanceof MaxError && e.status === 401) {
        LOG("FATAL 401 Unauthorized: bad token");
        releaseLock();
        process.exit(1);
      }
      LOG(`poll error: ${e.message}. backoff ${netBackoff / 1000}s`);
      await sleep(netBackoff);
      netBackoff = Math.min(netBackoff * 2, 60000);
    }
  }
  saveMarker();
  writeStatus();
  releaseLock();
  LOG("stopped");
  process.exit(0);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function writeEnvFile(kv) {
  const existing = {};
  try {
    for (const line of readFileSync(CONFIG_ENV_FILE, "utf8").split(`
`)) {
      const s = line.trim();
      if (s && !s.startsWith("#") && s.includes("=")) {
        const i = s.indexOf("=");
        existing[s.slice(0, i).trim()] = s.slice(i + 1).trim();
      }
    }
  } catch {}
  const merged = { ...existing, ...kv };
  const body = "# max-gateway config (written by `pair`). Keep private \u2014 contains the bot token.\n" + Object.entries(merged).map(([k, v]) => `${k}=${v}`).join(`
`) + `
`;
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = CONFIG_ENV_FILE + ".tmp";
  writeFileSync(tmp, body, { mode: 384 });
  renameSync(tmp, CONFIG_ENV_FILE);
}
async function pairMode() {
  process.stderr.write(`
[pair] \u041E\u0442\u043A\u0440\u043E\u0439 MAX, \u043D\u0430\u0439\u0434\u0438 \u0441\u0432\u043E\u0435\u0433\u043E \u0431\u043E\u0442\u0430 \u0438 \u043D\u0430\u0436\u043C\u0438 \xAB\u0421\u0442\u0430\u0440\u0442\xBB (\u0438\u043B\u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u044C \u043B\u044E\u0431\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435).
[pair] \u0416\u0434\u0443 \u0434\u043E 5 \u043C\u0438\u043D\u0443\u0442...

`);
  await freeLongPoll();
  let m;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    let res;
    try {
      const q = { timeout: 25, limit: 100, types: UPDATE_TYPES };
      if (m != null)
        q.marker = m;
      res = await call("GET", "/updates", { query: q }, 40000);
    } catch (e) {
      process.stderr.write(`[pair] \u043E\u043F\u0440\u043E\u0441 \u043D\u0435 \u0443\u0434\u0430\u043B\u0441\u044F: ${e.message}
`);
      await sleep(2000);
      continue;
    }
    for (const u of res?.updates ?? []) {
      const sender = u.update_type === "bot_started" ? u.user : u.message?.sender;
      const chatId = u.update_type === "bot_started" ? u.chat_id : u.message?.recipient?.chat_id;
      if (!sender?.user_id || chatId == null)
        continue;
      const uid = String(sender.user_id), cid = String(chatId);
      const who = userName(sender);
      writeEnvFile({ MAX_BOT_TOKEN: TOKEN, MAX_SYS_ADMINS: uid, MAX_ALLOWED_CHATS: cid });
      try {
        await call("POST", "/messages", { query: { chat_id: cid }, body: { text: "\u2705 \u0421\u043F\u0430\u0440\u0435\u043D\u043E. \u042D\u0442\u043E\u0442 \u0447\u0430\u0442 \u0443\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442 \u0442\u0432\u043E\u0438\u043C Claude; \u0434\u043B\u044F \u043E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0445 \u0431\u043E\u0442 \u0437\u0430\u043A\u0440\u044B\u0442.", notify: true } });
      } catch {}
      process.stderr.write(`[pair] OK \u2014 user_id=${uid}, chat_id=${cid} (${who}), \u043A\u043E\u043D\u0444\u0438\u0433 \u0437\u0430\u043F\u0438\u0441\u0430\u043D: ${CONFIG_ENV_FILE}
`);
      process.exit(0);
    }
    if (res?.marker != null)
      m = res.marker;
  }
  process.stderr.write(`[pair] \u0422\u0430\u0439\u043C\u0430\u0443\u0442: \u0437\u0430 5 \u043C\u0438\u043D\u0443\u0442 \u043D\u0435 \u043F\u0440\u0438\u0448\u043B\u043E \u043D\u0438 \u043E\u0434\u043D\u043E\u0433\u043E \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F. \u0417\u0430\u043F\u0443\u0441\u0442\u0438 setup \u0435\u0449\u0451 \u0440\u0430\u0437.
`);
  process.exit(1);
}
var MODE = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (MODE === "pair" || MODE === "setup")
  pairMode();
else
  main();
