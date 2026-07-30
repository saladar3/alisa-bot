/*
 * АЛИСА — ассистентка Валерии Майкиной. Telegram-бот.
 * Версия для постоянного хостинга (Render/Railway/VPS).
 *
 * Как работает: процесс крутится 24/7, постоянно опрашивает Telegram (long polling),
 * обрабатывает сообщения через DeepSeek, отвечает клиентам, пересылает Валерии.
 * Память диалогов — в Object Storage Яндекса (S3).
 *
 * Переменные окружения:
 *  TELEGRAM_BOT_TOKEN   — токен от @BotFather
 *  DEEPSEEK_API_KEY     — ключ DeepSeek
 *  VALERIA_CHAT_ID      — числовой chat_id Валерии
 *  S3_KEY_ID, S3_SECRET — ключи Object Storage Яндекса
 *  S3_BUCKET            — по умолчанию maykina-results
 */

const crypto = require("crypto");
const http = require("http");

// ===== HTTP-сервер на порту (нужен Render, чтобы считать сервис «живым») =====
// Render требует, чтобы Web Service слушал порт. Бот — фоновый процесс, поэтому
// поднимаем минимальный сервер: он просто отвечает 200 на любые запросы.
const PORT = process.env.PORT || 10000;
const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Алиса работает");
});
healthServer.listen(PORT, () => console.log("HTTP health-сервер слушает порт " + PORT));

// ===== Keep-alive: пингуем сами себя, чтобы бесплатный Render не усыплял сервис =====
const SELF_URL = process.env.RENDER_EXTERNAL_URL || "https://alisa-bot-56hg.onrender.com";
setInterval(() => {
  fetch(SELF_URL + "/").then(() => {}).catch(() => {});
}, 5 * 60 * 1000); // каждые 5 минут

const S3_ENDPOINT = "storage.yandexcloud.net";
const S3_REGION = "ru-central1";
const S3_BUCKET = process.env.S3_BUCKET || "maykina-results";
const TG_API = (token) => `https://api.telegram.org/bot${token}`;
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

// Кэш базы знаний (то, чему Алиса научилась от Валерии). Подгружается при старте.
let aliceKnowledgeText = "";

const VALERIA_NAME = "Валерия Майкина";
const VALERIA_PHONE = "+79604440677";
const PRICE_SINGLE = 7000;
const PRICE_PACK = 20000;
const HISTORY_LIMIT = 12;

// Long polling: как долго ждать новое сообщение в одном запросе (сек).
const LONG_POLL_TIMEOUT = 25;

// ===== Запуск постоянного цикла опроса =====
let running = true;

async function pollLoop() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("Нет TELEGRAM_BOT_TOKEN");
    return;
  }

  let offset = await loadOffset();
  console.log("Алиса запущена. Начальный offset:", offset);

  // Лок в S3: только ОДИН процесс должен опрашивать Telegram (иначе 409 conflict).
  // На Render при деплое/перезапуске могут одновременно жить старый и новый процесс.
  const lockId = "lock-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  let amOwner = false;

  while (running) {
    // Проверяем/продлеваем лок каждые ~20 сек (через цикл long-poll).
    const lockOk = await tryAcquireLock(lockId);
    if (lockOk) {
      amOwner = true;
    } else if (amOwner) {
      // Лок перехвачен другим процессом — уступаем и завершаемся.
      console.log("Лок перехвачен другим процессом, завершаюсь.");
      process.exit(0);
    }
    try {
      const updates = await getUpdates(token, offset);
      if (updates && updates.length) {
        for (const upd of updates) {
          if (upd.update_id + 1 > offset) offset = upd.update_id + 1;
          processUpdate(token, upd).catch((e) => console.error("process error:", (e && e.message) || e));
        }
        await saveOffset(offset);
      }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/409/.test(msg)) {
        // Конфликт getUpdates: где-то ещё есть параллельный опрос (часто зомби-процесс
        // от прошлого деплоя). НЕ молотим запросами —Telegram сам закроет старый long-poll
        // через ~25-60 сек. Ждём долго и пробуем снова.
        console.error("409 conflict — жду 60 сек, чтобы старый опрос закрылся");
        await sleep(60000);
      } else {
        console.error("poll error:", msg);
        await sleep(3000);
      }
    }
  }
}

