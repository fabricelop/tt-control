// Cloudflare Pages advanced mode. Serves the existing TT apps through service binding.
// This frontend does not proxy Telegram webhooks or unrelated TT Control endpoints.
const ROUTED_APIS=new Set([
  "/api/ttittulares-control","/api/ttittulares-run","/api/ttittulares-run-status",
  "/api/ttendencias-control","/api/ttendencias-run","/api/ttendencias-run-status"
]);
export default {
  async fetch(request,env){
    const url=new URL(request.url),path=url.pathname;
    const allowed=path==="/ttittulares"||path.startsWith("/ttittulares/")||
      path==="/ttendencias"||path.startsWith("/ttendencias/")||
      path.startsWith("/tt-shared/")||ROUTED_APIS.has(path);
    if(allowed){
      if(!env.TT_CONTROL_GATEWAY || typeof env.TT_CONTROL_GATEWAY.fetch!=="function")
        return Response.json({ok:false,error:"Gateway binding unavailable"},{status:503});
      return env.TT_CONTROL_GATEWAY.fetch(request);
    }
    if(path==="/")return env.ASSETS.fetch(request);
    if(path==="/health")return Response.json({ok:true,service:"tt-mobile-pages",gateway:"tt-control",mode:"internal-service-binding"},{headers:{"cache-control":"no-store"}});
    return new Response("Not found",{status:404});
  }
};
