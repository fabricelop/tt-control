const REPO = process.env.GITHUB_REPO || "fabricelop/europapress-rss";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const QUEUE_PATH = "telegram/requests.json";

function b64decode(s) {
  return Buffer.from((s || "").replace(/\n/g, ""), "base64").toString("utf8");
}

function b64encode(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

async function telegram(method, payload = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
  return data.result;
}

async function gh(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  const r = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "ttittulares-telegram-webhook",
      ...(options.headers || {}),
    },
  });
  return r;
}

async function appendRequest(request) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const get = await gh(`contents/${QUEUE_PATH}?ref=${encodeURIComponent(BRANCH)}`);
    if (!get.ok) throw new Error(`GitHub GET queue: ${get.status} ${await get.text()}`);
    const file = await get.json();
    const queue = JSON.parse(b64decode(file.content) || '{"requests":[]}');
    queue.requests ||= [];

    if (queue.requests.some((r) => r.update_id === request.update_id)) return false;
    if (request.dedupe_text && queue.requests.some((r) => r.type === request.type && r.text === request.text)) return false;

    const stored = { ...request };
    delete stored.dedupe_text;
    queue.requests.push(stored);
    queue.requests = queue.requests.slice(-100);
    const content = JSON.stringify(queue) + "\n";

    const put = await gh(`contents/${QUEUE_PATH}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Procesar orden de Telegram por webhook",
        content: b64encode(content),
        sha: file.sha,
        branch: BRANCH,
      }),
    });
    if (put.ok) return true;
    if (![409, 422].includes(put.status)) throw new Error(`GitHub PUT queue: ${put.status} ${await put.text()}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 150));
  }
  throw new Error("No se pudo guardar la orden de Telegram tras varios reintentos");
}

async function safeTelegram(method, payload) {
  try {
    return await telegram(method, payload);
  } catch (e) {
    console.error(e);
    return null;
  }
}

function requestObj(update, type, text, dedupe_text = false) {
  return {
    update_id: update.update_id,
    created_at: new Date().toISOString(),
    type,
    text,
    dedupe_text,
  };
}

export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "ttittulares-telegram-webhook" });
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const received = req.headers["x-telegram-bot-api-secret-token"];
  if (!expected || received !== expected) return res.status(401).json({ ok: false });

  const update = req.body || {};
  const allowedChat = String(process.env.TELEGRAM_CHAT_ID || "");

  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      const msg = cq.message || {};
      const chatId = String((msg.chat || {}).id || "");
      if (chatId !== allowedChat) return res.status(200).json({ ok: true });

      const data = cq.data || "";
      if (data === "delete:message") {
        await safeTelegram("answerCallbackQuery", { callback_query_id: cq.id, text: "🗑️ Quitado." });
        await telegram("deleteMessage", { chat_id: allowedChat, message_id: msg.message_id });
      } else if (data.startsWith("prepare:")) {
        const original = msg.text || "";
        const match = original.match(/^N\d+\.\s*(.+)$/m);
        const headline = (match ? match[1] : original).trim();
        if (headline) {
          await appendRequest(requestObj(update, "prepare", `Prepara la noticia: ${headline}`, true));
          await safeTelegram("answerCallbackQuery", { callback_query_id: cq.id, text: "✅ Añadida para preparar." });
          await safeTelegram("deleteMessage", { chat_id: allowedChat, message_id: msg.message_id });
        } else {
          await safeTelegram("answerCallbackQuery", { callback_query_id: cq.id, text: "No he podido recuperar el texto de la noticia." });
        }
      } else if (data === "run:bulletin") {
        await appendRequest(requestObj(update, "run", "Ejecuta ahora un boletín manual de TTiTTulares.", true));
        await safeTelegram("answerCallbackQuery", { callback_query_id: cq.id, text: "✅ Solicitud de boletín registrada." });
      } else {
        await safeTelegram("answerCallbackQuery", { callback_query_id: cq.id });
      }
      return res.status(200).json({ ok: true });
    }

    const message = update.message || {};
    const chatId = String((message.chat || {}).id || "");
    if (chatId !== allowedChat) return res.status(200).json({ ok: true });
    const text = (message.text || "").trim();
    if (!text) return res.status(200).json({ ok: true });

    const first = text.split(/\s+/)[0].toLowerCase();
    if (first === "/boletin") {
      const added = await appendRequest(requestObj(update, "run", "Ejecuta ahora un boletín manual de TTiTTulares.", true));
      if (added) await safeTelegram("sendMessage", { chat_id: allowedChat, text: "▶️ Solicitud de boletín registrada." });
    } else if (!text.startsWith("/")) {
      const reply = message.reply_to_message || {};
      const replyText = (reply.text || reply.caption || "").trim();
      const storedText = replyText ? `Instrucción: ${text}\nMensaje al que responde:\n${replyText}` : text;
      const added = await appendRequest(requestObj(update, "instruction", storedText));
      if (added) await safeTelegram("sendMessage", { chat_id: allowedChat, text: "📝 Instrucción guardada para la próxima ejecución." });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