// Запрашиваем обновления у Telegram (long polling).
async function getUpdates(token, offset) {
  const resp = await fetch(TG_API(token) + "/getUpdates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      offset,
      limit: 30,
      timeout: LONG_POLL_TIMEOUT,
      allowed_updates: ["message", "edited_message"]
    })
  });
  if (resp.status === 409) {
    // 409 Conflict: другой процесс тоже зовёт getUpdates (часто при перезапуске Render).
    // Не падаем — отступаем, старый процесс скоро умрёт, и мы продолжим.
    throw new Error("getUpdates 409 conflict");
  }
  if (!resp.ok) throw new Error("getUpdates HTTP " + resp.status);
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) throw new Error("getUpdates not ok");
  return data.result || [];
}

// ===== Обработка одного сообщения =====
async function processUpdate(token, upd) {
  const msg = upd.message || upd.edited_message;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const user = msg.from || {};
  if (!text) return;

  let startPayload = "";
  if (text.startsWith("/start ")) startPayload = text.slice("/start ".length).trim();
  else if (text === "/start") startPayload = "";
  else if (text.startsWith("/")) return;

  const profile = await loadProfile(chatId);
  profile.firstName = user.first_name || profile.firstName || "";
  profile.username = user.username || profile.username || "";
  profile.lastSeen = new Date().toISOString();

  // Если пишет САМА Валерия (её chat_id) — это инструкции/ответы.
  // Алиса УЧИТСЯ: сохраняет это в базу знаний и не ведёт диалог как с клиентом.
  const valeriaId = String(process.env.VALERIA_CHAT_ID || "");
  if (valeriaId && String(chatId) === valeriaId) {
    return handleValeriaMessage(token, chatId, text, profile);
  }

  if (text !== "/start") {
    profile.history = profile.history || [];
    profile.history.push({ role: "user", content: text, ts: Date.now() });
  }

  const isNew = !profile.greeted;
  if (isNew) {
    notifyValeriaNewClient(profile, startPayload).catch(() => {});
    profile.greeted = true;
  }

  // ЧЕЛОВЕЧНОСТЬ: живой человек не отвечает на «понял», «хорошо», «жду», «спасибо».
  // Если реплика — короткое подтверждение/согласие без вопроса и без новой темы —
  // Алиса просто принимает это к сведению и МОЛЧИТ (не «закрывает» диалог ответом).
  if (isClosingAcknowledgement(text)) {
    await saveProfile(chatId, profile);
    return; // ничего не отправляем — как поступил бы человек
  }

  // Показываем «печатает…» сразу, пока DeepSeek готовит ответ.
  sendChatAction(token, chatId, "typing").catch(() => {});

  const reply = await generateAliceReply(profile, text, startPayload);

  profile.history = profile.history || [];
  profile.history.push({ role: "assistant", content: reply, ts: Date.now() });
  if (profile.history.length > HISTORY_LIMIT * 2 + 2) {
    profile.history = profile.history.slice(-HISTORY_LIMIT * 2 - 2);
  }
  await saveProfile(chatId, profile);

  await tgSend(token, chatId, reply);
}

