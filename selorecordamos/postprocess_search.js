const fs = require('fs');
const path = require('path');

const baseDir = __dirname;
const resultsFile = path.join(baseDir, 'debug', 'results.json');
const outboxFile = path.join(baseDir, 'telegram-outbox.json');
const seenFile = path.join(baseDir, 'runtime', 'seen.json');
const stateFile = path.join(baseDir, 'runtime', 'filter-recoveries-state.json');
const candidatesDir = path.join(baseDir, 'candidates');
const recoveriesFile = path.join(baseDir, 'filter-recoveries.json');

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } };
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
const normalize = text => String(text || '').toLocaleLowerCase('es-ES').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

// Caso que sí nos interesa: alguien pide recordar a un tercero que haga algo para él/ella.
// Se limita a verbos de acción en forma de petición para no reabrir usos meramente opinativos
// como «recordarle que X es presidente» o «recordarle que hubo un 14% de inflación».
function isThirdPartyActionRequest(text) {
  const t = normalize(text);
  return /\brecordarle\s+a\s+[^.!?]{1,60}\s+que\s+me\s+(guarde|reserve|compre|traiga|mande|envie|llame|avise|prepare|deje|pase|recoja|lleve|ponga|haga|consiga|saque|busque|aparte|acerque)\b/.test(t);
}

const result = readJson(resultsFile, null);
if (!result) process.exit(0);
const outbox = readJson(outboxFile, { generated_at: result.fetched_at, candidates: [] });
const seen = readJson(seenFile, {});
const recoveryState = readJson(stateFile, { applied: {} });
const recoveries = readJson(recoveriesFile, { tweets: [] });
const promoted = [];

for (const tweet of result.rejected || []) {
  if (!isThirdPartyActionRequest(tweet.text)) continue;
  const candidate = { id: tweet.id, user: tweet.user, text: tweet.text, datetime: tweet.datetime || null, url: tweet.url, first_seen_at: result.fetched_at, status: 'pending' };
  promoted.push(candidate);
  seen[tweet.id] = { first_seen_at: seen[tweet.id]?.first_seen_at || result.fetched_at, url: tweet.url, rejected: false, datetime: tweet.datetime || null };
}
if (promoted.length) {
  const ids = new Set(promoted.map(x => String(x.id)));
  result.rejected = (result.rejected || []).filter(x => !ids.has(String(x.id)));
  result.candidates = [...(result.candidates || []), ...promoted];
}

for (const tweet of recoveries.tweets || []) {
  const id = String(tweet.id || '');
  if (!id || recoveryState.applied[id]) continue;
  const candidate = { ...tweet, first_seen_at: result.fetched_at, status: 'pending' };
  if (!(result.candidates || []).some(x => String(x.id) === id)) result.candidates.push(candidate);
  seen[id] = { first_seen_at: seen[id]?.first_seen_at || result.fetched_at, url: tweet.url, rejected: false, datetime: tweet.datetime || null };
  recoveryState.applied[id] = new Date().toISOString();
}

const unique = new Map();
for (const c of result.candidates || []) unique.set(String(c.id), c);
result.candidates = [...unique.values()];
outbox.generated_at = result.fetched_at;
outbox.candidates = result.candidates;
for (const c of result.candidates) writeJson(path.join(candidatesDir, `${c.id}.json`), c);
if (result.candidates.length) {
  result.status = 'ok';
  result.note = `${result.candidates.length} candidatos nuevos de ${result.extracted} tuits extraídos.`;
}
writeJson(resultsFile, result);
writeJson(outboxFile, outbox);
writeJson(seenFile, seen);
writeJson(stateFile, recoveryState);
