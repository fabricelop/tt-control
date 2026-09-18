interface Env { DB: D1Database; TT_CONTROL_PASSWORD: string }

function radarDecision(section:string,title:string):{admit:boolean;reason:string}{
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
function authorized(req:Request,env:Env):boolean{
  if(!env.TT_CONTROL_PASSWORD)return false
  const auth=req.headers.get('authorization')||''
  const cookie=req.headers.get('cookie')||''
  return auth==='Bearer '+env.TT_CONTROL_PASSWORD || cookie.split(';').some(x=>x.trim()==='tt_control='+encodeURIComponent(env.TT_CONTROL_PASSWORD))
}
function login(message=''){return new Response(`<!doctype html><html lang="es"><meta name="viewport" content="width=device-width"><title>TT Control</title><style>body{font-family:system-ui;background:#f4f6f9;display:grid;place-items:center;height:100vh;margin:0}form{background:white;padding:28px;border-radius:14px;box-shadow:0 8px 30px #0002;width:min(360px,88vw)}input,button{width:100%;padding:12px;margin-top:12px;box-sizing:border-box}button{background:#1769e0;color:white;border:0;border-radius:8px}</style><form method="post" action="/login"><h2>TT Control</h2><input type="password" name="password" placeholder="Contraseña" autofocus><button>Entrar</button><p>${message}</p></form></html>`,{headers:{'content-type':'text/html;charset=UTF-8','cache-control':'no-store'}})}

const HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TT Control</title><style>
:root{font-family:Inter,system-ui,sans-serif;color:#172033;background:#f4f6f9}*{box-sizing:border-box}body{margin:0}.top{height:68px;background:#fff;border-bottom:1px solid #dde2ea;display:flex;align-items:center;padding:0 24px;gap:18px;position:sticky;top:0}.brand{font-size:22px;font-weight:800}.run{margin-left:auto;background:#1769e0;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:700}.layout{display:grid;grid-template-columns:210px minmax(430px,1fr) minmax(360px,.9fr);min-height:calc(100vh - 68px)}nav{padding:22px 14px;border-right:1px solid #dde2ea;background:#fff}nav button{display:block;width:100%;text-align:left;border:0;background:none;padding:12px;border-radius:9px;font-size:15px}.active{background:#eaf2ff!important;color:#125bc0;font-weight:700}.list{padding:22px}.detail{padding:22px;border-left:1px solid #dde2ea;background:#fff}.card{background:#fff;border:1px solid #dde2ea;border-radius:12px;padding:15px;margin-bottom:12px}.meta{font-size:12px;color:#667085;margin-bottom:6px}.title{font-weight:700;line-height:1.35}.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}.actions button{border:1px solid #cfd6e1;background:#fff;border-radius:8px;padding:8px 10px}.yes{background:#eaf7ee!important}.no{background:#fff0f0!important}.urgent{color:#b42318;font-weight:800}.empty{color:#667085;padding:30px 0}@media(max-width:850px){.layout{display:block}nav{display:flex;overflow:auto;border-right:0;border-bottom:1px solid #dde2ea;padding:8px}.detail{display:none}.list{padding:12px}.top{padding:0 12px}.brand{font-size:19px}nav button{white-space:nowrap;width:auto}.run{padding:10px 12px}}
</style></head><body><header class="top"><div class="brand">TT Control</div><span id="stamp">TTiTTulares</span><button class="run" onclick="runNow()">▶ EJECUTAR</button></header><main class="layout"><nav><button class="active">Entrada <b id="newCount"></b></button><button>Seleccionadas</button><button>Listas</button><button>Historial</button><button>Descartadas radar</button></nav><section class="list"><h2>Noticias para valorar</h2><div id="news" class="empty">Cargando…</div></section><aside class="detail"><h2>Mesa de redacción</h2><p>Selecciona una noticia. La investigación, versión base y los tres remates se incorporarán en la siguiente fase.</p><p><b>Urgencia</b> y <b>relevancia editorial</b> se aprenden por separado.</p></aside></main><script>
async function load(){const r=await fetch('/api/news');const d=await r.json();newCount.textContent=d.news.length?'('+d.news.length+')':'';news.innerHTML=d.news.length?d.news.map(n=>`<article class="card"><div class="meta">${n.published_at||''} · Europa Press ${n.urgent?'<span class="urgent">· URGENTE</span>':''}</div><div class="title">${esc(n.title)}</div><div class="actions"><button class="yes" onclick="act(${n.id},'SELECTED')">✓ Seleccionar</button><button class="no" onclick="act(${n.id},'DISMISSED')">✕ Desestimar</button><button onclick="urgent(${n.id},${n.urgent?0:1})">${n.urgent?'↓ No era urgente':'↑ Debería ser urgente'}</button></div></article>`).join(''):'<div class="empty">No hay noticias pendientes.</div>'}
function esc(s){return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function act(id,status){await fetch('/api/news/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,status})});load()}
async function urgent(id,value){await fetch('/api/news/urgent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,value})});load()}
async function runNow(){const b=document.querySelector('.run');b.disabled=true;b.textContent='Ejecutando…';try{await fetch('/api/run',{method:'POST'});await load()}finally{b.disabled=false;b.textContent='▶ EJECUTAR'}}
load()
</script></body></html>`;

async function ingest(env:Env){
  const run=await env.DB.prepare("INSERT INTO runs(started_at,trigger) VALUES(datetime('now'),'manual') RETURNING id").first<{id:number}>()
  try{
    const r=await fetch('https://raw.githubusercontent.com/fabricelop/europapress-rss/main/recent.json',{headers:{'user-agent':'TT-Control/1.0'}})
    if(!r.ok)throw new Error('Europa Press repository '+r.status)
    const raw:any=await r.json(),items=Array.isArray(raw)?raw:(raw.items||raw.entries||raw.news||[])
    let admitted=0
    for(const x of items){
      const title=String(x.title||x.titulo||'').trim();if(!title)continue
      const url=String(x.link||x.url||'');const key=url||String(x.id||x.guid||title+'|'+(x.date||x.published||''))
      const published=String(x.published_at||x.published||x.date||x.pubDate||'')
      const section=String(x.section||x.category||''),decision=radarDecision(section,title)
      const status=decision.admit?'NEW':'RADAR_DISMISSED'
      const write=await env.DB.prepare(`INSERT INTO news(source_key,title,url,section,published_at,detected_at,status,radar_reason,updated_at)
        VALUES(?,?,?,?,?,datetime('now'),?,?,datetime('now')) ON CONFLICT(source_key) DO NOTHING`)
        .bind(key,title,url,section,published,status,decision.reason).run()
      if(write.meta.changes&&decision.admit)admitted++
    }
    await env.DB.prepare("UPDATE runs SET finished_at=datetime('now'),discovered=?,admitted=?,status='OK' WHERE id=?").bind(items.length,admitted,run!.id).run()
    return {ok:true,discovered:items.length}
  }catch(e){await env.DB.prepare("UPDATE runs SET finished_at=datetime('now'),status='ERROR',error=? WHERE id=?").bind(String(e),run!.id).run();throw e}
}

export default {async fetch(req:Request,env:Env):Promise<Response>{
  const u=new URL(req.url)
  try{
    if(req.method==='GET'&&u.pathname==='/login')return login()
    if(req.method==='POST'&&u.pathname==='/login'){const form=await req.formData(),p=String(form.get('password')||'');if(!env.TT_CONTROL_PASSWORD||p!==env.TT_CONTROL_PASSWORD)return login('Contraseña incorrecta');return new Response(null,{status:303,headers:{location:'/','set-cookie':'tt_control='+encodeURIComponent(p)+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000'}})}
    if(!authorized(req,env))return req.method==='GET'?new Response(null,{status:302,headers:{location:'/login'}}):Response.json({error:'No autorizado'},{status:401})
    if(req.method==='GET'&&u.pathname==='/')return new Response(HTML,{headers:{'content-type':'text/html;charset=UTF-8'}})
    if(req.method==='GET'&&u.pathname==='/api/news'){const q=await env.DB.prepare("SELECT id,title,url,section,published_at,urgent FROM news WHERE status='NEW' ORDER BY published_at DESC, id DESC LIMIT 200").all();return Response.json({news:q.results})}
    if(req.method==='GET'&&u.pathname==='/api/news/radar-dismissed'){const q=await env.DB.prepare("SELECT id,title,url,section,published_at,radar_reason FROM news WHERE status='RADAR_DISMISSED' ORDER BY published_at DESC,id DESC LIMIT 200").all();return Response.json({news:q.results})}
    if(req.method==='POST'&&u.pathname==='/api/news/recover'){const b:any=await req.json();await env.DB.batch([env.DB.prepare("UPDATE news SET status='NEW',updated_at=datetime('now') WHERE id=?").bind(b.id),env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'radar_recovery','1',datetime('now'))").bind(b.id)]);return Response.json({ok:true})}
    if(req.method==='POST'&&u.pathname==='/api/news/status'){const b:any=await req.json();if(!['SELECTED','DISMISSED'].includes(b.status))return Response.json({error:'Estado inválido'},{status:400});await env.DB.batch([env.DB.prepare("UPDATE news SET status=?,updated_at=datetime('now') WHERE id=?").bind(b.status,b.id),env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'selection',?,datetime('now'))").bind(b.id,b.status)]);return Response.json({ok:true})}
    if(req.method==='POST'&&u.pathname==='/api/news/urgent'){const b:any=await req.json(),v=b.value?1:0;await env.DB.batch([env.DB.prepare("UPDATE news SET urgent=?,updated_at=datetime('now') WHERE id=?").bind(v,b.id),env.DB.prepare("INSERT INTO editorial_feedback(news_id,kind,value,created_at) VALUES(?,'urgency',?,datetime('now'))").bind(b.id,String(v))]);return Response.json({ok:true})}
    if(req.method==='POST'&&u.pathname==='/api/run')return Response.json(await ingest(env))
    return new Response('Not Found',{status:404})
  }catch(e){return Response.json({error:e instanceof Error?e.message:String(e)},{status:500})}
}}