// ===== Генерация ответа через DeepSeek =====
async function generateAliceReply(profile, userText, startPayload) {
  const directAIQuestion = /ты (бот|искусственный интеллект|нейросеть|ии|программа|автомат)|ты настоящий человек|ты живая|ты человек/i.test(userText);
  if (directAIQuestion) {
    return "Я — ассистентка Валерии, помогаю с записью и вопросами. А саму консультацию проводит Валерия, живьём, один на один. Что Вас интересует — подскажу и помогу выбрать удобное время.";
  }

  const needsEscalation = detectEscalation(userText);
  const systemPrompt = buildAliceSystemPrompt(profile, startPayload);

  const messages = [{ role: "system", content: systemPrompt }];
  const recent = (profile.history || []).slice(-HISTORY_LIMIT);
  recent.forEach((m) => messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

  try {
    const reply = await callDeepSeek(messages) || fallbackReply(profile);
    if (needsEscalation) {
      // Реально пишем Валерии (с await — чтобы точно ушло), потом отвечаем клиенту.
      await notifyValeriaEscalation(profile, userText).catch((e) => console.error("notify valeria:", (e && e.message) || e));
      return ensureEscalationNote(normalizeContacts(reply));
    }
    return normalizeContacts(reply);
  } catch (e) {
    console.error("deepseek error:", (e && e.message) || e);
    notifyValeriaEscalation(profile, "Сбой нейросети: " + ((e && e.message) || "ошибка")).catch(() => {});
    return fallbackReply(profile);
  }
}

// ===== Обработка сообщений от САМОЙ Валерии (обучение) =====
// Когда пишет Валерия — это либо ответ на эскалацию, либо новая инструкция/знание.
async function handleValeriaMessage(token, chatId, text, profile) {
  const t = (text || "").trim();
  if (!t) return;

  // Команда /забыть — очищаем базу знаний.
  if (/^\/забыть/i.test(t)) {
    await saveKnowledge({ items: [] });
    await tgSend(token, chatId, "✅ База знаний очищена. Я всё забыла, Валерия.");
    return;
  }

  // Команда /знания — показываем, что Алиса запомнила.
  if (/^\/знания/i.test(t)) {
    const kb = await loadKnowledge();
    if (!kb.items || !kb.items.length) {
      await tgSend(token, chatId, "📭 Моя база знаний пока пуста. Просто напишите мне любой ответ или правило — я запомню.");
    } else {
      const list = kb.items.map((it, i) => (i + 1) + ". " + it.text.slice(0, 200)).join("\n");
      await tgSend(token, chatId, "🧠 Я запомнила (" + kb.items.length + "):\n\n" + list);
    }
    return;
  }

  // Сохраняем сообщение Валерии в базу знаний (учимся).
  await addKnowledge(t);

  // Если был открытый вопрос от клиента (pending) — даём Валерии подсказку.
  await tgSend(token, chatId, "✅ Запомнила, Валерия! Буду использовать это в работе. (Напишите /знания, чтобы посмотреть, что я запомнила.)");
}

function buildAliceSystemPrompt(profile, startPayload) {
  const clientName = profile.firstName || "";
  const nameLine = clientName ? `Имя клиента (обращайся по имени, если уместно, но на «Вы»): ${clientName}.` : "";
  const startLine = startPayload ? `Клиент пришёл по специальной ссылке (например, с сайта после теста). Это уже тёплый контакт — он заинтересовался, можешь мягко раскрыть, чем Валерия ему поможет.` : "";

  // База знаний — то, чему Алиса научилась от Валерии. Подставляем синхронно-кэшированно ниже.
  const knowledgeLine = aliceKnowledgeText || "";

  return `Ты — Алиса, личная ассистентка психолога ${VALERIA_NAME}. Ты общаешься с потенциальными клиентами в Telegram и помогаешь им записаться на консультацию.

ТВОЙ ХАРАКТЕР И ТОН:
- Ты говоришь на «Вы», тепло, по-доброму, но по-деловому. Ты покладистая, ответственная, быстрая и решительная, в меру настойчивая, воспитанная и вежливая.
- Ты пишешь как живой человек: короткими, естественными сообщениями, без канцелярита, без списков-перечислений, без заголовков. Иногда можно лёгкие эмодзи (🌸 ✨ 🙏), но в меру — не в каждом предложении.
- Ты искренне заботишься о человеке и помогаешь ему решиться. Используешь мягкие, ненавязчивые формулировки в духе НЛП: будущее («когда вы поговорите с Валерией, станет гораздо яснее…»), тепло, лёгкая нужда — без давления и агрессивной рекламы.
- НИКОГДА не упоминай, что ты ИИ, нейросеть, модель, что ты «генерируешь ответы» или что-то автоматизировано. Ты — ассистентка. Если человек прямо спросит «ты бот / ты ИИ / ты программа» — отвечай честно и спокойно: ты ассистентка Валерии и помогаешь с записью, а консультацию проводит сама Валерия. Но сама первой про это не говори.

ПРО ВАЛЕРИЮ И КОНСУЛЬТАЦИИ:
- ${VALERIA_NAME} — психолог психоаналитического направления, судьдоаналитик. Работает с тестом Сонди, психосоматикой, травмой и ПТСР, отношениями. Консультации онлайн.
- Форматы онлайн-встречи: WhatsApp, мессенджер MAX, FaceTime — по номеру телефона Валерии ${VALERIA_PHONE} (её можно найти в любом из этих мессенджеров). Либо Zoom (тогда ссылку создаёт бот автоматически).
- Стоимость: разовая консультация — ${PRICE_SINGLE} ₽. Пакет из 4 консультаций — ${PRICE_PACK} ₽ (выгоднее).
- Оплата переводом на номер телефона Валерии ${VALERIA_PHONE} (предпочтительно Озон Банк, но подойдёт любой банк). Можно оплатить и после первой консультации — это нормально, не дави.
- Про «можно оплатить после» клиенту первой не сообщай; упоминай только если он сам спросит про порядок оплаты или если сомневается.

РАСПИСАНИЕ (время всегда по МСК):
- Будние дни: консультации после 17:00.
- Выходные (суббота, воскресенье): после 12:00.
- Предлагай 2–3 конкретных слота, создавая мягкое ощущение, что у Валерии довольно плотный график (например: «свободно в четверг в 18:00 или в пятницу в 19:30, обычно места разбирают быстро»). Но НЕ затягивай и не заставляй ждать — чем раньше запишется, тем лучше, предлагай ближайшие дни.
- Если клиент просит время вне графика (утром в будни и т.п.) — мягко скажи, что уточнишь у Валерии и вернёшься с ответом. Не обещай сам такое время.
- Уточняй часовую зону клиента, если есть сомнения, что он не по МСК.

ПО ЗАПИСИ:
- Веди клиента к записи естественно: узнала запрос → предложила формат → предложила слоты → подтвердила → сообщила реквизиты → договорилась о формате встречи.
- После подтверждения времени — дай реквизиты (номер ${VALERIA_PHONE}, Озон Банк) и уточни формат встречи (WhatsApp / MAX / FaceTime / Zoom). Если выбрали Zoom — скажи, что ссылку пришлёшь ближе к консультации.
- Если у клиента трудности с оплатой или нестандартный вопрос, который ты не можешь решить — скажи, что уточнишь у Валерии и обязательно вернёшься с ответом.

ПРАВИЛО ЧЕСТНОСТИ (очень важно):
- Если ты в чём-то НЕ уверена, не знаешь точный ответ, или вопрос выходит за твои знания/правила — НИКОГДА не выдумывай ответ и не обещай того, чего не сделала. Вместо этого честно скажи клиенту: «Я уточню у Валерии и вернусь к Вам с точным ответом» — и РЕАЛЬНО передай вопрос Валерии. Лучше честно сказать «уточню», чем соврать.
- Если ты обещала «уточнить у Валерии» или «спрошу у Валерии» — значит ты ОБЯЗАНА передать этот вопрос Валерии. Никогда не пиши клиенту «я уже уточнила/спросила», если на самом деле не передавала вопрос. Если ответ от Валерии ещё не пришёл — скажи клиенту правду: «я передала вопрос Валерии, как только она ответит — сразу напишу Вам».

ПРАВИЛО ЧЕЛОВЕЧНОСТИ (очень важно):
- Ты ведёшь себя как ЖИВОЙ человек, а не как служба поддержки, которая обязана ответить на каждое сообщение. Диалог с тобой не должен превращаться в бесконечный пинг-понг «сообщение — ответ».
- Если клиент написал короткое подтверждение или согласие («понял», «хорошо», «жду», «спасибо», «ок», «договорились», «отлично», «звучит хорошо», эмодзи-реакция) и при этом НЕТ нового вопроса или новой темы — НЕ ОТВЕЧАЙ на это. Просто прими к сведению. Живой ассистент тоже не пишет «хорошо, спасибо, что поняли» в ответ на «понял».
- Отвечай только когда есть что сказать по делу: клиент задал вопрос, выбрал опцию, сообщил что-то новое, или сомневается и его нужно мягко подтолкнуть. Не отвечай ради ответа и не закрывай каждое сообщение клиента вежливой фразой.
- Когда всё уже обсуждено и клиент согласился/получил нужное — можно один раз тепло подтвердить и замолчать. Не продолжай диалог искусственно.

${knowledgeLine}

ВАЖНО:
- Не ставь диагнозов, не давай медицинских советов, не обещай лечения. Всё про психологию — мягко, как помощь и сопровождение.
- Не выдумывай фактов про клиента. Опирайся только на то, что он сказал.
- Пиши коротко и живо. Одно сообщение — одна-две мысли. Не лей воду.

${nameLine}
${startLine}

Отвечай естественно, как заботливая ассистентка, и мягко ведите клиента к записи, если он готов.`;
}

function detectEscalation(userText) {
  // Случаи, когда реально нужно спросить Валерию.
  const moneyOrCritical = /скидк|возврат|рассрочк|не могу оплатить|трудност.*оплат|жалоб|возврат.*денег|пожалов|медицинск.*диагноз|срочно.*сейчас|кризис|суицид|не хочу жить/i.test(userText);

  // Настойчивый запрос ВРЕМЕНИ ВНЕ ГРАФИКА (будни до 17:00, или клиент упирается
  // в конкретный ранний час / «только в...», «удобно только», «другое время»).
  // В таких случаях Алиса не решает сама — реально пишет Валерии.
  const offHours = /удобно только|только в \d|только в \d{1,2}:\d{2}|другое время|могу только в|удобнее утром|с утра|утром в|в 9|в 10|в 11|в 12|в 13|в 14|в 15|в 16|до 17|до работы|до обеда|в обед/i.test(userText);

  return Boolean(moneyOrCritical || offHours);
}

// Определяет, что сообщение — короткое «закрывающее» подтверждение, на которое
// живой человек НЕ стал бы отвечать. Важно: не путать с реальным вопросом/темой.
function isClosingAcknowledgement(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[!?.,…]+$/g, "").trim();

  // Слишком длинно — значит не просто «понял», там есть содержание → отвечаем.
  if (t.length > 24) return false;

  // Если есть вопрос или просьба о действии — отвечаем.
  if (/\?|можете|можешь|подскаж|как|когда|где|сколько|хочу|хотел бы|давайте|пришлит|напишит|жду ответ|ответьте/i.test(t)) return false;

  // Слова-подтверждения, согласие, благодарность — на них человек молчит.
  const ack = /^(ок|ok|окей|хорошо|договорились|договорились|понял|поняла|понятно|ясно|принял|спасибо|спс|благодарю|отлично|супер|жду|жду\W|буду ждать|согласен|согласна|да|конечно|обязательно|без проблем|норм|нормально|звучит хорошо|идёт|идет|like|👍|🙏|✅|👌|спасибо большое|всё понятно|все понятно)$/i.test(t);

  return ack;
}

