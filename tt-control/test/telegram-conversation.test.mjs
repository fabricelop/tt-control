import test from "node:test";
import assert from "node:assert/strict";
import {telegramConversationKind} from "../src/telegram-conversation.js";

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
