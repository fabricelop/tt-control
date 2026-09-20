// webhook redeploy marker 2026-09-20T15:29+02:00
interface Env { DB: D1Database; AI: Ai; TT_CONTROL_PASSWORD: string; CHATGPT_BRIDGE_TOKEN?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string; TELEGRAM_WEBHOOK_SECRET?: string
  GITHUB_TOKEN?: string }

async function ensureEditorialSchema(env:Env){
  const statements=[
    "CREATE TABLE IF NOT EXISTS drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, news_id INTEGER NOT NULL, base_text TEXT, remate_a TEXT, remate_b TEXT, remate_c TEXT, research TEXT, sources_json TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_news_version ON drafts(news_id,version)",
    "CREATE TABLE IF NOT EXISTS publications (id INTEGER PRIMARY KEY AUTOINCREMENT, news_id INTEGER NOT NULL, draft_id INTEGER, variant TEXT NOT NULL, final_text TEXT NOT NULL, published_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE INDEX IF NOT EXISTS idx_publications_news ON publications(news_id)",
    "CREATE TABLE IF NOT EXISTS media_radar (id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL UNIQUE, title TEXT NOT NULL, url TEXT NOT NULL, source TEXT NOT NULL, sources_json TEXT NOT NULL DEFAULT '[]', source_count INTEGER NOT NULL DEFAULT 1, importance TEXT NOT NULL DEFAULT 'PENDING', reason TEXT, status TEXT NOT NULL DEFAULT 'NEW', first_seen TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE INDEX IF NOT EXISTS idx_media_radar_status ON media_radar(status,last_seen)",
    "CREATE INDEX IF NOT EXISTS idx_news_status_published ON news(status,published_at,id)",
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ]
  for(const sql of statements){try{await env.DB.prepare(sql).run()}catch(e){/* tablas/índices heredados pueden tener esquemas antiguos; no bloquear endpoints existentes */}}
  for(const sql of ["ALTER TABLE news ADD COLUMN processing_error TEXT","ALTER TABLE news ADD COLUMN processing_started_at TEXT","ALTER TABLE news ADD COLUMN processing_finished_at TEXT","ALTER TABLE drafts ADD COLUMN image_url TEXT","ALTER TABLE drafts ADD COLUMN ai_image_base64 TEXT","ALTER TABLE drafts ADD COLUMN image_a_url TEXT","ALTER TABLE drafts ADD COLUMN image_b_url TEXT","ALTER TABLE drafts ADD COLUMN image_c_url TEXT"]){try{await env.DB.prepare(sql).run()}catch(_){}}
}

function protectedNationalPolitics(section:string,title:string):boolean{
  const sec=section.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  const t=title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  if(/(^|[^a-z])(nacional|politica)([^a-z]|$)/.test(sec))return true
  return /\b(gobierno|congreso|senado|moncloa|feijoo|sanchez|abascal|sumar|podemos|pp|psoe|vox)\b/.test(t) && /\b(espana|espanol|gobierno|congreso|senado|moncloa|partido|diputad|ministro|presidente)\w*/.test(t)
}
function radarDecision(section:string,title:string):{admit:boolean;reason:string}{
  if(protectedNationalPolitics(section,title))return {admit:true,reason:'Política nacional: protegida del descarte automático'}
  const s=(section+' '+title).toLowerCase()
  // Deliberately permissive v1: only suppress recurring low-signal local/promotional formats.
  const low=[
    /agenda (cultural|municipal)/,/programa un encuentro/,/abre (el|su) plazo/,
    /visita institucional/,/jornadas? .* programa/,/diputaci[oó]n .* destaca/,
    /ayuntamiento .* (licita|adjudica)/
  ]
  if(low.some(r=>r.test(s)))return {admit:false,reason:'Filtro inicial de baja señal; recuperable y corregible'}
  return {admit:true,reason:'Pasa el filtro inicial permisivo'}
}