function ensureEscalationNote(reply) {
  if (/уточн.*валери|спрошу.*валери|вернусь.*ответ/i.test(reply)) return reply;
  return reply + "\n\nЕсли потребуется, уточню этот момент у Валерии и вернусь к Вам с ответом.";
}

function normalizeContacts(reply) {
  if (/номер телефона|перевод|реквизит|озон/i.test(reply) && !reply.includes(VALERIA_PHONE)) {
    reply = reply.replace(/(номер телефона Валерии)/i, `$1 ${VALERIA_PHONE}`);
  }
  return reply;
}

function fallbackReply(profile) {
  const name = profile.firstName ? `, ${profile.firstName}` : "";
  return `Добрый день${name}! Я Алиса, ассистентка Валерии Майкиной. Подскажите, пожалуйста, какой вопрос Вас интересует — я помогу с записью или передам Валерии.`;
}

// ===== DeepSeek =====
async function callDeepSeek(messages) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not set");
  const resp = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-chat", messages, temperature: 0.8, max_tokens: 700, stream: false })
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error("DeepSeek " + resp.status + " " + t.slice(0, 200));
  }
  const data = await resp.json().catch(() => ({}));
  return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

// ===== Уведомления Валерии =====
async function notifyValeriaNewClient(profile, startPayload) {
  const valeriaId = process.env.VALERIA_CHAT_ID;
  if (!valeriaId) return;
  const name = profile.firstName || "без имени";
  const uname = profile.username ? " @" + profile.username : "";
  const src = startPayload ? "пришёл по ссылке с сайта" : "написал сам";
  const text = `🌸 Новый клиент!\nИмя: ${name}${uname}\nИсточник: ${src}`;
  await tgSend(process.env.TELEGRAM_BOT_TOKEN, valeriaId, text);
}

