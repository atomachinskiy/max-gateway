# max-gateway

Надёжный канал **MAX** (мессенджер от VK) для **Claude Code** — общайся со своим Claude из MAX, как из Telegram. Порт [tg-gateway](https://github.com/atomachinskiy/tg-gateway) на [MAX Bot API](https://dev.max.ru).

Демон (под systemd, всегда жив) держит соединение с MAX; тонкий мост-плагин инжектит входящие в открытую сессию Claude Code, ответы уходят обратно в MAX. Если сессия/мост моргнули — демон буферит входящие, ничего не теряется.

## Возможности

- Робастный long-poll, который **никогда не сдаётся** (в отличие от официального `mcp-max-messenger`, чей poll-луп выходит на первой же сетевой ошибке)
- Входящие: текст, фото (скачивается), голос/аудио (расшифровка через Groq Whisper в транспорте), видео, файлы, нажатия кнопок
- Исходящие: текст с чанкингом, фото/файлы, inline-кнопки, ответ-тред, `send_action` (печатает/прочитано — у ботов MAX нет эмодзи-реакций)
- `ask` — вопрос с вариантами как кнопки, блокирует до ответа
- Командная панель `/menu /ping /status /screen /restart /logs /model /mcp` + админ-allowlist (для серверного tmux-деплоя)
- PID-lock, watchdog, heartbeat, graceful restart

> **Ставишь через ИИ-ассистента?** Дай своему Claude файл [`AGENTS.md`](AGENTS.md) — это
> пошаговый ранбук установки (создание бота через @MasterBot, pairing, supervisor под
> Linux/macOS/Windows, подключение плагина, проверка, удаление). Он разберётся сам.

## Быстрый старт (сервер, bun + systemd)

1. **Создай бота в MAX** через **@MasterBot** (аналог BotFather): `/newbot` → имя → username → получишь токен.
2. Положи токен и спарься (захватит твой user_id + chat_id в `gateway.env`):
   ```bash
   MAX_BOT_TOKEN="<токен>" MAX_STATE_DIR="$HOME/.claude/channels/max-claude5" \
     bun gateway/gateway.ts pair
   # открой MAX, нажми боту «Старт»
   ```
3. Подними демон под systemd:
   ```bash
   cp systemd/max-gateway.service ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now max-gateway
   ```
4. Подключи мост в Claude Code:
   ```bash
   claude plugin marketplace add "$PWD/bridge"
   claude plugin install max@max-local
   # allowlist через managed-settings (без dev-промпта):
   # /etc/claude-code/managed-settings.json -> allowedChannelPlugins += {marketplace:"max-local", plugin:"max"}
   claude --channels plugin:max@max-local
   ```
5. Напиши боту в MAX — сообщение появится в сессии, ответ придёт назад. `/menu` — панель управления.

## Сборка

`bash scripts/build.sh` (нужен bun) пересобирает `gateway/dist/gateway.js` + `bridge/dist/bridge.js`.

## Конфиг (env / gateway.env)

| Переменная | Что |
|---|---|
| `MAX_BOT_TOKEN` | токен бота (или `~/.claude/secrets/max-bot-token`) |
| `MAX_STATE_DIR` | каталог state (по умолч. `~/.claude/channels/max-claude5`) |
| `MAX_SYS_ADMINS` | user_id владельца(ев) панели управления |
| `MAX_ALLOWED_CHATS` | chat_id, которым открыт бот (`*` = всем) |
| `MAX_API_BASE` | база API (по умолч. `https://botapi.max.ru`) |
| `CLAUDE5_TMUX` / `SYS_RESTART_CMD` | сессия tmux и скрипт рестарта (для `/restart`) |

См. `DESIGN.md` для архитектуры и отличий от Telegram.