function radarTokens(section:string,title:string):string[]{
  const stop=new Set('para por con sin del las los una uno unos unas que como desde hasta sobre entre tras ante este esta estos estas sus han hay más muy pero porque donde cuando quien qué cómo'.split(' '))
  return (section+' '+title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(/[a-z0-9]{3,}/g)?.filter(x=>!stop.has(x))||[]
}
type RadarModel={pos:number;neg:number;pc:Map<string,number>;nc:Map<string,number>}
async function buildRadarModel(env:Env):Promise<RadarModel>{
  const rows=await env.DB.prepare("SELECT title,section,status FROM news WHERE status IN ('DISMISSED','INTERESTING','SELECTED','PROCESSING','READY','PUBLISHED') ORDER BY updated_at DESC LIMIT 1200").all()
  let pos=0,neg=0;const pc=new Map<string,number>(),nc=new Map<string,number>()
  for(const r of rows.results as any[]){const positive=!['DISMISSED','INTERESTING'].includes(r.status);if(r.status==='INTERESTING')continue;positive?pos++:neg++;for(const t of new Set(radarTokens(String(r.section||''),String(r.title||'')))){const m=positive?pc:nc;m.set(t,(m.get(t)||0)+1)}}
  return {pos,neg,pc,nc}
}
function learnedRadar(model:RadarModel,section:string,title:string):{dismiss:boolean;score:number;reason:string}{
  if(protectedNationalPolitics(section,title))return {dismiss:false,score:9,reason:'Política nacional: protegida del descarte automático'}
  const {pos,neg,pc,nc}=model;if(pos<5||neg<20)return {dismiss:false,score:0,reason:'Aprendizaje aún insuficiente'}
  // Learn repeated rejection signals directly. The previous class-normalized score became
  // excessively conservative when negative examples greatly outnumbered positives.
  let score=0,evidence=0,strongNeg=0
  for(const t of new Set(radarTokens(section,title))){
    const p=pc.get(t)||0,n=nc.get(t)||0
    if(p+n<3)continue
    const tokenScore=Math.log((n+1)/(p+1))
    score+=tokenScore;evidence++
    if(n>=3&&n>=3*(p+1))strongNeg++
  }
  const avg=evidence?score/evidence:0
  const dismiss=evidence>=2&&strongNeg>=2&&avg>=0.85
  return {dismiss,score:-avg,reason:dismiss?'Radar aprendido: varios términos repetidamente descartados':'Sin evidencia negativa suficiente'}
}
async function semanticRadar(env:Env,section:string,title:string,statistical:{dismiss:boolean;reason:string}):Promise<{dismiss:boolean;reason:string}>{
  if(protectedNationalPolitics(section,title))return {dismiss:false,reason:'Política nacional: protegida del descarte automático'}
  if(!statistical.dismiss)return statistical
  try{
    const fb=await env.DB.prepare("SELECT f.kind,f.value,n.title FROM editorial_feedback f JOIN news n ON n.id=f.news_id WHERE f.kind IN ('radar_reconsider_reason','dismiss_reason','selection_instruction') AND length(f.value)>2 ORDER BY f.id DESC LIMIT 40").all()
    const examples=(fb.results as any[]).map(x=>'- '+x.kind+': '+String(x.value).slice(0,300)+' | '+String(x.title).slice(0,180)).join('\\n')
    const prompt=`Decide si esta noticia debe ser descartada automáticamente del radar editorial de TTiTTulares España o debe llegar a Entrada para decisión humana. Sé conservador: ante duda, KEEP. Política nacional española, Gobierno, Congreso, Senado, partidos nacionales y asuntos con impacto nacional: siempre KEEP. No confundas que una noticia no admita humor con que carezca de interés. Aprende especialmente de las correcciones del editor.

CORRECCIONES/INSTRUCCIONES RECIENTES DEL EDITOR:
${examples||'(sin comentarios todavía)'}

NOTICIA:
Sección: ${section}
Titular: ${title}

Responde SOLO JSON: {"decision":"KEEP"|"DISCARD","reason":"frase breve"}`
    const out:any=await env.AI.run('@cf/google/gemma-4-26b-a4b-it',{messages:[{role:'system',content:'Eres un clasificador editorial conservador. Devuelve JSON válido y nada más.'},{role:'user',content:prompt}],chat_template_kwargs:{enable_thinking:false}})
    const raw=String(out?.response||out?.choices?.[0]?.message?.content||'').replace(/```json|\`\`\`/g,'').trim();const parsed=JSON.parse(raw)
    const dismiss=String(parsed.decision).toUpperCase()==='DISCARD'
    return {dismiss,reason:'LLM: '+String(parsed.reason|| (dismiss?'descarte semántico':'conservar por interés')).slice(0,300)}
  }catch(e){return {dismiss:false,reason:'LLM no disponible: se conserva para revisión humana'}}
}

async function reclassifyBacklog(env:Env){
  const model=await buildRadarModel(env),q=await env.DB.prepare("SELECT id,title,section FROM news WHERE status='NEW' ORDER BY published_at DESC,id DESC LIMIT 1000").all();let moved=0
  for(const n of q.results as any[]){const d=learnedRadar(model,String(n.section||''),String(n.title||''));if(d.dismiss){const sem=await semanticRadar(env,String(n.section||''),String(n.title||''),d);if(sem.dismiss){const r=await env.DB.prepare("UPDATE news SET status='RADAR_DISMISSED',radar_score=?,radar_reason=?,updated_at=datetime('now') WHERE id=? AND status='NEW'").bind(d.score,sem.reason,n.id).run();moved+=Number(r.meta.changes||0)}}}
  return moved
}
function agentAuthorized(req:Request,env:Env):boolean{
  if(!env.CHATGPT_BRIDGE_TOKEN)return false
  return (req.headers.get('authorization')||'')==='Bearer '+env.CHATGPT_BRIDGE_TOKEN
}
async function telegramApi(env:Env,method:string,body:any){let token=env.TELEGRAM_BOT_TOKEN||'';if(!token){const s:any=await env.DB.prepare("SELECT value FROM app_settings WHERE key='telegram_bot_token'").first();token=String(s?.value||'')}if(!token)return {ok:false,skipped:true,error:'telegram_bot_token ausente'};const r=await fetch('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});let data:any=null;try{data=await r.json()}catch(_){}if(!r.ok||!data?.ok){console.log('Telegram API error',method,r.status,JSON.stringify(data));return {ok:false,status:r.status,error:data?.description||'Telegram API error'}}return data}
function authorized(req:Request,env:Env):boolean{
  if(!env.TT_CONTROL_PASSWORD)return false
  const auth=req.headers.get('authorization')||''
  const cookie=req.headers.get('cookie')||''
  return auth==='Bearer '+env.TT_CONTROL_PASSWORD || cookie.split(';').some(x=>x.trim()==='tt_control='+encodeURIComponent(env.TT_CONTROL_PASSWORD))
}
function login(message=''){return new Response(`<!doctype html><html lang="es"><meta name="viewport" content="width=device-width"><title>TT Control</title><link rel="icon" href="/favicon.ico"><link rel="icon" href="/icon.svg?v=2" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1769e0"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="TT Control"><style>body{font-family:system-ui;background:#f4f6f9;display:grid;place-items:center;height:100vh;margin:0}form{background:white;padding:28px;border-radius:14px;box-shadow:0 8px 30px #0002;width:min(360px,88vw)}input,button{width:100%;padding:12px;margin-top:12px;box-sizing:border-box}button{background:#1769e0;color:white;border:0;border-radius:8px}</style><form method="post" action="/login"><h2>TT Control</h2><input type="password" name="password" placeholder="Contraseña" autofocus><button>Entrar</button><p>${message}</p></form></html>`,{headers:{'content-type':'text/html;charset=UTF-8','cache-control':'no-store'}})}

const HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><link rel="icon" href="/favicon.ico"><link rel="icon" href="/icon.svg?v=2" type="image/svg+xml"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TT Control</title><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1769e0"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="TT Control"><style>
:root{font-family:Inter,system-ui,sans-serif;color:#e8edf5;background:#090b10;color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#090b10}.top{min-height:68px;background:#0f131a;border-bottom:1px solid #29313d;display:flex;align-items:center;padding:10px 24px;gap:18px;position:sticky;top:0;z-index:30}.brand{font-size:22px;font-weight:800}.manual{background:#121923;color:#6aa8ff;border:1px solid #3578d4;border-radius:10px;padding:11px 14px;font-weight:700}.run{margin-left:auto;background:#1769e0;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:700}.layout{display:grid;grid-template-columns:210px minmax(430px,1fr) minmax(360px,.9fr);min-height:calc(100vh - 68px)}nav{padding:22px 14px;border-right:1px solid #29313d;background:#0f131a;position:sticky;top:68px;height:calc(100vh - 68px);align-self:start;overflow-y:auto}nav button{display:block;width:100%;text-align:left;border:0;background:none;padding:12px;border-radius:9px;font-size:15px}.active{background:#182a44!important;color:#7eb5ff;font-weight:700}.list{padding:22px}.layout.radarMode .list{position:sticky;top:68px;height:calc(100vh - 68px);align-self:start;overflow:hidden}.detail{padding:22px;border-left:1px solid #29313d;background:#0f131a}.card{background:#11161e;border:1px solid #29313d;border-radius:12px;padding:15px;margin-bottom:12px}.meta{font-size:12px;color:#9aa6b6;margin-bottom:6px}.title{font-weight:700;line-height:1.35}.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}.split{display:inline-flex}.split>button{border-radius:8px 0 0 8px!important}.split>.more{border-radius:0 8px 8px 0!important;padding-left:7px!important;padding-right:7px!important;border-left:0!important}.actions button{border:1px solid #3a4555;background:#171d26;color:#e8edf5;border-radius:8px;padding:8px 10px}.publish{background:#e8edf5!important;color:#0b0e13!important;border-color:#e8edf5!important}.danger{background:#32191c!important;color:#ff8f8f!important;border-color:#71343a!important}.remateChoice{border:1px solid #303947;border-radius:10px;padding:10px;margin:8px 0;background:#151b24}.remateChoice p{margin:6px 0}.yes{background:#163122!important;color:#9be5b3!important;border-color:#315c3e!important}.no{background:#32191c!important;color:#ff9b9b!important;border-color:#71343a!important}.urgent{color:#ff7b72;font-weight:800}.urgencyBtn{min-width:34px;padding:5px 7px!important;font-size:12px;font-weight:800}.urgencyBtn.isUrgent{background:#d92d20!important;color:#fff;border-color:#d92d20!important}.empty{color:#9aa6b6;padding:30px 0}.mobileClose{display:none}.radarAgree{background:#163122!important;color:#9be5b3!important}.radarDisagree{background:#32191c!important;color:#ff9b9b!important}@media(max-width:850px){body{overflow-x:hidden}.layout{display:block;min-height:auto}.top{min-height:58px;height:auto;padding:8px 10px;gap:8px;flex-wrap:wrap}.brand{font-size:19px;line-height:1}.top #stamp{display:none}.top #autoCountdown{order:4;width:100%;margin:0;font-size:11px}.manual{padding:9px 11px;font-size:12px}.run{margin-left:auto;padding:10px 12px;font-size:12px}nav{position:sticky;top:58px;z-index:25;height:auto;display:flex;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:1px solid #29313d;padding:7px 8px;gap:5px;scrollbar-width:none}nav::-webkit-scrollbar{display:none}nav button{white-space:nowrap;width:auto;flex:0 0 auto;padding:9px 11px}.list{padding:12px 10px}.list h2{font-size:19px;margin:8px 2px 12px}.card{padding:13px 12px;margin-bottom:9px;border-radius:10px}.title{font-size:15px}.actions{gap:6px}.actions button{min-height:40px;padding:8px 9px;font-size:12px}.detail{display:none}.detail.mobileOpen{display:block;position:fixed;inset:0;z-index:50;overflow:auto;padding:16px 14px 40px;background:#0f131a}.mobileClose{display:inline-block!important;position:sticky;top:0;float:right;margin:0 0 10px 10px;z-index:2}.remateChoice{padding:10px}.detail img{max-width:100%!important;height:auto}.detail button{max-width:100%}}
</style></head><body><header class="top"><div class="brand">TT Control</div><span id="stamp">TTiTTulares</span><button class="manual" onclick="openManual()">＋ NOTICIA</button><span id="autoCountdown" class="meta" title="Próxima ejecución automática">Auto · 05:00</span><label class="meta" title="1 = menos noticias · 5 = más noticias">Radar <select id="radarSensitivity" onchange="setRadarSensitivity(this.value)"><option value="1">1 · Mínimo</option><option value="2">2 · Bajo</option><option value="3" selected>3 · Normal</option><option value="4">4 · Alto</option><option value="5">5 · Máximo</option></select></label><button class="run" onclick="runNow()">RADAR</button></header><main class="layout"><nav><button class="active" onclick="showView(\'READY\',this)">Listas <b id="readyCount"></b></button><button onclick="showView(\'NEW\',this)">Entrada <b id="newCount"></b></button><button onclick="showView(\'PROCESSING\',this)">Elaborando <b id="processingCount"></b></button><button onclick="showView(\'RADAR_WORK\',this)">Radar <b id="radarWorkCount"></b></button></nav><section class="list"><h2>Noticias para valorar</h2><div id="news" class="empty">Cargando…</div></section><aside class="detail"></aside></main><script>
let currentView=new URLSearchParams(location.search).get('view')||'READY';document.addEventListener('DOMContentLoaded',()=>document.querySelector('.layout').classList.toggle('radarMode',currentView==='RADAR_WORK'))
let openNewsId=0
async function loadRadarSensitivity(){try{const r=await fetch('/api/radar-sensitivity',{cache:'no-store'}),d=await r.json();if(r.ok)radarSensitivity.value=String(d.value||3)}catch(_){}}
async function setRadarSensitivity(v){try{const r=await fetch('/api/radar-sensitivity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value:Number(v)})});if(!r.ok)throw new Error('No se pudo guardar');await runNow(true)}catch(e){alert(e.message||e)}}
async function load(){
  loadRadarSensitivity();
  const desk=document.querySelector('.detail');if(!openNewsId){desk.classList.remove('mobileOpen');desk.innerHTML=''}
  try{
  const r=await fetch(currentView==='RADAR_WORK'?'/api/media-radar-work':'/api/news?status='+encodeURIComponent(currentView),{cache:'no-store'});let d;try{d=await r.json()}catch(_){throw new Error('Respuesta inválida del servidor ('+r.status+')')}if(!r.ok)throw new Error(d.error||('Error '+r.status));
  if(currentView==='RADAR_WORK'){radarWorkCount.textContent=d.count?'('+d.count+')':''}else{newCount.textContent=d.counts&&d.counts.NEW?'('+d.counts.NEW+')':'';
  processingCount.textContent=d.counts&&d.counts.PROCESSING?'('+d.counts.PROCESSING+')':'';
  readyCount.textContent=d.counts&&d.counts.READY?'('+d.counts.READY+')':'';}
  const heading=document.querySelector('.list h2');heading.textContent=currentView==='RADAR_WORK'?'Radar · en evaluación':currentView==='PROCESSING'?'Noticias elaborándose':currentView==='READY'?'Noticias listas':currentView==='RADAR_DISMISSED'?'Descartadas por el radar':'Noticias para valorar';
  const radarBulk=currentView==='RADAR_DISMISSED'&&d.news.length?'<div class="card" style="border-color:#315c3e;background:#12261a"><button class="radarAgree" onclick="radarAgreeAll()">Borrar todos</button></div>':'';
  if(currentView==='RADAR_WORK'){const groups=d.groups||[];const lr=d.last_run||{};const summary='<article class="card"><div class="meta">Último barrido</div><div class="title">'+fmtDate(lr.finished_at)+' · '+Number(lr.discovered||0)+' noticias detectadas · '+Number(lr.admitted||0)+' enviadas a Entrada</div></article>';news.innerHTML=summary+groups.map(function(g){return '<article class="card" onclick="openRadarGroup(&quot;'+g.key+'&quot;)"><div class="meta">'+esc(g.description)+'</div><div class="title">'+esc(g.label)+' <b>('+g.news.length+')</b></div></article>'}).join('');window.radarGroups=groups;return}news.innerHTML=radarBulk+(d.news.length?d.news.map(function(n){return '<article class="card" onclick="openDesk('+n.id+')"><div class="meta">'+fmtDate(n.published_at)+' '+(n.urgent?'<span class="urgent">· URGENTE</span>':'')+'</div><div class="title">'+esc(n.title)+'</div><div class="actions">'+(currentView==='NEW'?'<span class="split"><button class="yes" onclick="event.stopPropagation();act('+n.id+',&quot;PROCESSING&quot;)">✓ Seleccionar</button><button class="yes more" title="Seleccionar con instrucciones" onclick="event.stopPropagation();actWithComment('+n.id+',&quot;PROCESSING&quot;)">▾</button></span><span class="split"><button class="interesting" onclick="event.stopPropagation();act('+n.id+',&quot;INTERESTING&quot;)">≈ Interesante</button><button class="interesting more" title="Interesante con comentario" onclick="event.stopPropagation();actWithComment('+n.id+',&quot;INTERESTING&quot;)">▾</button></span><span class="split"><button class="no" onclick="event.stopPropagation();act('+n.id+',&quot;DISMISSED&quot;)">✕ Desestimar</button><button class="no more" title="Desestimar con comentario" onclick="event.stopPropagation();actWithComment('+n.id+',&quot;DISMISSED&quot;)">▾</button></span>':currentView==='PROCESSING'?'<button onclick="event.stopPropagation();processingAct('+n.id+',&quot;NEW&quot;)">↩ Devolver a Entrada</button><button class="no" onclick="event.stopPropagation();processingAct('+n.id+',&quot;DISMISSED&quot;)">✕ Borrar</button>':currentView==='READY'?'<button class="danger" onclick="event.stopPropagation();discardReady('+n.id+')">✕ Borrar</button>':currentView==='RADAR_DISMISSED'?'<button class="radarAgree" onclick="event.stopPropagation();radarFeedback('+n.id+',1)">Borrar definitivamente</button><span class="split"><button class="radarDisagree" onclick="event.stopPropagation();radarFeedback('+n.id+',0)">↩ Reevaluar</button><button class="radarDisagree more" title="Reevaluar explicando el motivo" onclick="event.stopPropagation();radarFeedbackWithComment('+n.id+')">▾</button></span>':'<span class="meta">✓ Publicada</span>')+'<button class="urgencyBtn '+(n.urgent?'isUrgent':'')+'" title="'+(n.urgent?'Marcar como no urgente':'Marcar como urgente')+'" onclick="event.stopPropagation();urgent('+n.id+','+(n.urgent?0:1)+')">'+(n.urgent?'↓ U':'↑ U')+'</button></div></article>'}).join(''):'<div class="empty">'+(currentView==='RADAR_WORK'?'No hay noticias en evaluación.':currentView==='PROCESSING'?'No hay noticias elaborándose.':currentView==='READY'?'No hay noticias listas.':currentView==='RADAR_DISMISSED'?'No hay descartes automáticos pendientes de revisar.':'No hay noticias pendientes.')+'</div>')
  const targetId=Number(new URLSearchParams(location.search).get('id')||0);if(targetId&&d.news.some(function(n){return n.id===targetId})){openDesk(targetId)}
  }catch(e){news.innerHTML='<div class="empty"><b>No se pudo cargar TT Control.</b><br>'+esc(e.message||e)+'<br><button onclick="load()" style="margin-top:12px">↻ Reintentar</button></div>'}
}
function openRadarGroup(key){const g=(window.radarGroups||[]).find(x=>x.key===key);if(!g)return;openNewsId=-1;const desk=document.querySelector('.detail');desk.classList.add('mobileOpen');desk.innerHTML='<button class="closeDesk" onclick="closeDesk()">×</button><h2>'+esc(g.label)+' <span class="meta">('+g.news.length+')</span></h2><p class="meta">'+esc(g.description)+'</p>'+g.news.map(function(n){let src=[];try{src=JSON.parse(n.sources_json||'[]')}catch(_){};return '<article class="card"><div class="meta">'+fmtDate(n.last_seen)+' · <b>'+Number(n.source_count||1)+'/9 medios</b> · '+esc(n.status)+'</div><div class="title"><a href="'+esc(n.url||'#')+'" target="_blank" rel="noopener">'+esc(n.title)+'</a></div><div class="meta">'+esc(src.join(' · '))+(n.reason?'<br>'+esc(n.reason):'')+'</div></article>'}).join('')}
function showView(view,btn){openNewsId=0;currentView=view;document.querySelector('.layout').classList.toggle('radarMode',view==='RADAR_WORK');document.querySelectorAll('nav button').forEach(function(x){x.classList.remove('active')});btn.classList.add('active');load()}
function fmtDate(s){if(!s)return '';const v=String(s);const m=v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);if(m)return m[1]+'  '+m[2];const d=new Date(v);if(!isNaN(d.getTime())){const p=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);return p.replace(' ','  ')}return v}
function esc(s){return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
let actionBusy=false
async function act(id,status){
  if(actionBusy)return;actionBusy=true
  try{
    const r=await fetch('/api/news/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,status})})
    const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo guardar la decisión')
    await load()
  }catch(e){alert(e.message||e)}finally{actionBusy=false}
}
async function actWithComment(id,status){
  const labels={PROCESSING:'Seleccionar con instrucciones',INTERESTING:'Marcar interesante con comentario',DISMISSED:'Desestimar con comentario'}
  const hints={PROCESSING:'Indica por dónde quieres que vaya el enfoque o el remate:',INTERESTING:'¿Por qué te parece interesante aunque no la selecciones?',DISMISSED:'¿Por qué la desestimas?'}
  const comment=prompt((labels[status]||'Añadir comentario')+'\
\
'+(hints[status]||''))
  if(comment===null)return
  if(!comment.trim())return alert('Escribe un comentario o usa el botón principal para la acción rápida.')
  if(actionBusy)return;actionBusy=true
  try{const r=await fetch('/api/news/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,status:status,comment:comment.trim()})});const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo guardar la decisión');await load()}catch(e){alert(e.message||e)}finally{actionBusy=false}
}
function openManual(){
  const desk=document.querySelector('.detail');desk.classList.add('mobileOpen');desk.innerHTML='<button class="mobileClose" onclick="closeDesk()">✕ Cerrar</button><h2>＋ Añadir noticia / CONTROL</h2><p class="meta">Pega una noticia para Elaborando o empieza el texto por <b>CONTROL</b> para enviar una consigna general de TT Control.</p><input id="manualUrl" placeholder="Enlace (opcional)" style="width:100%;padding:11px;margin:6px 0;border:1px solid #cfd6e1;border-radius:8px"><textarea id="manualTitle" placeholder="Titular, descripción o CONTROL ..." style="width:100%;min-height:100px;padding:11px;margin:6px 0;border:1px solid #cfd6e1;border-radius:8px"></textarea><div class="actions"><button class="publish" onclick="submitManual()">Enviar</button></div>'
}
async function submitManual(){
  const url=document.getElementById('manualUrl').value.trim(),title=document.getElementById('manualTitle').value.trim();if(!url&&!title)return alert('Pega un enlace o escribe la noticia.')
  const isControl=/^CONTROL\\b/i.test(title);const endpoint=isControl?'/api/control':'/api/news/manual';const payload=isControl?{text:title.replace(/^CONTROL\\s*[:\\-]?\\s*/i,'').trim()}:{url:url,title:title}
  const r=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok)return alert(d.error||'No se pudo añadir')
  if(isControl){document.querySelector('.detail').innerHTML='<button class="mobileClose" onclick="closeDesk()">✕ Cerrar</button><h2>Consigna recibida</h2><p>✓ CONTROL guardado para TT Control.</p>';return}
  document.querySelector('.detail').innerHTML='<button class="mobileClose" onclick="closeDesk()">✕ Cerrar</button><h2>Noticia añadida</h2><p>✓ En Elaborando. Se preparará en la siguiente ejecución.</p>';currentView='PROCESSING';await load()
}
async function urgent(id,value){
  if(actionBusy)return;actionBusy=true
  try{
    const r=await fetch('/api/news/urgent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,value})})
    const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo cambiar la urgencia')
    await load()
  }catch(e){alert(e.message||e)}finally{actionBusy=false}
}
async function openDesk(id){
  openNewsId=id
  const r=await fetch('/api/news/'+id);const d=await r.json();if(!r.ok)return alert(d.error||'No se pudo abrir la noticia')
  const n=d.news,dr=d.draft;const desk=document.querySelector('.detail')
  desk.classList.add('mobileOpen');desk.innerHTML='<button class="mobileClose" onclick="closeDesk()">✕ Cerrar</button><h2>Mesa de redacción</h2><div class="meta">'+fmtDate(n.published_at)+'</div><h3>'+esc(n.title)+'</h3>'+
    (n.processing_error?'<p class="urgent"><b>Error de elaboración:</b> '+esc(n.processing_error)+'</p>':'')+(d.selection_instruction?'<p style="background:#2c2815;border:1px solid #62582a;padding:10px;border-radius:8px"><b>📝 Instrucción editorial:</b> '+esc(d.selection_instruction)+'</p>':'')+
    (dr?'<h3>Versión base</h3><p>'+esc(dr.base_text||'')+'</p>'+(dr.image_url?'<div class="remateChoice"><img src="'+esc(dr.image_url)+'" style="max-width:100%;max-height:260px;border-radius:12px;display:block;margin-bottom:8px"><button onclick="copyImage(&quot;'+esc(dr.image_url)+'&quot;)">📋 Copiar imagen</button></div>':'')+
      '<div class="remateChoice"><b>Publicar sin remate</b><div class="actions"><button class="publish" onclick="openX('+id+',0)">Abrir en X</button><button onclick="markPublished('+id+',0)">✓ Marcar publicada</button></div></div>'+
      '<div class="remateChoice"><b>🌶️ Remate A</b><p>'+esc(dr.remate_a||'')+'</p>'+(dr.image_a_url?'<img src="'+esc(dr.image_a_url)+'" style="max-width:100%;max-height:320px;border-radius:12px;display:block;margin:8px 0"><button onclick="copyImage(&quot;'+esc(dr.image_a_url)+'&quot;)">📋 Copiar imagen A</button>':'')+'<div class="actions"><button class="publish" onclick="openX('+id+',1)">Abrir en X</button><button onclick="requestChatImage('+id+',1)">🎨 Crear imagen</button><button onclick="markPublished('+id+',1)">✓ Marcar publicada</button></div></div>'+
      '<div class="remateChoice"><b>🌶️ Remate B</b><p>'+esc(dr.remate_b||'')+'</p>'+(dr.image_b_url?'<img src="'+esc(dr.image_b_url)+'" style="max-width:100%;max-height:320px;border-radius:12px;display:block;margin:8px 0"><button onclick="copyImage(&quot;'+esc(dr.image_b_url)+'&quot;)">📋 Copiar imagen B</button>':'')+'<div class="actions"><button class="publish" onclick="openX('+id+',2)">Abrir en X</button><button onclick="requestChatImage('+id+',2)">🎨 Crear imagen</button><button onclick="markPublished('+id+',2)">✓ Marcar publicada</button></div></div>'+
      '<div class="remateChoice"><b>🌶️ Remate C</b><p>'+esc(dr.remate_c||'')+'</p>'+(dr.image_c_url?'<img src="'+esc(dr.image_c_url)+'" style="max-width:100%;max-height:320px;border-radius:12px;display:block;margin:8px 0"><button onclick="copyImage(&quot;'+esc(dr.image_c_url)+'&quot;)">📋 Copiar imagen C</button>':'')+'<div class="actions"><button class="publish" onclick="openX('+id+',3)">Abrir en X</button><button onclick="requestChatImage('+id+',3)">🎨 Crear imagen</button><button onclick="markPublished('+id+',3)">✓ Marcar publicada</button></div></div>'+
      '<div class="actions"><button onclick="requestRewrite('+id+',true)">✎ Devolver con instrucciones</button><button class="interesting" onclick="interestingReady('+id+')">≈ Interesante, no publicar</button><button class="danger" onclick="discardReady('+id+')">✕ Borrar noticia</button></div>'+
      '<h3>Investigación</h3><p>'+esc(dr.research||'')+'</p>':
    '<p>'+(n.status==='PROCESSING'?'Pendiente de elaboración automática.':'Selecciona o procesa esta noticia para generar la redacción.')+'</p>')
}

function closeDesk(){openNewsId=0;const desk=document.querySelector('.detail');desk.classList.remove('mobileOpen');desk.innerHTML=''}
async function radarFeedback(id,agree){
  if(actionBusy)return;actionBusy=true
  try{const r=await fetch('/api/news/radar-feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,agree:!!agree})});const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo guardar');await load()}catch(e){alert(e.message||e)}finally{actionBusy=false}
}
async function radarFeedbackWithComment(id){
  const comment=(prompt('¿Por qué no debería haberla descartado el radar?')||'').trim();if(!comment)return
  if(actionBusy)return;actionBusy=true
  try{const r=await fetch('/api/news/radar-feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,agree:false,comment:comment})});const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo guardar');await load()}catch(e){alert(e.message||e)}finally{actionBusy=false}
}
async function radarAgreeAll(){
  if(actionBusy)return
  if(!confirm('¿Borrar definitivamente todos los descartes actuales? Se incorporarán al aprendizaje.'))return
  actionBusy=true
  try{
    const r=await fetch('/api/news/radar-feedback-all',{method:'POST'})
    const d=await r.json();if(!r.ok)throw new Error(d.error||'No se pudo confirmar la lista')
    await load()
  }catch(e){alert(e.message||e)}finally{actionBusy=false}
}
async function requestRewrite(id,withReason){
  let reason=''
  if(withReason){reason=prompt('¿Qué no te convence o qué quieres que cambie?')||'';if(!reason.trim())return}
  else if(!confirm('¿Pedir tres remates nuevos para esta noticia?'))return
  const r=await fetch('/api/news/rewrite',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,reason:reason.trim()})})
  const d=await r.json();if(!r.ok)return alert(d.error||'No se pudo reenviar')
  closeDesk();currentView='READY';document.querySelectorAll('nav button').forEach(function(x){x.classList.remove('active')});const rb=[...document.querySelectorAll('nav button')].find(function(x){return x.textContent.includes('Listas')});if(rb)rb.classList.add('active');await load()
}
async function interestingReady(id){
  if(!confirm('¿Marcar como interesante pero finalmente no publicar?'))return
  const r=await fetch('/api/news/interesting-ready',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})})
  const d=await r.json();if(!r.ok)return alert(d.error||'No se pudo guardar')
  closeDesk();currentView='READY';document.querySelectorAll('nav button').forEach(function(x){x.classList.remove('active')});const rb=[...document.querySelectorAll('nav button')].find(function(x){return x.textContent.includes('Listas')});if(rb)rb.classList.add('active');await load()
}
async function discardReady(id){
  if(!confirm('¿Borrar esta noticia de Listas?'))return
  const r=await fetch('/api/news/discard-ready',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})})
  const d=await r.json();if(!r.ok)return alert(d.error||'No se pudo borrar')
  closeDesk();currentView='READY';document.querySelectorAll('nav button').forEach(function(x){x.classList.remove('active')});const rb=[...document.querySelectorAll('nav button')].find(function(x){return x.textContent.includes('Listas')});if(rb)rb.classList.add('active');await load()
}
async function markPublished(id,option){
  const labels=['BASE','A','B','C'];if(!confirm('¿Confirmar como publicada la variante '+labels[option]+'?'))return
  const r=await fetch('/api/news/publish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,variant:labels[option]})})
  const d=await r.json();if(!r.ok)return alert(d.error||'No se pudo registrar la publicación')
  closeDesk();currentView='READY';document.querySelectorAll('nav button').forEach(function(x){x.classList.remove('active')});const rb=[...document.querySelectorAll('nav button')].find(function(x){return x.textContent.includes('Listas')});if(rb)rb.classList.add('active');await load()
}
async function openX(id,option){
  const r=await fetch('/api/news/'+id);const d=await r.json();if(!r.ok)return alert(d.error||'No se pudo abrir la noticia')
  const dr=d.draft;if(!dr)return alert('No hay borrador')
  const rem=[null,dr.remate_a,dr.remate_b,dr.remate_c][option]
  const text=String(dr.base_text||'')+(rem?' 🌶️ '+String(rem):'')
  if(text.length>280)return alert('Esta variante supera 280 caracteres ('+text.length+').')
  if(/iPhone|iPad|iPod/i.test(navigator.userAgent)){window.location.href='twitter://post?message='+encodeURIComponent(text)}else{window.open('https://x.com/intent/post?text='+encodeURIComponent(text),'_blank','noopener')}
}
async function requestChatImage(id,option){
  const labels=['','A','B','C'],label=labels[option]
  try{
    const r=await fetch('/api/news/'+id,{cache:'no-store'}),d=await r.json()
    if(!r.ok||!d.draft)throw new Error(d.error||'No se pudo recuperar el borrador')
    const dr=d.draft,rem=[null,dr.remate_a,dr.remate_b,dr.remate_c][option]||''
    const promptText=[
      'TTIMG #'+id+'-'+label,
      'Noticia: '+String(d.news.url||d.news.title||''),
      'Base: '+String(dr.base_text||''),
      'Remate '+label+': '+String(rem),
      'Genera directamente una imagen editorial horizontal para este remate, con un gag visual específico y calidad de viñeta profesional TTiTTulares. No hagas una ilustración genérica.'
    ].join('\
')
    await navigator.clipboard.writeText(promptText)
    alert('✓ TTIMG #'+id+'-'+label+' copiado con noticia, base y remate. Vuelve a este chat, pega y envía.')
  }catch(e){
    alert('No se pudo preparar la petición de imagen: '+(e.message||e))
  }
}
async function createAiImage(id,regenerate=false){
  const r=await fetch('/api/news/ai-image',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,regenerate:regenerate})});const d=await r.json();if(!r.ok)return alert(d.error||'No se pudo crear la imagen');await openDesk(id)
}
async function copyImage(url){
  try{
    const target=url.startsWith('/')?url:'/api/image-proxy?url='+encodeURIComponent(url),r=await fetch(target);if(!r.ok)throw 0;const b=await r.blob()
    if(url.startsWith('/api/ai-image/')||url.startsWith('/api/editorial-image/')){
      const bmp=await createImageBitmap(b),band=64,cv=document.createElement('canvas');cv.width=bmp.width;cv.height=bmp.height+band;const x=cv.getContext('2d');x.drawImage(bmp,0,0);x.fillStyle='#123d73';x.fillRect(0,bmp.height,cv.width,band);x.fillStyle='white';x.font='bold '+Math.max(24,Math.round(cv.width/24))+'px sans-serif';x.textBaseline='middle';x.fillText('TTiTTulares  🌶️',Math.round(cv.width*.04),bmp.height+band/2);const branded=await new Promise(ok=>cv.toBlob(ok,'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':branded})])
    }else await navigator.clipboard.write([new ClipboardItem({[b.type]:b})])
    alert('✓ Imagen copiada. Abre X y pégala.')
  }catch(_){window.open(url,'_blank')}
}
async function processingAct(id,status){
  const r=await fetch('/api/news/processing-status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,status:status})});const d=await r.json();if(!r.ok)return alert(d.error||'No se pudo mover la noticia');await load()
}
let autoRunBusy=false
async function runNow(silent=false){
  if(autoRunBusy)return
  autoRunBusy=true
  const b=document.querySelector('.run')
  if(!silent){b.disabled=true;b.textContent='Radar…'}
  try{
    const r=await fetch('/api/run',{method:'POST'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Error de ejecución')
    if(!silent){b.textContent='✓ '+(d.discovered||0)+' nuevas · '+(d.claimed||0)+' a elaborar · '+(d.backlogDismissed||0)+' radar';setTimeout(function(){b.textContent='RADAR'},1800)}
    await load()
  }catch(e){
    if(!silent){news.innerHTML='<div class="empty">Error: '+esc(e.message||e)+'</div>';b.textContent='⚠ Error'}
    else console.warn('TT Control auto-run:',e)
  }finally{if(!silent)b.disabled=false;autoRunBusy=false}
}
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{})
let nextAutoRun=Date.now()+300000
function updateCountdown(){const left=Math.max(0,nextAutoRun-Date.now()),m=Math.floor(left/60000),s=Math.floor((left%60000)/1000);const el=document.getElementById('autoCountdown');if(el)el.textContent='Auto · '+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')}
load();updateCountdown()
setInterval(updateCountdown,1000)
setInterval(async function(){nextAutoRun=Date.now()+300000;updateCountdown();await runNow(true)},300000)
</script></body></html>`;


function mediaNorm(s:string){return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9ñ ]/g,' ').replace(/\b(el|la|los|las|un|una|de|del|al|y|en|por|para|con|que|se|su|sus)\b/g,' ').replace(/\s+/g,' ').trim()}
function mediaFingerprint(title:string){return mediaNorm(title).split(' ').filter(x=>x.length>2).slice(0,8).sort().join('|')}
function xmlText(s:string){return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim()}
function parseFeed(xml:string,source:string){const out:any[]=[];for(const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)){const b=m[0],tm=b.match(/<title[^>]*>([\s\S]*?)<\/title>/i),lm=b.match(/<link[^>]*href=["']([^"']+)/i)||b.match(/<link[^>]*>([\s\S]*?)<\/link>/i);if(tm&&lm)out.push({title:xmlText(tm[1]),url:xmlText(lm[1]),source})}return out.slice(0,40)}
async function fetchMediaItems(){
  const feeds=[['EL PAÍS','https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/ultimas-noticias/portada'],['La Vanguardia','https://www.lavanguardia.com/rss/home.xml']]
  const all:any[]=[]
  try{const r=await fetch('https://raw.githubusercontent.com/fabricelop/europapress-rss/main/recent.json',{headers:{'user-agent':'TT-Control-Media-Radar/1.0'}});if(r.ok){const j:any=await r.json();const rows=Array.isArray(j)?j:(Array.isArray(j.items)?j.items:[]);for(const x of rows.slice(0,80)){const title=String(x.title||x.titulo||'').trim(),url=String(x.url||x.link||'').trim();if(title&&url)all.push({source:'Europa Press',title,url})}}}catch(_){}
  for(const [source,url] of feeds){try{const r=await fetch(url,{headers:{'user-agent':'TT-Control-Media-Radar/1.0'}});if(r.ok)all.push(...parseFeed(await r.text(),source))}catch(_){}}
  for(const [source,url] of [['Cadena SER','https://cadenaser.com/ultimas-noticias/'],['RTVE','https://www.rtve.es/noticias/'],['El HuffPost','https://www.huffingtonpost.es/ultimas-noticias'],['20minutos','https://www.20minutos.es/ultima-hora/'],['ABC','https://www.abc.es/ultima-hora/'],['COPE','https://www.cope.es/ultima-hora']] as string[][]){try{const r=await fetch(url,{headers:{'user-agent':'TT-Control-Media-Radar/1.0'}});if(!r.ok)continue;const h=await r.text();const re=/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;let m;while((m=re.exec(h))&&all.filter(x=>x.source===source).length<35){const title=xmlText(m[2]);if(title.length<35||title.length>240)continue;let link=m[1];if(link.startsWith('/'))link=new URL(link,url).toString();if(/^https?:/.test(link))all.push({source,url:link,title})}}catch(_){}}
  return all
}
async function runMediaRadar(env:Env){
  const setting=await env.DB.prepare("SELECT value FROM app_settings WHERE key='radar_sensitivity'").first<{value:string}>();const sensitivity=Math.max(1,Math.min(5,Number(setting?.value||3)));const entryCoverage=[0,.55,.44,.33,.22,.12][sensitivity],alertCoverage=[0,.89,.78,.67,.45,.34][sensitivity]
  const items=await fetchMediaItems();let touched=0,alerts=0,entry=0
  const similarCache:any=await env.DB.prepare("SELECT id,fingerprint,title,sources_json,source_count,status,last_seen FROM media_radar WHERE status IN ('NEW','ENTRY','ALERTED','IGNORED') AND last_seen>=datetime('now','-18 hours') ORDER BY last_seen DESC LIMIT 180").all();const recentRows:any[]=similarCache.results as any[]
  for(const x of items){const fp=mediaFingerprint(x.title);if(fp.length<12)continue;let row:any=null
    const toks=new Set(fp.split('|'));let best:any=null,bestOverlap=0;for(const r of recentRows){const rt=new Set(String(r.fingerprint).split('|'));const overlap=[...toks].filter(t=>rt.has(t)).length/Math.max(1,Math.min(toks.size,rt.size));if(overlap>bestOverlap){bestOverlap=overlap;best=r}if(overlap>=.48){row=r;break}}
    if(!row&&best&&bestOverlap>=.22){try{const mergePrompt=`Decide si estos dos titulares describen esencialmente EL MISMO ACONTECIMIENTO noticioso, aunque usen protagonistas, verbos o enfoques distintos. No unas noticias solo por compartir tema o persona. A: ${x.title} B: ${best.title}. Responde SOLO JSON {"same":true|false}.`;const mo:any=await env.AI.run('@cf/google/gemma-4-26b-a4b-it',{messages:[{role:'system',content:'Deduplicador semántico estricto de noticias. JSON solamente.'},{role:'user',content:mergePrompt}],chat_template_kwargs:{enable_thinking:false}});const mp=JSON.parse(String(mo?.response||'').replace(/```json|```/g,'').trim());if(mp.same)row=best}catch(_){}}
    if(row){const ss=new Set<string>(JSON.parse(row.sources_json||'[]'));ss.add(x.source);await env.DB.prepare("UPDATE media_radar SET sources_json=?,source_count=?,last_seen=datetime('now'),status=CASE WHEN status='IGNORED' AND ?>=2 THEN 'NEW' ELSE status END WHERE id=?").bind(JSON.stringify([...ss]),ss.size,ss.size,row.id).run();touched++;continue}
    await env.DB.prepare("INSERT OR IGNORE INTO media_radar(fingerprint,title,url,source,sources_json) VALUES(?,?,?,?,?)").bind(fp,x.title,x.url,x.source,JSON.stringify([x.source])).run();touched++
  }
  const q:any=await env.DB.prepare("SELECT * FROM media_radar WHERE status='NEW' AND last_seen>=datetime('now','-4 hours') ORDER BY source_count DESC,last_seen DESC LIMIT 40").all()
  for(const n of q.results as any[]){try{
    const sources=JSON.parse(n.sources_json||'[]'),count=Number(n.source_count||sources.length||1)
    const prompt=`Clasifica este acontecimiento para TTiTTulares España. El objetivo es REDUCIR AL MENOS UN 90% el volumen bruto y conservar solo noticias con interés editorial real. La repetición en varios medios NO convierte una noticia rutinaria en interesante. Resultados de loterías/sorteos (Primitiva, Bonoloto, Euromillones, ONCE, etc.), previsiones meteorológicas regionales/provinciales rutinarias, horóscopos, tráfico y otros contenidos de servicio deben ser IGNORE aunque aparezcan en muchos medios, salvo que exista un acontecimiento extraordinario independiente (premio récord excepcional, fenómeno meteorológico grave con impacto nacional, etc.). Distingue tres niveles:
ALERT = noticia verdaderamente importante que merece notificación inmediata al móvil. Normalmente debe aparecer en 3 o más medios independientes. Con 2 medios, solo ALERT si es claramente de primera magnitud (gran decisión política/institucional nacional, gran suceso, guerra/crisis internacional de alto impacto, dato económico excepcional, gran resultado deportivo/cultural). Con 1 medio, ALERT únicamente ante una exclusiva o acontecimiento inequívocamente extraordinario.
ENTRY = merece revisión humana en Entrada, pero no interrumpir. Como regla, exige coincidencia en al menos 2 medios; excepcionalmente 1 fuente si el interés nacional es claro y alto.
IGNORE = territorial/local rutinaria, declaraciones menores, agenda, opinión, servicio, lotería, horóscopo, previa/directo rutinario, repetición o asunto de poco alcance.
No confundas que una noticia no admita humor con falta de interés. Política nacional española relevante debe conservarse. Evalúa el ACONTECIMIENTO, no la redacción del titular.
Fuentes independientes detectadas: ${count} de 9 (${Math.round(count/9*100)}% de cobertura) (${sources.join(', ')})
Titular representativo: ${n.title}
Responde SOLO JSON {"level":"ALERT"|"ENTRY"|"IGNORE","reason":"frase breve"}.`
    const out:any=await env.AI.run('@cf/google/gemma-4-26b-a4b-it',{messages:[{role:'system',content:'Eres el editor de un radar de noticias español muy selectivo. Agrupa acontecimientos y devuelve JSON válido.'},{role:'user',content:prompt}],chat_template_kwargs:{enable_thinking:false}})
    const p=JSON.parse(String(out?.response||'').replace(/```json|```/g,'').trim()),level=String(p.level||'IGNORE').toUpperCase()
    const coverage=count/9
    let safeLevel=(level==='ALERT'&&count<2)?'ENTRY':(level==='ALERT'||level==='ENTRY'?level:'IGNORE')
    if(coverage>=alertCoverage)safeLevel='ALERT'
    else if(coverage>=entryCoverage&&safeLevel==='IGNORE')safeLevel='ENTRY'
    const status=safeLevel==='ALERT'?'ALERTED':safeLevel==='ENTRY'?'ENTRY':'IGNORED'
    await env.DB.prepare("UPDATE media_radar SET importance=?,reason=?,status=? WHERE id=?").bind(safeLevel,String(p.reason||''),status,n.id).run()
    if(status==='ALERTED')alerts++;if(status==='ENTRY')entry++
  }catch(e){console.log('Media radar LLM retry',n.id,String(e));const sources=JSON.parse(n.sources_json||'[]'),count=Number(n.source_count||sources.length||1),coverage=count/9;if(coverage>=alertCoverage){await env.DB.prepare("UPDATE media_radar SET importance='ALERT',reason=?,status='ALERTED' WHERE id=?").bind('Promovida por cobertura de '+count+'/9 medios; clasificación LLM pendiente',n.id).run();alerts++}else if(coverage>=entryCoverage){await env.DB.prepare("UPDATE media_radar SET importance='ENTRY',reason=?,status='ENTRY' WHERE id=?").bind('Promovida por cobertura de '+count+'/9 medios; clasificación LLM pendiente',n.id).run();entry++}else await env.DB.prepare("UPDATE media_radar SET reason=? WHERE id=?").bind('Pendiente de reintento: clasificación LLM no disponible',n.id).run()}}
  return {items:items.length,touched,alerts,entry}
}
async function ingest(env:Env){
  const run=await env.DB.prepare("INSERT INTO runs(started_at,trigger) VALUES(datetime('now'),'manual') RETURNING id").first<{id:number}>()
  try{
    const claimed={meta:{changes:0}},media=await runMediaRadar(env)
    const candidates:any=await env.DB.prepare("SELECT * FROM media_radar WHERE status='ENTRY' AND last_seen>=datetime('now','-12 hours') ORDER BY source_count DESC,last_seen DESC LIMIT 60").all()
    let admitted=0,discovered=Number(media.items||0),radarDismissed=0
    for(const x of candidates.results as any[]){const key='radar:'+x.id;const write=await env.DB.prepare(`INSERT INTO news(source_key,title,url,section,published_at,detected_at,status,radar_reason,updated_at)
      VALUES(?,?,?,?,datetime('now'),datetime('now'),'NEW',?,datetime('now')) ON CONFLICT(source_key) DO NOTHING`).bind(key,x.title,x.url,'Radar de medios',x.reason||('Coincidencia en '+x.source_count+' medios')).run();if(write.meta.changes){admitted++;await env.DB.prepare("UPDATE media_radar SET status='SENT_ENTRY' WHERE id=?").bind(x.id).run()}}
    await env.DB.prepare("UPDATE runs SET finished_at=datetime('now'),discovered=?,admitted=?,radar_dismissed=?,status='OK' WHERE id=?").bind(discovered,admitted,radarDismissed,run!.id).run()
    return {ok:true,discovered,admitted,radarDismissed,claimed:Number(claimed.meta.changes||0),media}
  }catch(e){await env.DB.prepare("UPDATE runs SET finished_at=datetime('now'),status='ERROR',error=? WHERE id=?").bind(String(e),run!.id).run();throw e}
}

export default {async scheduled(_event:ScheduledEvent,env:Env,ctx:ExecutionContext){ctx.waitUntil((async()=>{const guard:any=await env.DB.prepare("SELECT value FROM app_settings WHERE key='radar_cron_tick'").first().catch(()=>null);const tick=Number(guard?.value||0)+1;await env.DB.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('radar_cron_tick',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(String(tick)).run();if(tick%3===0)await ingest(env)})())},async fetch(req:Request,env:Env):Promise<Response>{
  const u=new URL(req.url)
  try{
    if(u.pathname==='/api/agent/pending'){
      if(!agentAuthorized(req,env))return Response.json({error:'No autorizado'},{status:401})
      if(req.method!=='GET')return new Response('Method Not Allowed',{status:405})
      try{const q=await env.DB.prepare("SELECT * FROM news WHERE status='PROCESSING' LIMIT 50").all();return Response.json({news:q.results})}
      catch(e){return Response.json({error:'pending_query_failed',detail:e instanceof Error?e.message:String(e)},{status:500})}
    }
    if(u.pathname==='/api/agent/enqueue'&&req.method==='POST'){
      if(!agentAuthorized(req,env))return Response.json({error:'No autorizado'},{status:401})
      const b:any=await req.json(),url=String(b.url||'').trim(),title=String(b.title||'').trim(),source=String(b.source||'telegram').trim()||'telegram'
      if(!url&&!title)return Response.json({error:'Falta enlace o titular'},{status:400})
      const key='telegram:'+String(b.event_id||url||title).toLowerCase()
      try{
        const row=await env.DB.prepare("INSERT INTO news(source,source_key,title,url,section,published_at,detected_at,status,radar_reason,updated_at,processing_started_at) VALUES(?,?,?,?, 'Telegram',datetime('now'),datetime('now'),'PROCESSING','Seleccionada en Telegram',datetime('now'),datetime('now')) ON CONFLICT(source_key) DO UPDATE SET title=excluded.title,url=excluded.url,status='PROCESSING',updated_at=datetime('now'),processing_started_at=datetime('now') RETURNING id").bind(source,key,title||url,url).first<{id:number}>()
        return Response.json({ok:true,id:row?.id,status:'PROCESSING'})
      }catch(e){return Response.json({error:'enqueue_failed',detail:e instanceof Error?e.message:String(e)},{status:200})}
    }
    if(req.method==='GET'&&(u.pathname==='/icon.svg'||u.pathname==='/favicon.ico'))return new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1769e0"/><text x="32" y="41" text-anchor="middle" font-family="Arial,sans-serif" font-size="29" font-weight="800" fill="white">TT</text><circle cx="52" cy="12" r="6" fill="#ff3b30"/></svg>`,{headers:{'content-type':'image/svg+xml','cache-control':'public,max-age=300'}})
    if(req.method==='GET'&&u.pathname==='/manifest.webmanifest')return Response.json({name:'TT Control',short_name:'TT Control',id:'/',start_url:'/',scope:'/',display:'standalone',background_color:'#f4f6f9',theme_color:'#1769e0'},{headers:{'content-type':'application/manifest+json','cache-control':'no-cache'}})
    if(req.method==='GET'&&u.pathname==='/sw.js')return new Response("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',()=>{});",{headers:{'content-type':'application/javascript','cache-control':'no-cache'}})
    if(req.method==='GET'&&u.pathname==='/login')return login()
    // Telegram callbacks that must remain available even when D1 is unavailable.
    if(req.method==='POST'&&u.pathname==='/api/telegram-webhook'){
      const secret=req.headers.get('x-telegram-bot-api-secret-token')||''
      if(env.TELEGRAM_WEBHOOK_SECRET&&secret!==env.TELEGRAM_WEBHOOK_SECRET)return new Response('Forbidden',{status:403})
      const update:any=await req.clone().json(),cq=update?.callback_query,data=String(cq?.data||''),msg=cq?.message||{}
      if(cq&&data==='delete:message'){
        const diagnostic={at:new Date().toISOString(),callback_query_id:cq.id,chat_id:msg?.chat?.id,message_id:msg?.message_id}
        const ack=await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'Borrando…'})
        const del=msg.message_id?await telegramApi(env,'deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id}):{ok:false,error:'message_id ausente'}
        if(env.GITHUB_TOKEN){
          try{
            const api='https://api.github.com/repos/fabricelop/europapress-rss/contents/telegram/delete-diagnostic.json'
            const h={'Authorization':'Bearer '+env.GITHUB_TOKEN,'Accept':'application/vnd.github+json','User-Agent':'tt-control-delete-diagnostic','Content-Type':'application/json'}
            const gr=await fetch(api,{headers:h});let sha:any=undefined;if(gr.ok){const gj:any=await gr.json();sha=gj.sha}
            const body:any={message:'Registrar diagnóstico borrado Telegram',content:btoa(unescape(encodeURIComponent(JSON.stringify({...diagnostic,ack,del},null,2)+'\\n'))),branch:'main'};if(sha)body.sha=sha
            await fetch(api,{method:'PUT',headers:h,body:JSON.stringify(body)})
          }catch(_){}
        }
        return Response.json({ok:true,ack,del,...diagnostic})
      }
    }
    if(req.method==='POST'&&u.pathname==='/api/telegram-webhook'){
      const update:any=await req.clone().json(),cq=update?.callback_query,data=String(cq?.data||''),msg=cq?.message||{}
      if(cq&&data==='delete:message'){
        const ack=await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'Borrada.'})
        const del=msg.message_id?await telegramApi(env,'deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id}):{ok:false,error:'message_id ausente'}
        return Response.json({ok:true,ack,del})
      }
      if(cq&&data.startsWith('dg:')){
        const ids=data.slice(3).split(',').map((x:string)=>Number(x)).filter((x:number)=>Number.isInteger(x))
        const results:any[]=[]
        for(const mid of ids)results.push(await telegramApi(env,'deleteMessage',{chat_id:msg.chat.id,message_id:mid}))
        if(msg.message_id&&!ids.includes(Number(msg.message_id)))results.push(await telegramApi(env,'deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id}))
        return Response.json({ok:true,deleted:ids,results})
      }
    }
    if(req.method==='POST'&&u.pathname==='/api/telegram-webhook'){
      const update:any=await req.clone().json(),cq=update?.callback_query,data=String(cq?.data||''),msg=cq?.message||{},chat=String(msg?.chat?.id||'')
      if(cq&&data.startsWith('emergency:')){
        const p=data.split(':'),action=p[1]||'',id=p.slice(2).join(':')
        if(!['prepare','dismiss','confirm'].includes(action)||!id)return Response.json({ok:true,stored:false,error:'accion invalida'})
        if(action==='prepare'){
          try{
            await ensureEditorialSchema(env)
            const rawText=String(msg?.text||msg?.caption||'')
            const parts=rawText.split(/\\n+/).map((x:string)=>x.trim()).filter(Boolean)
            const title=String(parts.find((x:string)=>!x.startsWith('📰')&&!x.startsWith('Fuentes:'))||('Radar '+id)).trim()
            const rows=msg?.reply_markup?.inline_keyboard||[]
            let url=''
            for(const row of rows)for(const btn of row||[])if(btn?.url&&!url)url=String(btn.url)
            const key='telegram:'+id.toLowerCase()
            await env.DB.prepare("INSERT INTO news(source,source_key,title,url,section,published_at,detected_at,status,radar_reason,updated_at,processing_started_at) VALUES(?,?,?,?, 'Telegram',datetime('now'),datetime('now'),'PROCESSING','Seleccionada en Telegram',datetime('now'),datetime('now')) ON CONFLICT(source_key) DO UPDATE SET title=excluded.title,url=excluded.url,status='PROCESSING',updated_at=datetime('now'),processing_started_at=datetime('now')").bind('Telegram/Radar',key,title,url).run()
            await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'Enviada a Elaborando.'})
            if(msg.message_id)await telegramApi(env,'deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id})
            return Response.json({ok:true,stored:true,processing:true,event_id:id})
          }catch(e){
            await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'No se pudo enviar a Elaborando. Pulsa de nuevo.',show_alert:true})
            return Response.json({ok:true,stored:false,error:String(e)})
          }
        }
        if(!env.GITHUB_TOKEN)return Response.json({ok:true,stored:false,error:'github token ausente'})
        try{
          const api='https://api.github.com/repos/fabricelop/europapress-rss/contents/telegram/emergency-requests.json'
          const h={'Authorization':'Bearer '+env.GITHUB_TOKEN,'Accept':'application/vnd.github+json','User-Agent':'tt-control-emergency','Content-Type':'application/json'}
          let gr:any,gj:any,old:any,wr:any
          for(let attempt=0;attempt<4;attempt++){
            gr=await fetch(api,{headers:h});if(!gr.ok)throw new Error('GitHub read '+gr.status)
            gj=await gr.json();old=JSON.parse(atob(String(gj.content||'').replace(/\\n/g,'')));old.requests=Array.isArray(old.requests)?old.requests:[]
            if(!old.requests.some((x:any)=>x.action===action&&x.id===id&&x.message_id===msg.message_id))old.requests.push({action,id,at:new Date().toISOString(),chat,message_id:msg.message_id})
            const body={message:'Registrar accion Telegram '+action,content:btoa(unescape(encodeURIComponent(JSON.stringify(old,null,2)+'\\n'))),sha:gj.sha,branch:'main'}
            wr=await fetch(api,{method:'PUT',headers:h,body:JSON.stringify(body)});if(wr.ok)break
            if(wr.status!==409)throw new Error('GitHub write '+wr.status)
          }
          if(!wr?.ok)throw new Error('GitHub write conflict after retries')
          await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:action==='prepare'?'Preparar registrado':'Accion registrada'})
          return Response.json({ok:true,stored:true})
          /*
          const gj:any=await gr.json(),old=JSON.parse(atob(String(gj.content||'').replace(/\\n/g,'')))
          old.requests=Array.isArray(old.requests)?old.requests:[]
          if(!old.requests.some((x:any)=>x.action===action&&x.id===id&&x.message_id===msg.message_id))old.requests.push({action,id,at:new Date().toISOString(),chat,message_id:msg.message_id})
          const body={message:'Registrar accion Telegram '+action,content:btoa(unescape(encodeURIComponent(JSON.stringify(old,null,2)+'\\n'))),sha:gj.sha,branch:'main'}
          const wr=await fetch(api,{method:'PUT',headers:h,body:JSON.stringify(body)});if(!wr.ok)throw new Error('GitHub write '+wr.status)
          */
        }catch(e){await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'No registrado. Pulsa de nuevo.',show_alert:true});return Response.json({ok:true,stored:false,error:String(e)})}
      }
    }
    await ensureEditorialSchema(env)
    if(req.method==='POST'&&u.pathname==='/api/telegram-credentials'&&req.headers.get('authorization')==='Bearer '+String(env.CHATGPT_BRIDGE_TOKEN||'')){const b:any=await req.json();const token=String(b.token||''),chat=String(b.chat_id||'');if(!token||!chat)return Response.json({error:'Datos incompletos'},{status:400});await env.DB.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('telegram_bot_token',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(token).run();await env.DB.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('telegram_chat_id',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(chat).run();return Response.json({ok:true})}
    if(req.method==='GET'&&u.pathname==='/api/radar-sensitivity'){const s=await env.DB.prepare("SELECT value FROM app_settings WHERE key='radar_sensitivity'").first<{value:string}>();return Response.json({value:Math.max(1,Math.min(5,Number(s?.value||3)))})}
    if(req.method==='POST'&&u.pathname==='/api/radar-sensitivity'){const b:any=await req.json();const v=Math.max(1,Math.min(5,Number(b.value||3)));await env.DB.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('radar_sensitivity',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(String(v)).run();return Response.json({ok:true,value:v})}
    if(req.method==='GET'&&u.pathname==='/api/media-radar-work'){const q:any=await env.DB.prepare("SELECT id,title,url,source,sources_json,source_count,importance,reason,status,first_seen,last_seen FROM media_radar WHERE last_seen>=datetime('now','-12 hours') AND status IN ('NEW','IGNORED','ENTRY','SENT_ENTRY','ALERTED','PREPARING') ORDER BY last_seen DESC LIMIT 300").all();const rows=q.results as any[];const defs=[['EVALUATING','Evaluando','Aún pendiente de clasificación'],['RETRY','Pendientes de reintento','El clasificador no respondió y se volverán a evaluar'],['SINGLE','Solo 1 medio','Acontecimientos detectados por una sola fuente'],['MULTI','Coincidencia 2+ medios','Acontecimientos ya asociados entre varias fuentes'],['IGNORE','Descartables','Evaluadas como poco relevantes'],['ENTRY','Candidatas a Entrada','Revisión humana sin alerta móvil'],['ALERT','Candidatas a Telegram','Importancia alta / alerta móvil'],['PROMOTED','Ya promovidas','Enviadas a Entrada o Elaborando']];const bucket=(r:any)=>r.status==='NEW'&&String(r.reason||'').includes('reintento')?'RETRY':r.status==='NEW'?'EVALUATING':r.status==='IGNORED'?'IGNORE':r.status==='ENTRY'?'ENTRY':r.status==='ALERTED'?'ALERT':'PROMOTED';const groups=defs.map(d=>({key:d[0],label:d[1],description:d[2],news:d[0]==='SINGLE'?rows.filter(r=>Number(r.source_count||1)===1):d[0]==='MULTI'?rows.filter(r=>Number(r.source_count||1)>=2):rows.filter(r=>bucket(r)===d[0])}));const last:any=await env.DB.prepare("SELECT finished_at,discovered,admitted,status FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1").first();const previous:any=await env.DB.prepare("SELECT finished_at,discovered,admitted,status FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1 OFFSET 1").first();return Response.json({groups,count:rows.length,last_run:last,previous_run:previous},{headers:{'cache-control':'no-store'}})}
    if(req.method==='GET'&&u.pathname==='/api/public/media-radar-stats'){const q:any=await env.DB.prepare("SELECT status,COUNT(*) n,ROUND(AVG(source_count),2) avg_sources,MAX(source_count) max_sources FROM media_radar WHERE last_seen>=datetime('now','-24 hours') GROUP BY status").all();const total=(q.results as any[]).reduce((s:number,x:any)=>s+Number(x.n||0),0),kept=(q.results as any[]).filter((x:any)=>['ENTRY','SENT_ENTRY','ALERTED','PREPARING','PREPARED'].includes(x.status)).reduce((s:number,x:any)=>s+Number(x.n||0),0);return Response.json({window_hours:24,total,kept,reduction_pct:total?Math.round((1-kept/total)*1000)/10:0,groups:q.results},{headers:{'access-control-allow-origin':'*','cache-control':'no-store'}})}
    if(req.method==='GET'&&u.pathname==='/api/public/ready-feed'){await ensureEditorialSchema(env);try{const q:any=await env.DB.prepare("SELECT n.*,d.* FROM news n JOIN drafts d ON d.news_id=n.id AND d.version=(SELECT MAX(d2.version) FROM drafts d2 WHERE d2.news_id=n.id) WHERE n.status NOT IN ('DISMISSED','RADAR_DISMISSED') ORDER BY d.updated_at DESC LIMIT 40").all();return Response.json({ready:q.results},{headers:{'access-control-allow-origin':'*','cache-control':'no-store'}})}catch(e){return Response.json({ready:[],diagnostic:String(e)},{headers:{'access-control-allow-origin':'*','cache-control':'no-store'}})}}
    if(req.method==='POST'&&u.pathname==='/api/telegram-webhook'){const secret=req.headers.get('x-telegram-bot-api-secret-token')||'';if(env.TELEGRAM_WEBHOOK_SECRET&&secret!==env.TELEGRAM_WEBHOOK_SECRET)return new Response('Forbidden',{status:403});const update:any=await req.json();const cq=update?.callback_query;if(!cq)return Response.json({ok:true});const data=String(cq.data||''),msg=cq.message||{},chat=String(msg?.chat?.id||'');let allowedChat=String(env.TELEGRAM_CHAT_ID||'');if(!allowedChat){const cs:any=await env.DB.prepare("SELECT value FROM app_settings WHERE key='telegram_chat_id'").first();allowedChat=String(cs?.value||'')}if(allowedChat&&chat!==allowedChat)return Response.json({ok:true});if(data==='delete:message'){await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'🗑️ Mensaje borrado.'});if(msg.message_id)await telegramApi(env,'deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id});return Response.json({ok:true,deleted:true})}if(data.startsWith('emergency:')){const p=data.split(':'),action=p[1]||'',id=p.slice(2).join(':');if(!['prepare','dismiss','confirm'].includes(action)||!id){await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'Acción no válida.'});return Response.json({ok:true})}if(action==='confirm'){await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'Confirmado.'});return Response.json({ok:true})}if(action==='dismiss'){await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'🗑️ Desestimada.'});if(msg.message_id)await telegramApi(env,'deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id});return Response.json({ok:true,status:'DISMISSED',deleted:true})}try{const rawText=String(msg.text||msg.caption||'');const parts=rawText.split(/\n+/).map((x:string)=>x.trim()).filter(Boolean);const title=parts.find((x:string)=>!x.startsWith('📰')&&!x.startsWith('Fuentes:'))||('Telegram '+id);let url='';for(const row of (msg?.reply_markup?.inline_keyboard||[])){for(const b of row||[]){if(b?.url){url=String(b.url);break}}if(url)break}const key='telegram:'+String(id).toLowerCase();await ensureEditorialSchema(env);await env.DB.prepare("INSERT INTO news(source,source_key,title,url,section,published_at,detected_at,status,radar_reason,updated_at,processing_started_at) VALUES(?,?,?,?, 'Telegram',datetime('now'),datetime('now'),'PROCESSING','Seleccionada en Telegram',datetime('now'),datetime('now')) ON CONFLICT(source_key) DO UPDATE SET source=excluded.source,title=excluded.title,url=excluded.url,status='PROCESSING',radar_reason='Seleccionada en Telegram',updated_at=datetime('now'),processing_started_at=datetime('now'),processing_error=NULL").bind('Telegram/Radar',key,title,url).run();await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'🧠 Enviada a Elaborando.'});if(msg.message_id)await telegramApi(env,'deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id});return Response.json({ok:true,status:'PROCESSING',source_key:key})}catch(e){await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'No se pudo enviar a Elaborando. Pulsa de nuevo.',show_alert:true});return Response.json({ok:true,stored:false,error:String(e)})}}if(data.startsWith('media:')){const p=data.split(':'),action=p[1]||'',id=Number(p[2]);if(!['PREPARE','INTERESTING','DISMISS'].includes(action)||!Number.isInteger(id)){await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'Acción no válida.'});return Response.json({ok:true})}const n:any=await env.DB.prepare("SELECT * FROM media_radar WHERE id=?").bind(id).first();if(!n){await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:'Noticia no encontrada.'});return Response.json({ok:true})}if(action==='PREPARE'){const key='media:'+id;await env.DB.prepare("INSERT INTO news(source_key,title,url,section,published_at,detected_at,status,radar_reason,updated_at) VALUES(?,?,?,?,datetime('now'),datetime('now'),'PROCESSING','Seleccionada desde Radar',datetime('now')) ON CONFLICT(source_key) DO UPDATE SET status='PROCESSING',updated_at=datetime('now')").bind(key,n.title,n.url,'Radar').run();await env.DB.prepare("UPDATE media_radar SET status='PREPARING' WHERE id=?").bind(id).run()}else await env.DB.prepare("UPDATE media_radar SET status=? WHERE id=?").bind(action==='INTERESTING'?'INTERESTING':'DISMISSED',id).run();const ack=await telegramApi(env,'answerCallbackQuery',{callback_query_id:cq.id,text:action==='PREPARE'?'Enviada a Elaborando.':action==='INTERESTING'?'Marcada como interesante.':'Descartada.'});const del=msg.message_id?await telegramApi(env,'deleteMessage',{chat_id:msg.chat.id,message_id:msg.message_id}):{ok:false,error:'message_id ausente'};if(!del?.ok)await env.DB.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('telegram_last_delete_error',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(JSON.stringify({id,chat:msg?.chat?.id,message_id:msg.message_id,error:del?.error||del?.status||'unknown'})).run();return Response.json({ok:true,status:action,telegram_ack:!!ack?.ok,telegram_deleted:!!del?.ok})}return Response.json({ok:true})}
    if(req.method==='GET'&&u.pathname==='/api/telegram-delete-diagnostic'&&authorized(req,env)){const s:any=await env.DB.prepare("SELECT value,updated_at FROM app_settings WHERE key='telegram_last_delete_error'").first();return Response.json({last_delete_error:s||null})}
    if(req.method==='POST'&&u.pathname==='/api/control'){const b:any=await req.json(),v=String(b.text||'').trim().slice(0,4000);if(!v)return Response.json({error:'Consigna vacía'},{status:400});await env.DB.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('control_instruction',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(v).run();return Response.json({ok:true})}
    if(req.method==='GET'&&u.pathname==='/api/public/media-alerts'){const q=await env.DB.prepare("SELECT * FROM media_radar WHERE status='ALERTED' ORDER BY last_seen DESC LIMIT 20").all();return Response.json({alerts:q.results})}
    if(req.method==='GET'&&u.pathname==='/api/public/media-alerts-feed'){await ensureEditorialSchema(env);const q=await env.DB.prepare("SELECT * FROM media_radar WHERE status='ALERTED' ORDER BY last_seen DESC LIMIT 20").all();return Response.json({alerts:q.results},{headers:{'access-control-allow-origin':'*','cache-control':'no-store'}})}
    if(req.method==='GET'&&u.pathname==='/api/public/media-test-candidate'){await ensureEditorialSchema(env);try{const n:any=await env.DB.prepare("SELECT * FROM media_radar WHERE status IN ('NEW','ENTRY','IGNORED') ORDER BY last_seen DESC LIMIT 1").first();return Response.json({candidate:n||null},{headers:{'access-control-allow-origin':'*','cache-control':'no-store'}})}catch(e){return Response.json({candidate:null,diagnostic:String(e)},{headers:{'access-control-allow-origin':'*','cache-control':'no-store'}})}}
    if(req.method==='POST'&&u.pathname==='/api/media-alert/action'&&authorized(req,env)){const b:any=await req.json(),id=Number(b.id),action=String(b.action||'');const n:any=await env.DB.prepare("SELECT * FROM media_radar WHERE id=?").bind(id).first();if(!n)return Response.json({error:'Alerta no encontrada'},{status:404});if(action==='PREPARE'){const key='media:'+id;await env.DB.prepare("INSERT INTO news(source_key,title,url,section,published_at,detected_at,status,radar_reason,updated_at) VALUES(?,?,?,?,datetime('now'),datetime('now'),'PROCESSING','Seleccionada desde Radar de medios',datetime('now')) ON CONFLICT(source_key) DO UPDATE SET status='PROCESSING',updated_at=datetime('now')").bind(key,n.title,n.url,'Radar de medios').run();await env.DB.prepare("UPDATE media_radar SET status='PREPARING' WHERE id=?").bind(id).run();return Response.json({ok:true,status:'PROCESSING'})}if(action==='INTERESTING'||action==='DISMISS'){await env.DB.prepare("UPDATE media_radar SET status=? WHERE id=?").bind(action==='INTERESTING'?'INTERESTING':'DISMISSED',id).run();return Response.json({ok:true,status:action})}return Response.json({error:'Acción inválida'},{status:400})}
    if(req.method==='POST'&&u.pathname==='/api/media-radar/run'&&authorized(req,env))return Response.json(await runMediaRadar(env))

    // Private editorial bridge. This is deliberately separate from the browser session:
    // a future ChatGPT connector/automation can read PROCESSING items and return verified drafts.
    if(u.pathname==='/api/agent/run'){
      if(!agentAuthorized(req,env))return Response.json({error:'No autorizado'},{status:401})
      if(req.method!=='POST')return new Response('Method Not Allowed',{status:405})
      const result:any=await ingest(env)
      result.backlogDismissed=await reclassifyBacklog(env)
      return Response.json(result)
    }
    if(u.pathname==='/api/agent/pending'){
      if(!agentAuthorized(req,env))return Response.json({error:'No autorizado'},{status:401})
      if(req.method!=='GET')return new Response('Method Not Allowed',{status:405})
      try{
        const q=await env.DB.prepare("SELECT * FROM news WHERE status='PROCESSING' LIMIT 50").all()
        return Response.json({news:q.results,control_instruction:null,editorial_instructions:{remates:"Tres remates cuando proceda; nunca bromear sobre víctimas o sufrimiento.",length:"Cada variante debe caber en 280 caracteres."},radar:{positive_samples:0,negative_samples:0,minimum_positive:5,minimum_negative:20,learning_active:false,status_counts:{}}})
      }catch(e){return Response.json({news:[],error:'pending_query_failed',detail:String(e)},{status:200})}
    }
    if(u.pathname==='/api/agent/image'){
      if(!agentAuthorized(req,env))return Response.json({error:'No autorizado'},{status:401})
      if(req.method!=='POST')return new Response('Method Not Allowed',{status:405})
      const b:any=await req.json().catch(()=>({})),id=Number(b.id),slot=String(b.slot||'').toUpperCase()
      if(!id||!['A','B','C'].includes(slot))return Response.json({error:'id/slot inválido'},{status:400})
      const data=String(b.image_base64||'').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/,'')
      const mime=String(b.mime_type||'image/png').toLowerCase()
      if(!data||data.length>8_000_000||!['image/png','image/jpeg','image/webp'].includes(mime))return Response.json({error:'Imagen inválida o demasiado grande'},{status:400})
      const d=await env.DB.prepare("SELECT id FROM drafts WHERE news_id=? ORDER BY version DESC LIMIT 1").bind(id).first<{id:number}>()
      if(!d)return Response.json({error:'Borrador no encontrado'},{status:404})
      const col=slot==='A'?'image_a_url':slot==='B'?'image_b_url':'image_c_url'
      const url='/api/editorial-image/'+d.id+'/'+slot
      await env.DB.batch([
        env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'editorial_image_'+?, ?,datetime('now'))").bind(id,slot,JSON.stringify({mime,data})),
        env.DB.prepare("UPDATE drafts SET "+col+"=?,updated_at=datetime('now') WHERE id=?").bind(url,d.id)
      ])
      return Response.json({ok:true,id,slot,image_url:url})
    }
    if(u.pathname==='/api/agent/complete'){
      if(!agentAuthorized(req,env))return Response.json({error:'No autorizado'},{status:401})
      if(req.method!=='POST')return new Response('Method Not Allowed',{status:405})
      const b:any=await req.json()
      const id=Number(b.id)
      const disposition=String(b.disposition||'READY').toUpperCase()
      if(!id)return Response.json({error:'id inválido'},{status:400})
      if(disposition==='DISMISSED'){
        const reason=String(b.reason||'Descartada por criterio editorial').slice(0,1000)
        await env.DB.batch([
          env.DB.prepare("UPDATE news SET status='DISMISSED',processing_error=NULL,processing_finished_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='PROCESSING'").bind(id),
          env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'agent_dismissed',?,datetime('now'))").bind(id,reason)
        ])
        return Response.json({ok:true,id,status:'DISMISSED',reason})
      }
      const base=String(b.base_text||'').trim(),a=String(b.remate_a||'').trim(),rb=String(b.remate_b||'').trim(),rc=String(b.remate_c||'').trim();const ia=String(b.image_a_url||'').trim(),ib=String(b.image_b_url||'').trim(),ic=String(b.image_c_url||'').trim()
      if(!base||!a||!rb||!rc)return Response.json({error:'Faltan base_text o alguno de los tres remates'},{status:400})
      if([a,rb,rc].some(x=>base.length+' 🌶️ '.length+x.length>280))return Response.json({error:'Base + 🌶️ + remate supera 280 caracteres'},{status:400})
      const last=await env.DB.prepare("SELECT COALESCE(MAX(version),0) AS v FROM drafts WHERE news_id=?").bind(id).first<{v:number}>()
      const version=Number(last?.v||0)+1
      await env.DB.batch([
        env.DB.prepare("INSERT INTO drafts(news_id,base_text,remate_a,remate_b,remate_c,research,sources_json,image_url,image_a_url,image_b_url,image_c_url,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))").bind(id,base,a,rb,rc,String(b.research||''),JSON.stringify(Array.isArray(b.sources)?b.sources:[]),String(b.image_url||''),ia,ib,ic,version),
        env.DB.prepare("UPDATE news SET status='READY',processing_error=NULL,processing_finished_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('PROCESSING','DISMISSED')").bind(id),
        env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'agent_completed',?,datetime('now'))").bind(id,String(version))
      ])
      const mediaRow:any=await env.DB.prepare("SELECT id FROM media_radar WHERE status='PREPARING' AND ('media:'||id)=(SELECT source_key FROM news WHERE id=?)").bind(id).first()
      if(mediaRow)await env.DB.prepare("UPDATE media_radar SET status='PREPARED' WHERE id=?").bind(mediaRow.id).run()
      return Response.json({ok:true,id,version,status:'READY',from_media_radar:!!mediaRow})
    }
    if(u.pathname==='/api/agent/error'){
      if(!agentAuthorized(req,env))return Response.json({error:'No autorizado'},{status:401})
      if(req.method!=='POST')return new Response('Method Not Allowed',{status:405})
      const b:any=await req.json(),id=Number(b.id),message=String(b.error||'Error de elaboración').slice(0,1000)
      if(!id)return Response.json({error:'id inválido'},{status:400})
      await env.DB.prepare("UPDATE news SET processing_error=?,updated_at=datetime('now') WHERE id=? AND status='PROCESSING'").bind(message,id).run()
      return Response.json({ok:true,id})
    }
    if(req.method==='POST'&&u.pathname==='/login'){const form=await req.formData(),p=String(form.get('password')||'');if(!env.TT_CONTROL_PASSWORD||p!==env.TT_CONTROL_PASSWORD)return login('Contraseña incorrecta');return new Response(null,{status:303,headers:{location:'/','set-cookie':'tt_control='+encodeURIComponent(p)+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000'}})}
    if(req.method==='POST'&&u.pathname==='/api/share'){
      const b:any=await req.json().catch(()=>({})),shareKey=String(b.key||u.searchParams.get('key')||'')
      if(!env.TT_CONTROL_PASSWORD||shareKey!==env.TT_CONTROL_PASSWORD)return Response.json({ok:false,error:'No autorizado'},{status:401})
      const rawUrl=Array.isArray(b.url)?b.url.map((x:any)=>String(x||'')).join(' '):String(b.url||'')
      const rawText=String(b.title||b.text||'').trim()
      const firstUrl=(rawUrl+' '+rawText).match(/https?:\/\/[^\s,]+/)?.[0]?.trim()||''
      const xm=firstUrl.match(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([^/?#]+)\/status\/(\d+)/i)
      const url=xm?'https://x.com/'+xm[1]+'/status/'+xm[2]:firstUrl
      const cleanText=rawText.replace(/https?:\/\/[^\s,]+/g,'').replace(/^\\s*[-–—|]+\\s*|\\s*[-–—|]+\\s*$/g,'').trim()
      let title=cleanText||url
      if(url&&/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(url)&&(!cleanText||cleanText===url)){
        const statusId=url.match(/\/status\/(\d+)/)?.[1]
        if(statusId){
          try{
            const oe=await fetch('https://publish.twitter.com/oembed?omit_script=1&dnt=1&url='+encodeURIComponent(url),{headers:{'user-agent':'TT-Control/1.0'}})
            if(oe.ok){const j:any=await oe.json();const h=String(j.html||'');const p0=h.indexOf('<p');const p1=p0>=0?h.indexOf('>',p0):-1;const p2=p1>=0?h.indexOf('</p>',p1):-1;const m=p1>=0&&p2>p1?['',h.slice(p1+1,p2)]:null;if(m)title=m[1].replaceAll('<br>',' ').replaceAll('<br/>',' ').replaceAll('<br />',' ').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim()}
          }catch(_){}
          if(!title||title===url){try{const fx=await fetch('https://api.fxtwitter.com/status/'+statusId,{headers:{'user-agent':'TT-Control/1.0'}});if(fx.ok){const j:any=await fx.json();title=String(j?.tweet?.text||j?.tweet?.raw_text||url).trim()}}catch(_){}}
        }
      }
      if(!url&&!title)return Response.json({ok:false,error:'Falta enlace o texto compartido'},{status:400})
      const key=(url||('manual:'+title)).toLowerCase(),label=title
      const row=await env.DB.prepare("INSERT INTO news(source,source_key,title,url,section,published_at,detected_at,status,radar_reason,updated_at,processing_started_at) VALUES('manual',?,?,?,'Manual',datetime('now'),datetime('now'),'PROCESSING','Compartida desde iOS',datetime('now'),datetime('now')) ON CONFLICT(source_key) DO UPDATE SET status='PROCESSING',processing_started_at=datetime('now'),updated_at=datetime('now') RETURNING id").bind(key,label,url).first<{id:number}>()
      await env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'manual_submission','ios_share',datetime('now'))").bind(row!.id).run()
      return Response.json({ok:true,id:row!.id,status:'PROCESSING'})
    }
    if(req.method==='POST'&&u.pathname==='/api/internal/restore-juan-carlos'&&agentAuthorized(req,env)){const n:any=await env.DB.prepare("SELECT id,status,title FROM news WHERE lower(title) LIKE '%juan carlos%' AND lower(title) LIKE '%francia%' ORDER BY published_at DESC,id DESC LIMIT 1").first();if(!n)return Response.json({error:'Noticia no encontrada'},{status:404});await env.DB.batch([env.DB.prepare("UPDATE news SET status='PROCESSING',processing_started_at=datetime('now'),processing_finished_at=NULL,processing_error=NULL,updated_at=datetime('now') WHERE id=?").bind(n.id),env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'manual_restore_processing',?,datetime('now'))").bind(n.id,String(n.status||''))]);return Response.json({ok:true,id:n.id,title:n.title,previous_status:n.status,status:'PROCESSING'})}
    if(req.method==='GET'&&u.pathname==='/api/public/ready-count'){const row=await env.DB.prepare("SELECT COUNT(*) AS n,COALESCE(GROUP_CONCAT(id,','),'') AS ids FROM (SELECT id FROM news WHERE status='READY' ORDER BY id)").first<{n:number,ids:string}>();return Response.json({ready:Number(row?.n||0),signature:String(row?.ids||'')},{headers:{'cache-control':'no-store'}})}
    if(!authorized(req,env))return req.method==='GET'?new Response(null,{status:302,headers:{location:'/login'}}):Response.json({error:'No autorizado'},{status:401})
    if(req.method==='GET'&&u.pathname==='/media-action'){const id=Number(u.searchParams.get('id')),action=String(u.searchParams.get('action')||'');const n:any=await env.DB.prepare("SELECT * FROM media_radar WHERE id=?").bind(id).first();if(!n)return new Response('Alerta no encontrada',{status:404});if(action==='PREPARE'){const key='media:'+id;await env.DB.prepare("INSERT INTO news(source_key,title,url,section,published_at,detected_at,status,radar_reason,updated_at) VALUES(?,?,?,?,datetime('now'),datetime('now'),'PROCESSING','Seleccionada desde Radar de medios',datetime('now')) ON CONFLICT(source_key) DO UPDATE SET status='PROCESSING',updated_at=datetime('now')").bind(key,n.title,n.url,'Radar de medios').run();await env.DB.prepare("UPDATE media_radar SET status='PREPARING' WHERE id=?").bind(id).run();return Response.redirect(new URL('/?view=PROCESSING&prepare='+id,u).toString(),302)}if(action==='INTERESTING'||action==='DISMISS'){await env.DB.prepare("UPDATE media_radar SET status=? WHERE id=?").bind(action==='INTERESTING'?'INTERESTING':'DISMISSED',id).run();return Response.redirect(new URL('/',u).toString(),302)}return new Response('Acción inválida',{status:400})}
    if(req.method==='GET'&&u.pathname==='/')return new Response(HTML,{headers:{'content-type':'text/html;charset=UTF-8'}})
    if(req.method==='GET'&&u.pathname==='/api/news'){const requested=u.searchParams.get('status')||'NEW';const status=['NEW','SELECTED','PROCESSING','READY','PUBLISHED','RADAR_DISMISSED'].includes(requested)?requested:'NEW';const q=await env.DB.prepare("SELECT n.id,n.title,n.url,n.section,n.published_at,n.urgent,p.variant,p.final_text,p.published_at AS publication_at FROM news n LEFT JOIN publications p ON p.news_id=n.id WHERE n.status=? ORDER BY n.urgent DESC, CASE WHEN n.status='PUBLISHED' THEN COALESCE(p.published_at,n.published_at) END DESC, CASE WHEN n.status<>'PUBLISHED' THEN n.published_at END ASC, n.id ASC LIMIT 200").bind(status).all();const counts=await env.DB.prepare("SELECT status,COUNT(*) AS n FROM news WHERE status IN ('NEW','SELECTED','PROCESSING','READY','PUBLISHED','RADAR_DISMISSED') GROUP BY status").all();const c:any={NEW:0,SELECTED:0,PROCESSING:0,READY:0,PUBLISHED:0,RADAR_DISMISSED:0};for(const row of counts.results as any[])c[row.status]=row.n;return Response.json({news:q.results,counts:c})}
    const editorialImageMatch=u.pathname.match(/^\/api\/editorial-image\/(\d+)\/([ABC])$/)
    if(req.method==='GET'&&editorialImageMatch){
      const did=Number(editorialImageMatch[1]),slot=editorialImageMatch[2]
      const d=await env.DB.prepare("SELECT news_id FROM drafts WHERE id=?").bind(did).first<{news_id:number}>()
      if(!d)return new Response('Not Found',{status:404})
      const row=await env.DB.prepare("SELECT value FROM editorial_feedback WHERE news_id=? AND kind=? ORDER BY id DESC LIMIT 1").bind(d.news_id,'editorial_image_'+slot).first<{value:string}>()
      if(!row?.value)return new Response('Not Found',{status:404})
      try{const j=JSON.parse(row.value),bin=atob(j.data),bytes=Uint8Array.from(bin,(x:string)=>x.charCodeAt(0));return new Response(bytes,{headers:{'content-type':j.mime||'image/png','cache-control':'private,max-age=86400'}})}catch(_){return new Response('Not Found',{status:404})}
    }
    const aiImageMatch=u.pathname.match(/^\/api\/ai-image\/(\d+)$/)
    if(req.method==='GET'&&aiImageMatch){
      const did=Number(aiImageMatch[1]);const d=await env.DB.prepare("SELECT ai_image_base64 FROM drafts WHERE id=?").bind(did).first<{ai_image_base64:string}>()
      if(!d?.ai_image_base64)return new Response('Not Found',{status:404})
      const bin=atob(d.ai_image_base64),bytes=Uint8Array.from(bin,x=>x.charCodeAt(0))
      return new Response(bytes,{headers:{'content-type':'image/jpeg','cache-control':'private,max-age=86400'}})
    }
    if(req.method==='POST'&&u.pathname==='/api/news/ai-image'){
      const b:any=await req.json().catch(()=>({})),id=Number(b.id)
      const n=await env.DB.prepare("SELECT id,title,status FROM news WHERE id=?").bind(id).first<any>()
      const d=await env.DB.prepare("SELECT id,base_text,ai_image_base64 FROM drafts WHERE news_id=? ORDER BY version DESC LIMIT 1").bind(id).first<any>()
      if(!n||!d)return Response.json({error:'Noticia o borrador no encontrado'},{status:404})
      if(d.ai_image_base64&&!b.regenerate)return Response.json({ok:true,image_url:'/api/ai-image/'+d.id})
      const styles=['classic European newspaper caricature, elegant hand ink linework with restrained watercolor','1960s pop-art editorial comic, bold flat shapes and halftone texture','cinematic editorial parody rendered as sophisticated hand-drawn illustration','European satirical magazine cover, clever visual metaphor and confident brushwork','minimal editorial cartoon, sparse background and one strong absurd visual idea','modern hand-drawn press cartoon, loose expressive ink and tasteful color'];const style=styles[(id+(b.regenerate?Date.now():0))%styles.length];
      const raw=String(d.base_text||n.title);
      const safe=raw.replace(/\b(sex|sexual|porn|nude|naked|kill|killed|dead|death|blood|weapon|gun|shoot|rape|abuse)\w*/gi,'').replace(/\s+/g,' ').slice(0,420);
      const prompt='Sophisticated editorial press cartoon. News context: '+safe+'. Invent one clever visual metaphor specific to the news. Do not merely draw a famous person holding the obvious object from the headline. Style: '+style+'. Aim for the quality of a professional European newspaper cartoon: confident hand-drawn line, intentional composition, recognizable public figure only when central to the news, natural proportions pushed selectively for caricature, intelligent visual humor, uncluttered background. Avoid childish clip-art, ugly distortion, giant heads, random extra people, generic podium scenes, crude grotesque faces, bland 3D, photorealism, text, captions, logos and signatures. The picture itself should contain the joke. Family-safe editorial illustration.';
      try{
        const out:any=await env.AI.run('@cf/black-forest-labs/flux-1-schnell',{prompt,steps:4})
        if(!out?.image)throw new Error('Sin imagen')
        await env.DB.prepare("UPDATE drafts SET ai_image_base64=?,image_url=?,updated_at=datetime('now') WHERE id=?").bind(String(out.image),'/api/ai-image/'+d.id,d.id).run()
        return Response.json({ok:true,image_url:'/api/ai-image/'+d.id})
      }catch(e:any){return Response.json({error:'No se pudo generar la imagen IA: '+String(e?.message||e)},{status:500})}
    }
    const detailMatch=u.pathname.match(/^\/api\/news\/(\d+)$/)
    if(req.method==='GET'&&detailMatch){const id=Number(detailMatch[1]);const n=await env.DB.prepare("SELECT * FROM news WHERE id=?").bind(id).first();if(!n)return Response.json({error:'Noticia no encontrada'},{status:404});const d=await env.DB.prepare("SELECT * FROM drafts WHERE news_id=? ORDER BY version DESC LIMIT 1").bind(id).first();const instruction=await env.DB.prepare("SELECT value FROM editorial_feedback WHERE news_id=? AND kind='selection_instruction' ORDER BY id DESC LIMIT 1").bind(id).first<{value:string}>();return Response.json({news:n,draft:d,selection_instruction:instruction?.value||''})}
    if(req.method==='GET'&&u.pathname==='/api/news/radar-dismissed'){const q=await env.DB.prepare("SELECT id,title,url,section,published_at,radar_reason FROM news WHERE status='RADAR_DISMISSED' ORDER BY published_at DESC,id DESC LIMIT 200").all();return Response.json({news:q.results})}
    if(req.method==='POST'&&u.pathname==='/api/news/radar-feedback'){const b:any=await req.json(),id=Number(b.id),agree=!!b.agree,comment=String(b.comment||'').trim().slice(0,2000);if(!id)return Response.json({error:'id inválido'},{status:400});const n=await env.DB.prepare("SELECT status FROM news WHERE id=?").bind(id).first<{status:string}>();if(!n||n.status!=='RADAR_DISMISSED')return Response.json({error:'La noticia no está en descartes del radar'},{status:409});const status=agree?'DISMISSED':'NEW',value=agree?'AGREE':'DISAGREE';const stmts:any[]=[env.DB.prepare("UPDATE news SET status=?,updated_at=datetime('now') WHERE id=?").bind(status,id),env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'radar_feedback',?,datetime('now'))").bind(id,value)];if(!agree&&comment)stmts.push(env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'radar_reconsider_reason',?,datetime('now'))").bind(id,comment));await env.DB.batch(stmts);return Response.json({ok:true,status,comment_saved:!!comment})}
    if(req.method==='POST'&&u.pathname==='/api/news/radar-feedback-all'){const rows=await env.DB.prepare("SELECT id FROM news WHERE status='RADAR_DISMISSED'").all();const ids=(rows.results as any[]).map(x=>Number(x.id)).filter(Boolean);if(!ids.length)return Response.json({ok:true,count:0});const stmts:any[]=[];for(const id of ids){stmts.push(env.DB.prepare("UPDATE news SET status='DISMISSED',updated_at=datetime('now') WHERE id=? AND status='RADAR_DISMISSED'").bind(id));stmts.push(env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'radar_feedback','AGREE',datetime('now'))").bind(id))}await env.DB.batch(stmts);return Response.json({ok:true,count:ids.length,status:'DISMISSED'})}
    if(req.method==='POST'&&u.pathname==='/api/news/recover'){const b:any=await req.json();await env.DB.batch([env.DB.prepare("UPDATE news SET status='NEW',updated_at=datetime('now') WHERE id=?").bind(b.id),env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'radar_recovery','1',datetime('now'))").bind(b.id)]);return Response.json({ok:true})}
    if(req.method==='POST'&&u.pathname==='/api/news/manual'){const b:any=await req.json(),url=String(b.url||'').trim(),title=String(b.title||'').trim();if(!url&&!title)return Response.json({error:'Falta enlace o titular'},{status:400});if(/^CONTROL\\b/i.test(title)){const v=title.replace(/^CONTROL\\s*[:\\-]?\\s*/i,'').trim().slice(0,4000);if(!v)return Response.json({error:'Consigna vacía'},{status:400});await env.DB.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES('control_instruction',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')").bind(v).run();return Response.json({ok:true,control:true})}const key='manual:'+((url||title).toLowerCase());const label=title||url;const row=await env.DB.prepare("INSERT INTO news(source,source_key,title,url,section,published_at,detected_at,status,radar_reason,updated_at,processing_started_at) VALUES('manual',?,?,?,'Manual',datetime('now'),datetime('now'),'PROCESSING','Añadida manualmente por el usuario',datetime('now'),datetime('now')) ON CONFLICT(source_key) DO UPDATE SET status='PROCESSING',updated_at=datetime('now') RETURNING id").bind(key,label,url).first<{id:number}>();await env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'manual_submission','1',datetime('now'))").bind(row!.id).run();return Response.json({ok:true,id:row!.id,status:'PROCESSING'})}
    if(req.method==='POST'&&u.pathname==='/api/news/status'){const b:any=await req.json();if(!['NEW','PROCESSING','DISMISSED','INTERESTING'].includes(b.status))return Response.json({error:'Estado inválido'},{status:400});const comment=String(b.comment||'').trim().slice(0,2000);await env.DB.prepare("UPDATE news SET status=?,processing_started_at=CASE WHEN ?='PROCESSING' THEN datetime('now') ELSE processing_started_at END,processing_error=CASE WHEN ?='PROCESSING' THEN NULL ELSE processing_error END,updated_at=datetime('now') WHERE id=?").bind(b.status,b.status,b.status,b.id).run();try{const stmts=[env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'selection',?,datetime('now'))").bind(b.id,b.status)];if(comment){const kind=b.status==='PROCESSING'?'selection_instruction':b.status==='INTERESTING'?'interesting_reason':'dismiss_reason';stmts.push(env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,?,?,datetime('now'))").bind(b.id,kind,comment))}await env.DB.batch(stmts)}catch(_){}return Response.json({ok:true,comment_saved:!!comment})}
    if(req.method==='GET'&&u.pathname==='/api/image-proxy'){const x=u.searchParams.get('url')||'';if(!/^https:\/\//i.test(x))return new Response('URL inválida',{status:400});try{const r=await fetch(x,{headers:{'user-agent':'TT-Control/1.0'}});if(!r.ok)return new Response('No disponible',{status:502});const ct=r.headers.get('content-type')||'';if(!ct.startsWith('image/'))return new Response('No es imagen',{status:415});return new Response(r.body,{headers:{'content-type':ct,'cache-control':'public,max-age=3600'}})}catch(_){return new Response('No disponible',{status:502})}}
    if(req.method==='POST'&&u.pathname==='/api/news/restore-processing'&&authorized(req,env)){const b:any=await req.json(),id=Number(b.id),match=String(b.match||'').trim();let n:any=null;if(id)n=await env.DB.prepare("SELECT id,status,title FROM news WHERE id=?").bind(id).first();else if(match)n=await env.DB.prepare("SELECT id,status,title FROM news WHERE lower(title) LIKE ? ORDER BY published_at DESC,id DESC LIMIT 1").bind('%'+match.toLowerCase()+'%').first();if(!n)return Response.json({error:'Noticia no encontrada'},{status:404});await env.DB.batch([env.DB.prepare("UPDATE news SET status='PROCESSING',processing_started_at=datetime('now'),processing_finished_at=NULL,processing_error=NULL,updated_at=datetime('now') WHERE id=?").bind(n.id),env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'manual_restore_processing',?,datetime('now'))").bind(n.id,String(n.status||''))]);return Response.json({ok:true,id:n.id,title:n.title,previous_status:n.status,status:'PROCESSING'})}
    if(req.method==='POST'&&u.pathname==='/api/news/processing-status'){const b:any=await req.json(),id=Number(b.id),status=String(b.status||'');if(!id||!['NEW','DISMISSED'].includes(status))return Response.json({error:'Estado inválido'},{status:400});const n=await env.DB.prepare("SELECT status FROM news WHERE id=?").bind(id).first<{status:string}>();if(!n)return Response.json({error:'Noticia no encontrada'},{status:404});if(n.status!=='PROCESSING')return Response.json({error:'La noticia ya no está en Elaborando'},{status:409});await env.DB.batch([env.DB.prepare("UPDATE news SET status=?,processing_started_at=NULL,processing_error=NULL,updated_at=datetime('now') WHERE id=?").bind(status,id),env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'processing_decision',?,datetime('now'))").bind(id,status)]);return Response.json({ok:true,id,status})}
    if(req.method==='POST'&&u.pathname==='/api/news/rewrite'){const b:any=await req.json(),id=Number(b.id),reason=String(b.reason||'').trim().slice(0,1000);if(!id)return Response.json({error:'id inválido'},{status:400});const n=await env.DB.prepare("SELECT status FROM news WHERE id=?").bind(id).first<{status:string}>();if(!n)return Response.json({error:'Noticia no encontrada'},{status:404});if(n.status!=='READY')return Response.json({error:'La noticia no está en Listas'},{status:409});await env.DB.batch([env.DB.prepare("UPDATE news SET status='PROCESSING',processing_started_at=datetime('now'),processing_finished_at=NULL,processing_error=NULL,updated_at=datetime('now') WHERE id=?").bind(id),env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'rewrite_request',?,datetime('now'))").bind(id,reason||'Ninguno de los remates convence; generar tres nuevos')]);return Response.json({ok:true,id,status:'PROCESSING',reason:reason})}
    if(req.method==='POST'&&u.pathname==='/api/news/publish'){const b:any=await req.json(),id=Number(b.id),variant=String(b.variant||'').toUpperCase();if(!id||!['BASE','A','B','C'].includes(variant))return Response.json({error:'Publicación inválida'},{status:400});const n=await env.DB.prepare("SELECT status FROM news WHERE id=?").bind(id).first<{status:string}>();if(!n)return Response.json({error:'Noticia no encontrada'},{status:404});if(n.status!=='READY')return Response.json({error:'La noticia no está en Listas'},{status:409});const d:any=await env.DB.prepare("SELECT * FROM drafts WHERE news_id=? ORDER BY version DESC LIMIT 1").bind(id).first();if(!d)return Response.json({error:'No hay borrador'},{status:409});const rem=variant==='A'?d.remate_a:variant==='B'?d.remate_b:variant==='C'?d.remate_c:'';const finalText=String(d.base_text||'')+(rem?' 🌶️ '+String(rem):'');if(finalText.length>280)return Response.json({error:'La variante supera 280 caracteres'},{status:400});await env.DB.batch([env.DB.prepare("INSERT INTO publications(news_id,draft_id,variant,final_text,published_at) VALUES(?,?,?,?,datetime('now'))").bind(id,d.id,variant,finalText),env.DB.prepare("UPDATE news SET status='PUBLISHED',updated_at=datetime('now') WHERE id=? AND status='READY'").bind(id),env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'published_variant',?,datetime('now'))").bind(id,variant)]);return Response.json({ok:true,id,variant,status:'PUBLISHED'})}
    if(req.method==='POST'&&u.pathname==='/api/news/interesting-ready'){const b:any=await req.json(),id=Number(b.id);if(!id)return Response.json({error:'id inválido'},{status:400});const n=await env.DB.prepare("SELECT status FROM news WHERE id=?").bind(id).first<{status:string}>();if(!n)return Response.json({error:'Noticia no encontrada'},{status:404});if(n.status!=='READY')return Response.json({error:'Solo se puede decidir sobre noticias que estén en Listas'},{status:409});await env.DB.batch([env.DB.prepare("UPDATE news SET status='INTERESTING',updated_at=datetime('now') WHERE id=?").bind(id),env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'ready_decision','INTERESTING_NOT_PUBLISHED',datetime('now'))").bind(id)]);return Response.json({ok:true})}
    if(req.method==='POST'&&u.pathname==='/api/news/discard-ready'){const b:any=await req.json(),id=Number(b.id);if(!id)return Response.json({error:'id inválido'},{status:400});const n=await env.DB.prepare("SELECT status FROM news WHERE id=?").bind(id).first<{status:string}>();if(!n)return Response.json({error:'Noticia no encontrada'},{status:404});if(n.status!=='READY')return Response.json({error:'Solo se pueden borrar noticias que estén en Listas'},{status:409});await env.DB.batch([env.DB.prepare("UPDATE news SET status='DISMISSED',updated_at=datetime('now') WHERE id=?").bind(id),env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'ready_decision','DISMISSED',datetime('now'))").bind(id)]);return Response.json({ok:true})}
    if(req.method==='POST'&&u.pathname==='/api/news/urgent'){const b:any=await req.json(),v=b.value?1:0;await env.DB.prepare("UPDATE news SET urgent=?,updated_at=datetime('now') WHERE id=?").bind(v,b.id).run();try{await env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'urgency',?,datetime('now'))").bind(b.id,String(v)).run()}catch(_){}return Response.json({ok:true})}
    if(req.method==='POST'&&u.pathname==='/api/run'){const result:any=await ingest(env);result.backlogDismissed=await reclassifyBacklog(env);return Response.json(result)}
    return new Response('Not Found',{status:404})
  }catch(e){return Response.json({error:e instanceof Error?e.message:String(e)},{status:500})}
}}