async function notifyValeriaEscalation(profile, userText) {
  const valeriaId = process.env.VALERIA_CHAT_ID;
  if (!valeriaId) return;
  const name = profile.firstName || "без имени";
  const text = `⚠️ Вопрос от клиента «${name}», требуется Ваш ответ:\n\n${(userText || "").slice(0, 800)}`;
  await tgSend(process.env.TELEGRAM_BOT_TOKEN, valeriaId, text);
}

// ===== Telegram =====
async function sendChatAction(token, chatId, action) {
  if (!token || !chatId) return;
  try {
    await fetch(TG_API(token) + "/sendChatAction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: action || "typing" })
    });
  } catch (_) {}
}

async function tgSend(token, chatId, text) {
  if (!token || !chatId) return;
  try {
    await fetch(TG_API(token) + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) })
    });
  } catch (e) {
    console.error("tgSend error:", (e && e.message) || e);
  }
}

// ===== Память (Object Storage / S3) =====
async function loadOffset() {
  try {
    const obj = await s3Request("GET", "alisa/offset.json", null, null);
    if (obj.ok) {
      const d = JSON.parse(await obj.text());
      return d.offset || 0;
    }
  } catch (_) {}
  return 0;
}

async function saveOffset(offset) {
  try {
    await s3Request("PUT", "alisa/offset.json", JSON.stringify({ offset }), null);
  } catch (e) {
    console.error("saveOffset:", (e && e.message) || e);
  }
}

