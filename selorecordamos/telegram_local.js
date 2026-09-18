const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const baseDir = __dirname;
const repoDir = path.join(baseDir, '..');
const runtimeDir = path.join(baseDir, 'runtime');
const candidatesDir = path.join(baseDir, 'candidates');
const outboxFile = path.join(baseDir, 'telegram-outbox.json');
const stateFile = path.join(runtimeDir, 'telegram-state.json');
const requestsFile = path.join(baseDir, 'requests.json');
const assistantSentFile = path.join(runtimeDir, 'assistant-output-sent.json');
const outputGroupsFile = path.join(runtimeDir, 'assistant-output-groups.json');
const telegramSentFile = path.join(runtimeDir, 'telegram-sent.json');
const assistantOutputUrl = 'https://raw.githubusercontent.com/fabricelop/europapress-rss/main/selorecordamos/assistant-output.json';
fs.mkdirSync(runtimeDir, { recursive: true });

const token = process.env.SR_TELEGRAM_BOT_TOKEN || '';
const chatId = String(process.env.SR_TELEGRAM_CHAT_ID || '');
if (!token || !chatId) {
  console.error('Faltan SR_TELEGRAM_BOT_TOKEN y/o SR_TELEGRAM_CHAT_ID.');
  process.exit(2);
}
const api = method => `https://api.telegram.org/bot${token}/${method}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function runGit(args) {
  return cp.execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' });
}
function localTime(value) {
  if (!value) return 'hora desconocida';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d).replace(',', '');
}
function shortKey(key) {
  let h = 0;
  for (const ch of String(key)) { h = ((h << 5) - h) + ch.charCodeAt(0); h |= 0; }
  return Math.abs(h).toString(36);
}

async function telegram(method, payload = {}) {
  const r = await fetch(api(method), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
  return data.result;
}
async function safeAnswerCallbackQuery(id, text) {
  try { await telegram('answerCallbackQuery', { callback_query_id: id, text }); }
  catch (e) { if (!/query is too old|query ID is invalid|response timeout expired/i.test(String(e.message || e))) throw e; }
}
async function safeDeleteMessage(messageId) {
  try { await telegram('deleteMessage', { chat_id: chatId, message_id: messageId }); }
  catch (e) { if (!/message to delete not found|message can't be deleted|message identifier is not specified/i.test(String(e.message || e))) throw e; }
}

async function sendOutbox() {
  const data = readJson(outboxFile, { candidates: [] });
  const sent = readJson(telegramSentFile, {});
  let changed = false, index = 1;
  for (const c of data.candidates || []) {
    const id = String(c.id || '');
    if (!id || sent[id]) continue;
    const visible = `🧠 SELORECORDAMOS · SR${index}\n${c.user || ''} · ${localTime(c.datetime)}\n\n${String(c.text || '').trim()}`;
    await telegram('sendMessage', {
      chat_id: chatId, text: visible, disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [
        [{ text: '🔗 Abrir original en X', url: c.url }],
        [{ text: '🧠 Evaluar', callback_data: `sr:evaluate:${id}` }, { text: '🗑️ Borrar', callback_data: `sr:delete:${id}` }]
      ] }
    });
    sent[id] = { sent_at: new Date().toISOString() };
    changed = true; index++;
  }
  if (changed) writeJson(telegramSentFile, sent);
}

function parseAlternatives(item) {
  if (Array.isArray(item.alternatives)) return item.alternatives.map(x => String(x || '').trim()).filter(Boolean).slice(0, 4);
  const text = String(item.telegram_text || item.content || '');
  const matches = [...text.matchAll(/(?:^|\n)([A-D])\)\s*([\s\S]*?)(?=\n\n[A-D]\)|\n\nhttps?:\/\/|$)/g)];
  return matches.map(m => m[2].trim()).slice(0, 4);
}
function findOriginalUrl(item) {
  if (item.original_url) return String(item.original_url);
  const text = String(item.telegram_text || item.content || '');
  const m = text.match(/https:\/\/x\.com\/[^\s]+\/status\/\d+/i);
  if (m) return m[0];
  const id = String(item.request_key || '').match(/^evaluate:(\d+)(?::.*)?$/)?.[1];
  if (id) {
    const q = readJson(requestsFile, { requests: [] });
    const req = (q.requests || []).find(x => String(x.tweet_id || '') === id);
    if (req && req.url) return String(req.url);
  }
  return '';
}
function evaluationHeader(item) {
  const text = String(item.telegram_text || item.content || '').trim().replace(/\n*https:\/\/x\.com\/[^\s]+\/status\/\d+\s*$/i, '').trim();
  const p = text.search(/\n\nPropuestas para CITAR en X:/i);
  if (p >= 0) return text.slice(0, p).trim();
  const a = text.search(/\n\nA\)\s+/);
  if (a >= 0) return text.slice(0, a).trim();
  return text;
}
function readAssistantOutputFromGit() {
  runGit(['fetch', 'origin', 'main', '--quiet']);
  return JSON.parse(runGit(['show', 'origin/main:selorecordamos/assistant-output.json']));
}
async function loadAssistantOutputs() {
  try {
    const r = await fetch(`${assistantOutputUrl}?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) throw new Error(`assistant-output HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.error('Lectura RAW de assistant-output.json falló; usando Git como respaldo:', e.message || e);
    try { return readAssistantOutputFromGit(); }
    catch (g) { throw new Error(`RAW falló (${e.message || e}) y Git fallback falló (${String(g.stderr || g.message || g).trim()})`); }
  }
}
async function sendAssistantOutputs() {
  let data;
  try { data = await loadAssistantOutputs(); }
  catch (e) { console.error('No se pudo leer assistant-output.json:', e.message || e); return; }
  const sent = readJson(assistantSentFile, {});
  const groups = readJson(outputGroupsFile, {});
  let changed = false, groupsChanged = false;
  for (const item of data.outputs || []) {
    const key = String(item.request_key || item.id || '');
    if (!key || sent[key] || item.send_to_telegram === false) continue;
    const alternatives = parseAlternatives(item);
    const originalUrl = findOriginalUrl(item);
    const header = evaluationHeader(item);
    if (!header) continue;
    const groupId = shortKey(key);
    const messageIds = [];
    const headMsg = await telegram('sendMessage', { chat_id: chatId, text: header, disable_web_page_preview: true });
    messageIds.push(headMsg.message_id);
    for (let i = 0; i < alternatives.length; i++) {
      const alt = alternatives[i];
      const letter = String.fromCharCode(65 + i);
      const keyboard = [];
      if (alt.length <= 256) keyboard.push([{ text: `📋 Copiar ${letter}`, copy_text: { text: alt } }]);
      else console.error(`Alternativa ${letter} supera 256 caracteres (${alt.length}).`);
      const m = await telegram('sendMessage', {
        chat_id: chatId, text: `${letter}) ${alt}`, disable_web_page_preview: true,
        reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined
      });
      messageIds.push(m.message_id);
    }
    const footer = [];
    if (originalUrl) footer.push([{ text: '🔗 Abrir original en X', url: originalUrl }]);
    footer.push([{ text: '🗑️ Borrar', callback_data: `sr:outdelete:${groupId}` }]);
    const footMsg = await telegram('sendMessage', { chat_id: chatId, text: 'Acciones:', disable_web_page_preview: true, reply_markup: { inline_keyboard: footer } });
    messageIds.push(footMsg.message_id);
    groups[groupId] = { key, message_ids: messageIds, alternatives, original_url: originalUrl };
    groupsChanged = true;
    sent[key] = { sent_at: new Date().toISOString() };
    changed = true;
  }
  if (changed) writeJson(assistantSentFile, sent);
  if (groupsChanged) writeJson(outputGroupsFile, groups);
}

function gitPushFiles(files, message) {
  try {
    runGit(['add', ...files]);
    const diff = cp.spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: repoDir });
    if (diff.status !== 0) runGit(['commit', '-m', message]);
    try { runGit(['push', 'origin', 'main']); }
    catch (_) { runGit(['pull', '--rebase', '--autostash', 'origin', 'main']); runGit(['push', 'origin', 'main']); }
    console.log('Cambios SLR subidos a GitHub.');
  } catch (e) {
    console.error('No se pudieron subir cambios SLR a GitHub:', String(e.stderr || e.message || e).trim());
  }
}
function gitPushRequest() { gitPushFiles(['selorecordamos/requests.json'], 'Queue SeLoRecordamos request'); }

function candidateFromEvaluationGroup(msg) {
  const messageId = Number(msg && msg.message_id);
  if (!messageId) return null;
  const groups = readJson(outputGroupsFile, {});
  for (const g of Object.values(groups)) {
    if (!g || !Array.isArray(g.message_ids) || !g.message_ids.map(Number).includes(messageId)) continue;
    const key = String(g.key || '');
    const tweetId = key.match(/^evaluate:(\d+)/)?.[1] || '';
    const q = readJson(requestsFile, { requests: [] });
    const req = (q.requests || []).find(x => String(x.tweet_id || '') === tweetId);
    if (req) return { id: tweetId, user: req.user || null, text: req.text || null, url: req.url || g.original_url || null, datetime: req.datetime || null };
    if (tweetId) return { id: tweetId, user: null, text: null, url: g.original_url || null, datetime: null };
  }
  return null;
}
function candidateFromTelegramMessage(msg) {
  const fromGroup = candidateFromEvaluationGroup(msg);
  if (fromGroup) return fromGroup;
  const text = String(msg && msg.text || '');
  const urlMatch = text.match(/https:\/\/x\.com\/([^\s/]+)\/status\/(\d+)/i);
  if (urlMatch) return { id: urlMatch[2], user: '@' + urlMatch[1], url: urlMatch[0], text: '' };
  const header = text.match(/SELORECORDAMOS\s*·\s*SR\d+\s*\n([^\s·]+)[^\n]*\n\n([\s\S]*)/i);
  if (!header) return null;
  const user = header[1];
  const original = header[2].trim();
  const files = fs.existsSync(candidatesDir) ? fs.readdirSync(candidatesDir).filter(x => x.endsWith('.json')) : [];
  for (const file of files) {
    const c = readJson(path.join(candidatesDir, file), null);
    if (c && String(c.user || '') === user && String(c.text || '').trim() === original) return { id: String(c.id), user: c.user, text: c.text, url: c.url, datetime: c.datetime || null };
  }
  return { id: '', user, text: original, url: '', datetime: null };
}

async function pollOnce() {
  const state = readJson(stateFile, { offset: 0 });
  const url = new URL(api('getUpdates'));
  url.searchParams.set('offset', String(state.offset || 0));
  url.searchParams.set('timeout', '25');
  url.searchParams.set('allowed_updates', JSON.stringify(['callback_query', 'message']));
  const r = await fetch(url);
  const data = await r.json();
  if (!data.ok) throw new Error(JSON.stringify(data));
  const queue = readJson(requestsFile, { requests: [] });
  queue.requests ||= [];
  let changed = false;
  for (const update of data.result || []) {
    state.offset = Math.max(Number(state.offset || 0), Number(update.update_id) + 1);
    writeJson(stateFile, state);
    if (update.callback_query) {
      const cq = update.callback_query, msg = cq.message || {};
      if (String((msg.chat || {}).id || '') !== chatId) continue;
      const parts = String(cq.data || '').split(':');
      if (parts[0] !== 'sr' || parts.length < 3) continue;
      const action = parts[1], id = parts[2];
      if (action === 'delete') { await safeAnswerCallbackQuery(cq.id, '🗑️ Candidato quitado.'); await safeDeleteMessage(msg.message_id); continue; }
      if (action === 'msgdelete') { await safeAnswerCallbackQuery(cq.id, '🗑️ Mensaje borrado.'); await safeDeleteMessage(msg.message_id); continue; }
      if (action === 'outdelete') {
        await safeAnswerCallbackQuery(cq.id, '🗑️ Evaluación borrada.');
        const groups = readJson(outputGroupsFile, {}), g = groups[id];
        if (g && Array.isArray(g.message_ids)) { for (const mid of g.message_ids) await safeDeleteMessage(mid); delete groups[id]; writeJson(outputGroupsFile, groups); }
        else await safeDeleteMessage(msg.message_id);
        continue;
      }
      if (action === 'evaluate') {
        const c = readJson(path.join(candidatesDir, `${id}.json`), null);
        if (!c) { await safeAnswerCallbackQuery(cq.id, 'No encuentro este candidato.'); continue; }
        if (!queue.requests.some(x => x.type === 'evaluate' && x.tweet_id === id)) {
          queue.requests.push({ created_at: new Date().toISOString(), type: 'evaluate', tweet_id: id, user: c.user, text: c.text, url: c.url, datetime: c.datetime || null });
          queue.requests = queue.requests.slice(-100); changed = true;
        }
        await safeAnswerCallbackQuery(cq.id, '🧠 Candidato enviado para evaluar.');
        await safeDeleteMessage(msg.message_id);
      }
      continue;
    }
    const msg = update.message;
    if (!msg || String((msg.chat || {}).id || '') !== chatId || !msg.reply_to_message || !String(msg.text || '').trim()) continue;
    const c = candidateFromTelegramMessage(msg.reply_to_message);
    if (!c) { console.log(`Mensaje ${msg.message_id} ignorado: la respuesta no apunta a un candidato/evaluación SLR reconocible.`); continue; }
    const key = String(update.update_id);
    if (!queue.requests.some(x => x.type === 'telegram_instruction' && String(x.telegram_update_id) === key)) {
      queue.requests.push({ created_at: new Date().toISOString(), type: 'telegram_instruction', telegram_update_id: update.update_id, telegram_message_id: msg.message_id, tweet_id: c.id || null, user: c.user || null, text: c.text || null, url: c.url || null, datetime: c.datetime || null, instruction: String(msg.text).trim() });
      queue.requests = queue.requests.slice(-100); changed = true;
      await telegram('sendMessage', {
        chat_id: chatId, text: '✅ Instrucciones enviadas.', reply_to_message_id: msg.message_id, allow_sending_without_reply: true,
        reply_markup: { inline_keyboard: [[{ text: '🗑️ Borrar', callback_data: `sr:msgdelete:${update.update_id}` }]] }
      });
    }
  }
  if (changed) { writeJson(requestsFile, queue); gitPushRequest(); }
  await sendAssistantOutputs();
}
async function pollForever() {
  console.log('SeLoRecordamos Telegram activo. Escuchando botones, instrucciones y salidas...');
  while (true) {
    try { await pollOnce(); }
    catch (e) { console.error('Error escuchando Telegram:', e.message || e); await sleep(3000); }
  }
}

(async () => {
  const mode = process.argv[2] || 'all';
  if (mode === 'send' || mode === 'all') await sendOutbox();
  if (mode === 'poll' || mode === 'all') await pollForever();
})().catch(e => { console.error(e.stack || e); process.exit(1); });
