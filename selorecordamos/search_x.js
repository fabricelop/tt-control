const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const query = '"recordadme" OR "que alguien me recuerde" OR "alguien que me recuerde" OR "alguien me recuerde" OR "que me recuerden" OR "recordarle" OR "recordármelo" OR "recordarmelo" OR "recordárselo" OR "recordarselo" OR "recuérdele" OR "recuerdele" OR "recuérdenle" OR "recuerdenle" OR "@SeLoRecordamos"';
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  const baseDir = path.join(__dirname);
  const outDir = path.join(baseDir, 'debug');
  const stateDir = path.join(baseDir, 'runtime');
  const candidatesDir = path.join(baseDir, 'candidates');
  const outboxFile = path.join(baseDir, 'telegram-outbox.json');
  const seenFile = path.join(stateDir, 'seen.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(candidatesDir, { recursive: true });

  const authToken = process.env.X_AUTH_TOKEN || '';
  const ct0 = process.env.X_CT0 || '';
  const chromePath = process.env.SR_CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '');
  // En el PC Windows se mantiene el navegador visible por defecto. En GitHub Actions/CI
  // no hay servidor gráfico, así que Playwright debe arrancar automáticamente en headless.
  // SR_HEADLESS=1/0 sigue permitiendo forzar explícitamente el comportamiento.
  const headless = process.env.SR_HEADLESS === '1' || (process.env.SR_HEADLESS !== '0' && (process.env.CI === 'true' || process.platform !== 'win32'));
  const backfillSinceRaw = String(process.env.SR_BACKFILL_SINCE || '').trim();
  const parsedSince = backfillSinceRaw ? Date.parse(backfillSinceRaw) : NaN;
  const backfillDays = Math.max(0, Number(process.env.SR_BACKFILL_DAYS || '0') || 0);
  const backfillCutoff = Number.isFinite(parsedSince) ? parsedSince : (backfillDays > 0 ? Date.now() - backfillDays * 86400000 : null);
  const isBackfill = backfillCutoff !== null;

  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch (_) { seen = {}; }
  const launchOptions = { headless };
  if (chromePath && fs.existsSync(chromePath)) launchOptions.executablePath = chromePath;
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ locale:'es-ES', timezoneId:'Europe/Madrid', userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36' });
  if (authToken && ct0) await context.addCookies([{name:'auth_token',value:authToken,domain:'.x.com',path:'/',httpOnly:true,secure:true,sameSite:'None'},{name:'ct0',value:ct0,domain:'.x.com',path:'/',httpOnly:false,secure:true,sameSite:'Lax'}]);
  const page = await context.newPage();
  const result={query,search_url:url,fetched_at:new Date().toISOString(),authenticated_cookie_pair_present:Boolean(authToken&&ct0),mode:isBackfill?`backfill_since_${new Date(backfillCutoff).toISOString()}`:'incremental',final_url:null,title:null,extracted:0,scroll_rounds:0,already_seen:0,rejected:[],candidates:[],status:'unknown',note:null};
  const normalize=text=>text.toLocaleLowerCase('es-ES').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
  const rejectReason=text=>{
    const t=normalize(text);
    if (/\b(si|cuando)\s+(manana\s+)?(me\s+)?(desaparezco|muero|fallezco|palmo)\b/.test(t)||/\bcuando\s+me\s+muera\b/.test(t)) return 'memorial/no es una petición de recordatorio';
    if (/\brecordadme\s+(asi|como\s+(el|la|los|las|quien))\b/.test(t)) return '“recordadme así/como…” se refiere a recordar a la persona';
    if (/\brecordadme\s+(con\s+)?(carino|amor|afecto|ternura|orgullo)\b/.test(t)) return '“recordadme con cariño/afecto/orgullo…” se refiere a recordar a la persona';
    if (/\b(que alguien me recuerde|alguien que me recuerde|alguien me recuerde|que me recuerden|recordadme)\s+con\s+(la\s+)?(cancion|musica|tema)\b/.test(t)) return '“recordarme con una canción/música” se refiere a recordar a la persona';
    if (/\brecordadme\s*[,;:]?\s+y\s+(yo\s+)?os\s+recordare\b/.test(t)) return 'uso de “recordadme” como recordar a una persona, no como servicio de recordatorio';
    if (/\brecordadme\s*[.!?…]*$/.test(t)) return '“recordadme” sin objeto ni acción no contiene una petición concreta';
    if (/\b(que alguien me recuerde|alguien que me recuerde|alguien me recuerde|que me recuerden)\s*[.!?…]*$/.test(t)) return 'petición sin objeto ni acción concreta';

    if (/\bque me recuerden en\s+(?:el|la|los|las|@\w+)\b.{0,100}\b(es|seria|fue|ha sido|alegria|orgullo|honor)\b/.test(t)) return '“que me recuerden en…” expresa recuerdo o reconocimiento, no solicita un recordatorio';

    const directPhrase='(?:que alguien me recuerde|alguien que me recuerde|alguien me recuerde|que me recuerden)';
    const consultationPatterns=[/\brecordadme[,:]?\s+(quien|cual|donde|como|por que|porque)\b/,/\brecordadme[,:]?\s+en\s+(que|cual)\b/,/\brecordadme[,:]?\s+en\s+esta\b/,new RegExp(`\\b${directPhrase}\\s+(quien|cual|donde|como|por que|porque)\\b`),new RegExp(`\\b${directPhrase}\\s+de\\s+(donde|que|cual)\\b`),new RegExp(`\\b${directPhrase}\\s+(una|un)\\s+sol[ao]\\b`)];
    if(consultationPatterns.some(r=>r.test(t))) return 'pregunta/consulta, no recordatorio futuro';
    if(/\brecordadme[,:]?\s+que\s+(quien|que|cual|donde|como)\b/.test(t)) return 'pregunta/consulta, no recordatorio futuro';

    if (/\bgracias\s+por\s+(recordarmelo|recordarselo|recordarle|recordar(?:me|se|le))\b/.test(t)) return 'agradece un recordatorio ya realizado';
    if (/\b(google fotos|facebook|instagram|x)\b.{0,40}\b(recordarmelo|recordarselo|recordarle)\b/.test(t)) return 'una plataforma le está recordando algo; no solicita un nuevo recordatorio';
    if (/\b(me|nos)\s+(recordo|recordaba|recordaron)\b/.test(t)) return 'habla de un recordatorio pasado';

    const hasDirectCore=/\brecordadme\b|\b(que alguien me recuerde|alguien que me recuerde|alguien me recuerde|que me recuerden)\b/.test(t);
    const hasMention=/@selorecordamos\b/.test(t);
    const hasSelfVariant=/\brecordarmelo\b/.test(t);
    const hasThirdVariant=/\b(recordarle|recordarselo|recuerdele|recuerdenle)\b/.test(t);
    const hasAnySearchTerm=hasDirectCore||hasMention||hasSelfVariant||hasThirdVariant;
    const requestCue=/\b(por favor|puedes|puede|podrias|podria|podriais|alguien|que alguien|cuando|manana|luego|despues|esta noche|el lunes|el martes|el miercoles|el jueves|el viernes|el sabado|el domingo|a las\s+\d{1,2})\b/.test(t);
    const imperativeThird=/^(?:@\w+\s+)?(?:por favor\s+)?(?:recuerdele|recuerdenle)\b/.test(t);

    // X puede devolver respuestas/hilos porque el término aparece en el contexto del artículo,
    // aunque no esté en el texto real del tuit. No convertir ese contexto en candidato.
    if (!hasAnySearchTerm) return 'coincidencia solo por contexto/hilo; el texto del tuit no contiene ningún término de búsqueda';
    if (hasMention && !hasDirectCore && !hasSelfVariant && !hasThirdVariant && !requestCue) return 'mención a @SeLoRecordamos sin petición de recordatorio';
    if (hasThirdVariant && !hasDirectCore && !hasMention && !requestCue && !imperativeThird) return 'uso narrativo/opinativo de “recordarle/recordárselo”, sin petición clara';
    if (hasSelfVariant && !hasDirectCore && !hasMention && !requestCue && !/\b(no se me olvide|acordarme|necesito|quiero que me)\b/.test(t)) return '“recordármelo” sin señal de solicitud futura';

    return null;
  };
  const readVisibleTweets=async()=>{const articles=page.locator('article[data-testid="tweet"]');const count=await articles.count();const tweets=[];for(let i=0;i<count;i++){const article=articles.nth(i);const text=await article.locator('[data-testid="tweetText"]').innerText().catch(()=>'');const timeEl=article.locator('time').first();const datetime=await timeEl.getAttribute('datetime').catch(()=>null);const timeHref=await timeEl.locator('xpath=..').getAttribute('href').catch(()=>null);const links=await article.locator('a[href*="/status/"]').evaluateAll(els=>els.map(a=>a.getAttribute('href')).filter(Boolean)).catch(()=>[]);const statusPath=(timeHref&&/^\/[^/]+\/status\/\d+/.test(timeHref))?timeHref:links.find(h=>/^\/[^/]+\/status\/\d+/.test(h));if(!text||!statusPath)continue;const m=statusPath.match(/^\/([^/]+)\/status\/(\d+)/);if(!m)continue;const[,user,id]=m;tweets.push({id,user:`@${user}`,text,datetime,url:`https://x.com/${user}/status/${id}`});}return tweets;};
  try{
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(7000);result.final_url=page.url();result.title=await page.title();const loginVisible=await page.locator('text=Inicia sesión').first().isVisible().catch(()=>false);const extractedMap=new Map();let stableRounds=0,seenBoundaryRounds=0;const maxScrollRounds=isBackfill?200:12;
    for(let round=0;round<maxScrollRounds;round++){const visible=await readVisibleTweets();const before=extractedMap.size;for(const tweet of visible)extractedMap.set(tweet.id,tweet);const added=extractedMap.size-before;result.scroll_rounds=round+1;if(added===0)stableRounds++;else stableRounds=0;if(isBackfill){const dated=visible.map(t=>t.datetime?Date.parse(t.datetime):NaN).filter(Number.isFinite);if(dated.length&&Math.min(...dated)<=backfillCutoff)break;if(stableRounds>=6)break;}else{const visibleIds=visible.map(t=>t.id);const reachedSeenBoundary=visibleIds.some(id=>Boolean(seen[id]));if(reachedSeenBoundary)seenBoundaryRounds++;else seenBoundaryRounds=0;if(seenBoundaryRounds>=2)break;if(stableRounds>=3)break;}await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await page.waitForTimeout(1400);}
    let extracted=Array.from(extractedMap.values());if(isBackfill)extracted=extracted.filter(t=>!t.datetime||Date.parse(t.datetime)>=backfillCutoff);result.extracted=extracted.length;
    for(const tweet of extracted){if(seen[tweet.id]){result.already_seen++;continue;}const reason=rejectReason(tweet.text);seen[tweet.id]={first_seen_at:result.fetched_at,url:tweet.url,rejected:Boolean(reason),datetime:tweet.datetime||null};if(reason){result.rejected.push({...tweet,reason});continue;}const candidate={...tweet,first_seen_at:result.fetched_at,status:'pending'};result.candidates.push(candidate);fs.writeFileSync(path.join(candidatesDir,`${tweet.id}.json`),JSON.stringify(candidate,null,2),'utf8');}
    fs.writeFileSync(seenFile,JSON.stringify(seen,null,2),'utf8');fs.writeFileSync(outboxFile,JSON.stringify({generated_at:result.fetched_at,candidates:result.candidates},null,2),'utf8');
    if(result.candidates.length){result.status='ok';result.note=`${result.candidates.length} candidatos nuevos de ${result.extracted} tuits extraídos.`;}else if(!authToken||!ct0){result.status='missing_secrets';result.note='Faltan X_AUTH_TOKEN y/o X_CT0 en las variables de entorno.';}else if(loginVisible||/login|i\/flow\/login/.test(result.final_url||'')){result.status='auth_required';result.note='Las cookies no han autenticado la sesión de X o han caducado.';}else{result.status='no_new_candidates';result.note=`Sin candidatos nuevos. Extraídos: ${result.extracted}; ya vistos: ${result.already_seen}; descartados: ${result.rejected.length}.`;}
    await page.screenshot({path:path.join(outDir,'search.png'),fullPage:true});fs.writeFileSync(path.join(outDir,'page.html'),await page.content(),'utf8');
  }catch(e){result.status='error';result.note=String(e&&e.stack?e.stack:e);}finally{fs.writeFileSync(path.join(outDir,'results.json'),JSON.stringify(result,null,2),'utf8');console.log(JSON.stringify(result,null,2));await browser.close();}
})();
