// Utilidades compartidas de sesión Xianyu (Goofish) para login y keep-alive.
// Nunca imprime valores de cookies: solo nombres y fechas de caducidad.
import fs from 'node:fs';

// unb identifica la sesión y dura ~3 días; havana_lgc2_77 es el token
// "recordarme" (~30 días) que permite a Goofish volver a emitir unb al visitar
// la web con la sesión activa. Visitar la web a menudo es lo que la mantiene viva.
export const SESSION_COOKIES=['unb','cookie2','havana_lgc2_77','sgcookie','_m_h5_tk'];

export function readState(file){
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  return raw&&typeof raw==='object'?raw:{};
}

export function cookieSummary(cookies=[]){
  const now=Date.now()/1000;
  const out={};
  for(const name of SESSION_COOKIES){
    const c=cookies.find(x=>x.name===name&&String(x.domain||'').includes('goofish'));
    if(!c){out[name]='ausente';continue;}
    const e=Number(c.expires);
    out[name]=!Number.isFinite(e)||e<0
      ? 'sesión'
      : e<now
        ? `CADUCADA ${new Date(e*1000).toISOString().slice(0,16)}`
        : new Date(e*1000).toISOString().slice(0,16);
  }
  return out;
}

export function isLoggedIn(cookies=[]){
  const now=Date.now()/1000;
  const unb=cookies.find(x=>x.name==='unb'&&String(x.domain||'').includes('goofish'));
  if(!unb||!unb.value)return false;
  const e=Number(unb.expires);
  return !Number.isFinite(e)||e<0||e>now;
}

// Conserva los campos extra del formato del conector (entorno, cabeceras...)
// y sustituye cookies/origins por los recién renovados.
export function mergeState(previous,fresh){
  return {
    ...(previous&&typeof previous==='object'?previous:{}),
    cookies:fresh.cookies||[],
    origins:fresh.origins||previous?.origins||[]
  };
}

export async function visitGoofish(context,{waitMs=6000}={}){
  const page=await context.newPage();
  let riskControl=false;
  // Lo que dice el servidor de Goofish sobre la sesión (no solo las cookies):
  // true = sesión reconocida, false = Session过期, null = no se supo.
  let sessionValid=null;
  page.on('response',async r=>{
    const u=r.url();
    if(!/mtop\.taobao\.idlemessage\.pc\.loginuser\.get|mtop\.idle\.web\.user\.page\.nav/.test(u))return;
    const t=await r.text().catch(()=>'');
    if(/SUCCESS::/.test(t))sessionValid=sessionValid??true;
    if(/SESSION_EXPIRED|FAIL_SYS_TOKEN_EMPTY|未登录|FAIL_SYS_ILLEGAL_ACCESS/.test(t))sessionValid=false;
    if(/RGV587|USER_VALIDATE/.test(t))riskControl=true;
  });
  try{
    for(const url of ['https://www.goofish.com/','https://www.goofish.com/personal']){
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
      await page.waitForTimeout(waitMs);
      const url2=page.url();
      if(/punish|baxia|captcha|_____tmd_____/i.test(url2))riskControl=true;
      if(await page.locator('div.baxia-dialog-mask').isVisible().catch(()=>false))riskControl=true;
    }
  }finally{
    await page.close().catch(()=>{});
  }
  return {riskControl,sessionValid};
}
