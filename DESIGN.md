# max-gateway — стабильный канал MAX (мессенджер от VK) для Claude Code

Дата: 2026-06-24 · Автор: server-claude5 (по запросу Андрея) · Статус: MVP собран, ждёт боевой токен
Порт архитектуры [tg-gateway](https://github.com/atomachinskiy/tg-gateway) на MAX Bot API.

## 1. Зачем

MAX — национальный мессенджер РФ от VK (обязателен к предустановке с сентября 2025, рекомендован Минцифры госорганам). Нужен такой же надёжный канал «общаюсь со своим Claude Code из MAX», как у нас на Telegram.

Готовый `mcp-max-messenger` (единственный MCP под MAX) держит транспорт ВНУТРИ процесса Claude как MCP-сервер, и его poll-луп на любой `FetchError`/`429`/`5xx` просто **выходит** (`return` в `core/network/polling.ts`) — один сетевой блип убивает канал. Это ровно та хрупкость, от которой мы ушли на TG. Чиним архитектурой, не ретраями.

## 2. Принцип

Разделяем НАДЁЖНОСТЬ ТРАНСПОРТА и ИНТЕГРАЦИЮ с Claude Code. Транспорт — отдельный, всегда живой, под systemd процесс. В сессии Клода — тонкий мост без сети.

## 3. Архитектура (1-в-1 с tg-gateway)

```
MAX Bot API (botapi.max.ru)
   |  GET /updates?marker=&timeout=50 (робастный long-poll)     ^ POST /messages, /answers, /uploads, /chats/{id}/actions
   v                                                            |
+----------------------- max-gateway (демон, systemd Restart=always) --------------+
|  робастный long-poll по marker-курсору: backoff 1..60с, НИКОГДА не сдаёмся        |
|  inbox writer  message_created/bot_started/message_callback -> inbox/<f>.json     |
|  media downloader  attachment.payload.url -> inbox (audio -> Groq STT)            |
|  outbox watcher  outbox/req-*.json -> отправка -> outbox/res/<id>.json            |
|  командная панель /menu /ping /status /screen /restart /logs /model /mcp + admin  |
|  PID-lock · watchdog (STALE 180с) · heartbeat · SIGTERM · 401->exit               |
+----------------------------------------------------------------------------------+
   ^ inbox (читает Claude Code через --channels)        ^ outbox/req  | outbox/res
   |                                                     |             v
+----------------- max-bridge (тонкий MCP-плагин в сессии Клода) ------------------+
|  declares claude/channel; форвардит inbox как notifications/claude/channel       |
|  тулы reply / edit_message / delete_message / send_action / download / ask / status|
|  каждый тул: req в outbox, ждёт res от демона. НИКАКОЙ сети.                       |
+----------------------------------------------------------------------------------+
```

## 4. Чем MAX отличается от Telegram (что переписано)

| | Telegram | MAX |
|---|---|---|
| База | `api.telegram.org/bot<token>` | `botapi.max.ru` (platform-api2 недоступен с дата-центра!) |
| Авторизация | в URL | заголовок `Authorization: <token>` (без `Bearer`) |
| Курсор обновлений | `offset` (update_id+1) | `marker` (возвращается в ответе, передаём обратно) |
| Адресат | один `chat_id` | `chat_id` (диалог/группа) ИЛИ `user_id` |
| Медиа | `file_id` | двухшаговый upload: `POST /uploads?type=` -> POST бинаря -> token |
| Реакции эмодзи | есть | **НЕТ** у ботов -> `POST /chats/{id}/actions` (mark_seen/typing_on) |
| Кнопки | `reply_markup.inline_keyboard` | attachment `{type:'inline_keyboard', payload:{buttons}}` |
| Ответ на тап | `answerCallbackQuery` | `POST /answers?callback_id=` |
| Форматирование | MarkdownV2 (адский эскейп) | plain по умолчанию; опц. `format: markdown\|html` (свой диалект) |

Update-типы MAX: `message_created`, `message_callback`, `bot_started`, `message_edited` (+ membership-события, игнорируем).

## 5. Контракты

inbox JSON: `{ chat_id, message_id(mid), user, user_id, ts, text, reply_to_mid?, callback_data?, image_path?, attachment_file_id?(url), attachment_kind?, attachment_name?, attachment_size? }`
тулы: `reply(chat_id,text,format?,files?,reply_to?,buttons?,disable_notification?)`, `edit_message(message_id,text,format?,buttons?,drop_buttons?)`, `delete_message(message_id)`, `send_action(chat_id,action)`, `download_attachment(file_id) -> path`, `ask(chat_id,question,options) -> {choice,index}`, `status`.
outbox req: `{ id, tool, args }`; res: `{ id, ok, result?, error? }`.

## 6. Почему это убивает режимы отказа

- Падение моста-ребёнка вместе с Клодом: демон независим, systemd поднимает за ~2с.
- Дрейф MCP-линка: мост тривиален; демон держит коннект и буферит inbox, `/mcp` восстанавливает.
- 429 / 5xx / сетевые блипы / abort: демон бэкофит и ПРОДОЛЖАЕТ (в отличие от официального клиента, который тут умирает); даже краш демона чинит systemd.
- Тяжёлая работа Клода: отдельный процесс/cgroup, физически не влияет на транспорт.

## 7. Фазы

- **MVP (готов):** робастный poll + inbox + media + outbox + мост + pairing + командная панель. Собран и протестирован вхолостую (компиляция, реальный 401 с botapi, мост: 7 тулов + форвард inbox). Ждёт боевой токен для live-теста.
- **V1.1:** уточнить upload крупных файлов (Content-Range chunked вместо одного multipart), батч-фото, тонкая настройка MAX-форматирования.
- **V2:** webhook-режим (MAX рекомендует для прода; self-signed запрещён с 25.05.2026 — нужен валидный TLS), упаковка как продукт (install-скрипты под Linux/Mac/Win, как у tg-gateway).

## 8. Что НЕ протестировано без токена

Живой контур poll->inbox и outbox->отправка. Код — верный порт проверенного tg-gateway, формы API — из официального TS-клиента `max-messenger/max-bot-api-client-ts`. Проверяем при подключении бота (`pair`).