// ===== База знаний (чему Алиса научилась от Валерии) =====
async function loadKnowledge() {
  try {
    const obj = await s3Request("GET", "alisa/knowledge.json", null, null);
    if (obj.ok) return JSON.parse(await obj.text());
  } catch (_) {}
  return { items: [] };
}

async function saveKnowledge(kb) {
  try {
    kb.updatedAt = new Date().toISOString();
    await s3Request("PUT", "alisa/knowledge.json", JSON.stringify(kb), null);
    // Обновляем кэш текста для промпта.
    rebuildKnowledgeText(kb);
  } catch (e) {
    console.error("saveKnowledge:", (e && e.message) || e);
  }
}

async function addKnowledge(text) {
  const kb = await loadKnowledge();
  kb.items = kb.items || [];
  // Не дублируем идентичные.
  const exists = kb.items.some((it) => it.text === text);
  if (!exists) {
    kb.items.push({ text, ts: Date.now() });
    // Держим максимум 50 записей — старые удаляем.
    if (kb.items.length > 50) kb.items = kb.items.slice(-50);
  }
  await saveKnowledge(kb);
}

function rebuildKnowledgeText(kb) {
  const items = (kb && kb.items) || [];
  if (!items.length) {
    aliceKnowledgeText = "";
    return;
  }
  const list = items.map((it, i) => "- " + it.text.replace(/\s+/g, " ").trim().slice(0, 300)).join("\n");
  aliceKnowledgeText = "ЧТО МНЕ УЖЕ СООБЩИЛА ВАЛЕРИЯ (учитывай это при ответах клиентам, это её правила и уточнения):\n" + list;
}

