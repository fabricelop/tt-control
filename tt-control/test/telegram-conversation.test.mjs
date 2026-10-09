import test from "node:test";
import assert from "node:assert/strict";
import {telegramConversationKind,questionText} from "../src/telegram-conversation.js";
import {parseRssResults,needsResearch,fallbackQuery,researchLinks,researchPrompt,planAndResearch} from "../src/telegram-research.js";

const make=(text,reply=null)=>({
  update_id:2026100917,
  message:{message_id:401,chat:{id:123456},from:{id:10,is_bot:false},text,
    ...(reply?{reply_to_message:reply}:{})}
});
test("mensaje libre crea una sugerencia, nunca una pregunta",()=>{
  assert.equal(telegramConversationKind(make("Investiga el atasco de Madrid")),"proposal");
});
test("responder deslizando una noticia es consulta, nunca una nueva noticia",()=>{
  const news={message_id:300,from:{id:101,is_bot:true},caption:"Atasco en Madrid; tráfico retenido."};
  assert.equal(telegramConversationKind(make("¿Qué carreteras están afectadas?",news)),"question");
});
test("no interceptar bots, comandos o instrucciones CONTROL",()=>{
  assert.equal(telegramConversationKind(make("/boletin")),null);
  assert.equal(telegramConversationKind(make("CONTROL: investiga esto")),null);
  assert.equal(telegramConversationKind(make("Ejecuta TTittulares")),null);
  const bot=make("Yo publico");bot.message.from.is_bot=true;
  assert.equal(telegramConversationKind(bot),null);
});
test("no capturar respuestas a TTendencias ni a otro usuario",()=>{
  assert.equal(telegramConversationKind(make("¿De qué trata?",{from:{is_bot:true},text:"TT#12 tendencia"})),null);
  assert.equal(telegramConversationKind(make("¿Dónde?",{from:{is_bot:false},text:"Hola"})),null);
});

test("se puede preguntar por cualquier tema y conservar respuesta directa",()=>{
  assert.equal(telegramConversationKind(make("¿Quién ganó el Tour?",{message_id:300,from:{is_bot:true},text:"Noticia sobre un atasco de tráfico"})),"question");
  assert.equal(telegramConversationKind(make("¿Y cómo funciona una hipoteca?",{message_id:350,from:{is_bot:true},text:"En respuesta a tu pregunta..."})),"question");
});
test("/chat inicia una conversación nueva sin registrar noticias",()=>{
  assert.equal(telegramConversationKind(make("/chat ¿Cómo funciona la Constitución?")),"question");
  assert.equal(questionText(make("/chat ¿Cómo funciona la Constitución?").message),"¿Cómo funciona la Constitución?");
  assert.equal(telegramConversationKind(make("/pregunta Explícame el impuesto de sucesiones")),"question");
  assert.equal(telegramConversationKind(make("/chat")),null);
  assert.equal(telegramConversationKind(make("Quiero que investigues esta noticia")), "proposal");
});
test("fuentes externas seguras: RSS real y enlaces exactos, sin ejecutar HTML",()=>{
  const xml='<?xml version="1.0"?><rss><channel><item><title>Tráfico &amp; retenciones</title><link>https://example.com/trafico</link><description><![CDATA[Tramos <b>afectados</b>]]></description></item><item><title>Javascript</title><link>javascript:alert(1)</link></item></channel></rss>';
  const rows=parseRssResults(xml,"Noticias");
  assert.equal(rows.length,1);
  assert.equal(rows[0].title,"Tráfico & retenciones");
  assert.equal(rows[0].description,"Tramos afectados");
  assert.equal(rows[0].url,"https://example.com/trafico");
  assert.match(researchLinks({queried:true,results:rows}),/https:\/\/example\.com\/trafico/);
  assert.match(researchPrompt({queried:true,query:"tráfico",results:rows}),/DATOS NO CONFIABLES/);
});
test("búsqueda abierta por tema y seguimiento",()=>{
  assert.equal(needsResearch("Investiga las reformas laborales"),true);
  assert.equal(needsResearch("¿Cuál es el precio de la vivienda?"),true);
  assert.equal(needsResearch("Hola, buenos días"),false);
  assert.match(fallbackQuery("¿Y en Francia?","Noticias sobre los precios de la vivienda").toLowerCase(),/vivienda/);
});

test("investigación libre usa tema nuevo y no vuelve al titular original",async()=>{
  const original=globalThis.fetch;
  const queried=[];
  globalThis.fetch=async (url)=>{
    const u=String(url);queried.push(u);
    if(u.startsWith("https://news.google.com/rss/search")){
      return new Response('<rss><channel><item><title>Informes sobre vivienda</title><link>https://example.com/informe</link><description>Dato de fuentes</description></item></channel></rss>',
        {headers:{"content-type":"application/rss+xml"}});
    }
    if(u.startsWith("https://www.bing.com/search")){
      return new Response("<rss><channel></channel></rss>",{headers:{"content-type":"text/xml"}});
    }
    throw Error("Unexpected external URL "+u);
  };
  try{
    const result=await planAndResearch({AI:{run:async()=>({response:'{"query":"precios de vivienda España 2026","kind":"news"}'})}},
      "¿Y los precios de la vivienda?","Atasco en la autovía");
    assert.equal(result.queried,true);
    assert.match(result.query,/vivienda/);
    assert.equal(result.results[0].url,"https://example.com/informe");
    assert(queried.every(url=>url.includes("vivienda")), "no debe investigar de nuevo el atasco");
  }finally{globalThis.fetch=original;}
});
