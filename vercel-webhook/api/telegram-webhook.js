const REPO = process.env.GITHUB_REPO || "fabricelop/europapress-rss";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const NEWS_QUEUE = "telegram/requests.json";
const TRENDS_QUEUE = "trends/requests.json";
const SR_QUEUE = "selorecordamos/requests.json";

function b64decode(s) { return Buffer.from((s || "").replace(/\n/g, ""), "base64").toString("utf8"); }
function b64encode(s) { return Buffer.from(s, "utf8").toString("base64"); }

async function telegram(method, payload = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
  return data.result;
}

async function gh(path, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  return fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "ttittulares-telegram-webhook",
      ...(options.headers || {}),
    },
  });
}

async function appendRequest(request, queuePath = NEWS_QUEUE) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const get = await gh(`contents/${queuePath}?ref=${encodeURIComponent(BRANCH)}`);
    if (!get.ok) throw new Error(`GitHub GET queue ${queuePath}: ${get.status} ${await get.text()}`);
    const file = await get.json();
    const queue = JSON.parse(b64decode(file.content) || '{"requests":[]}');
    queue.requests ||= [];
    if (queue.requests.some((r) => r.update_id === request.update_id)) return false;
    if (request.dedupe_text && queue.requests.some((r) => r.type === request.type && r.text === request.text)) return false;
    const stored = { ...request };
    delete stored.dedupe_text;
    queue.requests.push(stored);
    queue.requests = queue.requests.slice(-100);
    const put = await gh(`contents/${queuePath}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: queuePath === TRENDS_QUEUE
          ? "Procesar orden TTendencias por webhook"
          : queuePath === SR_QUEUE
            ? "Procesar orden SeLoRecordamos por webhook"
            : "Procesar orden de Telegram por webhook",
        content: b64encode(JSON.stringify(queue) + "\n"), sha: file.sha, branch: BRANCH,
      }),
    });
    if (put.ok) return true;
    if (![409, 422].includes(put.status)) throw new Error(`GitHub PUT queue: ${put.status} ${await put.text()}`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 150));
  }
  throw new Error("No se pudo guardar la orden de Telegram tras varios reintentos");
}

async function fetchCandidate(id) {
  if (!/^\d+$/.test(String(id || ""))) return null;
  const get = await gh(`contents/selorecordamos/candidates/${id}.json?ref=${encodeURIComponent(BRANCH)}`);
  if (!get.ok) return null;
  const file = await get.json();
  return JSON.parse(b64decode(file.content));
}

async function safeTelegram(method, payload) {
  try { return await telegram(method, payload); }
  catch (e) { console.error(e); return null; }
}

function requestObj(update, type, text, dedupe_text = false) {
  return { update_id: update.update_id, created_at: new Date().toISOString(), type, text, dedupe_text };
}

function isTrendMessage(text) {
  return /\bTTENDENCIA\b/i.test(text || "") || /^[🔵🟢🟣🟠🔴🟡🟤⚪]\s*T\d+\b/u.test(text || "");
}

function extractPreparedHeadline(original, data) {
  const requestedId = String(data || "").split(":", 2)[1] || "";
  if (requestedId) {
    const escaped = requestedId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exact = original.match(new RegExp(`^${escaped}\\.\\s*(.+)$`, "m"));
    if (exact) return exact[1].trim();
  }
  const fallback = original.match(/^N\d+\.\s*(.+)$/m);
  return (fallback ? fallback[1] : original).trim();
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

      if (data.startsWith("sr:evaluate:")) {
        const tweetId = data.split(":")[2] || "";
        const candidate = await fetchCandidate(tweetId);
        if (!candidate) {
          await safeTelegram("answerCallbackQuery", { callback_query_id: cq.id, text: "No encuentro este candidato." });
        } else {
          const requestText = [
            "Evalúa este candidato de SeLoRecordamos y propón respuestas fieles al estilo histórico de la cuenta.",
            `Tweet ID: ${candidate.id}`,
            `Usuario: ${candidate.user}`,
            `Texto: ${candidate.text}`,
            `URL: ${candidate.url}`
          ].join("\n");
          await appendRequest(requestObj(update, "evaluate", requestText, true), SR_QUEUE);
          await safeTelegram("answerCallbackQuery", { callback_query_id: cq.id, text: "🧠 Candidato enviado para evaluar." });
          await safeTelegram("deleteMessage", { chat_id: allowedChat, message_id: msg.message_id });
        }
      } else if (data.startsWith("sr:delete:")) {
        await safeTelegram("answerCallbackQuery", { callback_query_id: cq.id, text: "🗑️ Candidato quitado." });
        await telegram("deleteMessage", { chat_id: allowedChat, message_id: msg.message_id });
      } else if (data === "delete:message") {
        await safeTelegram("answerCallbackQuery", { callback_query_id: cq.id, text: "🗑️ Quitado." });
        await telegram("deleteMessage", { chat_id: allowedChat, message_id: msg.message_id });
      } else if (data.startsWith("prepare:")) {
        const original = msg.text || "";
        const headline = extractPreparedHeadline(original, data);
        if (headline) {
          await appendRequest(requestObj(update, "prepare", `Prepara la noticia: ${headline}`, true), NEWS_QUEUE);
          await safeTelegram("answerCallbackQuery", { callback_query_id: cq.id, text: "✅ Añadida para preparar." });
          const valuationCount = (original.match(/^N\d+\.\s+/gm) || []).length;
          if (valuationCount <= 1) {
            await safeTelegram("deleteMessage", { chat_id: allowedChat, message_id: msg.message_id });
          }
        }
      } else if (data === "run:bulletin") {
        await appendRequest(requestObj(update, "run", "Ejecuta ahora un boletín manual de TTiTTulares.", true), NEWS_QUEUE);
        await safeTelegram("answerCallbackQuery", { callback_query_id: cq.id, text: "✅ Solicitud de boletín registrada." });
      } else if (data === "run:trends") {
        await appendRequest(requestObj(update, "run", "Ejecuta ahora TTendencias.", true), TRENDS_QUEUE);
        await safeTelegram("answerCallbackQuery", { callback_query_id: cq.id, text: "✅ Solicitud TTendencias registrada." });
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
    const normalized = text.toLocaleLowerCase("es-ES").replace(/[.!]+$/g, "").trim();
    const first = text.split(/\s+/)[0].toLowerCase();
    const isNewsRun = first === "/boletin" || normalized === "ejecuta" || normalized === "ejecutar" || normalized === "ejecuta boletín" || normalized === "ejecuta boletin";
    const isTrendsRun = first === "/tendencias" || normalized === "ejecuta tendencias" || normalized === "ejecuta ttendencias";
    if (isTrendsRun) {
      const added = await appendRequest(requestObj(update, "run", "Ejecuta ahora TTendencias.", true), TRENDS_QUEUE);
      if (added) await safeTelegram("sendMessage", { chat_id: allowedChat, text: "▶️ Solicitud TTendencias registrada." });
    } else if (isNewsRun) {
      const added = await appendRequest(requestObj(update, "run", "Ejecuta ahora un boletín manual de TTiTTulares.", true), NEWS_QUEUE);
      if (added) await safeTelegram("sendMessage", { chat_id: allowedChat, text: "▶️ Solicitud de boletín registrada." });
    } else if (!text.startsWith("/")) {
      const reply = message.reply_to_message || {};
      const replyText = (reply.text || reply.caption || "").trim();
      const storedText = replyText ? `Instrucción: ${text}\nMensaje al que responde:\n${replyText}` : text;
      const queuePath = replyText && isTrendMessage(replyText) ? TRENDS_QUEUE : NEWS_QUEUE;
      const added = await appendRequest(requestObj(update, "instruction", storedText), queuePath);
      if (added) await safeTelegram("sendMessage", {
        chat_id: allowedChat,
        text: queuePath === TRENDS_QUEUE ? "🟣 Instrucción TTendencias guardada." : "📝 Instrucción guardada para la próxima ejecución.",
      });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