// Загружаем базу знаний в кэш при старте.
async function initKnowledge() {
  const kb = await loadKnowledge();
  rebuildKnowledgeText(kb);
  console.log("База знаний загружена, записей:", (kb.items || []).length);
}

// ===== Лок на опрос Telegram (чтобы работал только один процесс) =====
const LOCK_KEY = "alisa/poll.lock";
const LOCK_TTL_MS = 60 * 1000; // лок считается живым 60 сек

// Пытаемся стать «владельцем» опроса. Возвращаем true, если мы владелец.
async function tryAcquireLock(myId) {
  const now = Date.now();
  let current = null;
  try {
    const obj = await s3Request("GET", LOCK_KEY, null, null);
    if (obj.ok) current = JSON.parse(await obj.text());
  } catch (_) {}

  // Если есть живой владелец и это не мы — уступаем.
  if (current && current.id !== myId && (now - current.ts) < LOCK_TTL_MS) {
    return false;
  }
  // Захватываем/продлеваем лок.
  try {
    await s3Request("PUT", LOCK_KEY, JSON.stringify({ id: myId, ts: now }), null);
    return true;
  } catch (e) {
    console.error("lock error:", (e && e.message) || e);
    return current && current.id === myId; // если не смогли записать — остаёмся владельцем только если уже были
  }
}

async function loadProfile(chatId) {
  try {
    const obj = await s3Request("GET", "alisa/tg_" + chatId + ".json", null, null);
    if (obj.ok) return JSON.parse(await obj.text());
  } catch (_) {}
  return { chatId: String(chatId), history: [], booking: {} };
}

async function saveProfile(chatId, profile) {
  profile.chatId = String(chatId);
  profile.updatedAt = new Date().toISOString();
  await s3Request("PUT", "alisa/tg_" + chatId + ".json", JSON.stringify(profile), null);
}

// ===== S3 (SigV4) =====
function sha256hex(data) { return crypto.createHash("sha256").update(data, "utf8").digest("hex"); }
function hmac(key, data) { return crypto.createHmac("sha256", key).update(data, "utf8").digest(); }

async function s3Request(method, key, body, queryParams) {
  const keyId = process.env.S3_KEY_ID;
  const secret = process.env.S3_SECRET;
  if (!keyId || !secret) throw new Error("S3 credentials not set");

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const encPath = key ? "/" + key.split("/").map(encodeURIComponent).join("/") : "";
  const canonicalUri = "/" + S3_BUCKET + encPath;
  const qp = queryParams || {};
  const canonicalQuery = Object.keys(qp).sort().map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(qp[k])).join("&");
  const payloadStr = body || "";
  const payloadHash = sha256hex(payloadStr);
  const hasBody = method === "PUT";

  const headersToSign = {};
  if (hasBody) headersToSign["content-type"] = "application/json";
  headersToSign["host"] = S3_ENDPOINT;
  headersToSign["x-amz-content-sha256"] = payloadHash;
  headersToSign["x-amz-date"] = amzDate;

  const sortedNames = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedNames.map((h) => h + ":" + headersToSign[h] + "\n").join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = dateStamp + "/" + S3_REGION + "/s3/aws4_request";
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  let signingKey = hmac("AWS4" + secret, dateStamp);
  signingKey = hmac(signingKey, S3_REGION);
  signingKey = hmac(signingKey, "s3");
  signingKey = hmac(signingKey, "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const authorization = "AWS4-HMAC-SHA256 Credential=" + keyId + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
  const url = "https://" + S3_ENDPOINT + canonicalUri + (canonicalQuery ? "?" + canonicalQuery : "");
  const fetchHeaders = { "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, "Authorization": authorization };
  if (hasBody) fetchHeaders["Content-Type"] = "application/json";

  return fetch(url, { method, headers: fetchHeaders, body: hasBody ? payloadStr : undefined });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ===== Запуск =====
initKnowledge().finally(() => pollLoop().catch((e) => console.error("fatal:", e)));

// Корректная остановка.
process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; process.exit(0); });
