// TTiTTulares: secretos Telegram trasladados entre GitHub Actions y Cloudflare
// mediante RSA-OAEP-SHA256. En el repositorio sólo se guarda el cifrado.
const ENCRYPTED_URL="https://raw.githubusercontent.com/fabricelop/europapress-rss/main/telegram/ttittulares-chat-credential.enc.json";
let cached=null,expires=0;

export async function readTelegramCredential(env,field){
  if(!["bot_token","chat_id","webhook_secret"].includes(field))return "";
  if(!env.TT_CONTROL_TELEGRAM_PRIVATE_KEY)return "";
  if(!cached||Date.now()>expires){
    const req=await fetch(ENCRYPTED_URL+"?t="+Math.floor(Date.now()/60000),{cache:"no-store"});
    if(!req.ok)throw Error("encrypted_telegram_credentials_unavailable:"+req.status);
    const doc=await req.json();
    if(doc?.algorithm!=="RSA-OAEP-SHA256"||doc?.version!==1)throw Error("invalid_encrypted_telegram_credentials");
    const pemBytes=Uint8Array.from(atob(String(env.TT_CONTROL_TELEGRAM_PRIVATE_KEY||"").trim()),c=>c.charCodeAt(0));
    const key=await crypto.subtle.importKey("pkcs8",pemBytes,{name:"RSA-OAEP",hash:"SHA-256"},false,["decrypt"]);
    const values={};
    for(const name of ["bot_token","chat_id","webhook_secret"]){
      const encoded=String(doc?.[name]||"");
      if(!encoded)throw Error("telegram_credential_missing:"+name);
      const encrypted=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
      const plain=await crypto.subtle.decrypt({name:"RSA-OAEP"},key,encrypted);
      values[name]=new TextDecoder().decode(plain);
    }
    if(!/^\d{6,15}:[A-Za-z0-9_-]{25,}$/.test(values.bot_token)||
       !/^-?[0-9]{3,20}$/.test(values.chat_id)||
       !/^[A-Za-z0-9_-]{16,256}$/.test(values.webhook_secret)){
      throw Error("decrypted_telegram_credentials_invalid");
    }
    cached=values;
    expires=Date.now()+90_000;
  }
  return cached[field]||"";
}
