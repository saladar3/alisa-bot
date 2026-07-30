# Алиса — ассистентка Валерии Майкиной (Telegram-бот)

Бот-ассистентка для записи клиентов на консультации. Long-polling, DeepSeek, память диалогов в S3.

## Запуск локально
```
TELEGRAM_BOT_TOKEN=... DEEPSEEK_API_KEY=... VALERIA_CHAT_ID=... S3_KEY_ID=... S3_SECRET=... node alisa.js
```

## Переменные окружения
- `TELEGRAM_BOT_TOKEN` — токен от @BotFather
- `DEEPSEEK_API_KEY` — ключ DeepSeek
- `VALERIA_CHAT_ID` — числовой chat_id Валерии
- `S3_KEY_ID`, `S3_SECRET` — ключи Object Storage Яндекса
- `S3_BUCKET` — по умолчанию `maykina-results`

## Деплой
Подходит любой хостинг с постоянным процессом (background worker):
- **Koyeb** (бесплатный tier) — рекомендовано
- Яндекс Compute VM (~500₽/мес) — максимально надёжно
- Railway, VPS

Команда запуска: `node alisa.js`
Build (если нужно): `npm install`

## Команды для Валерии (обучение)
- просто написать текст → Алиса запоминает как правило
- `/знания` — показать, что запомнила
- `/забыть` — очистить базу знаний
