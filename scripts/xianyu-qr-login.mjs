// Renueva la sesión de Xianyu sin contraseña: abre el login de Goofish, envía
// el código QR a Telegram y espera a que Nil lo escanee con la app de Xianyu
// (闲鱼APP → 扫一扫). Si se escanea, guarda la sesión nueva en <state.json>.
// Uso: node scripts/xianyu-qr-login.mjs <state.json> [minutos de espera]
// Requiere TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID. Código 0 = sesión renovada.
import fs from 'node:fs';
import {chromium} from 'playwright';
import {readState,mergeState,cookieSummary} from './xianyu-session.mjs';

const file=process.argv[2];
const waitMin=Math.max(1,Math.min(10,Number(process.argv[3]||4)));
const token=process.env.TELEGRAM_BOT_TOKEN;
const chat=process.env.TELEGRAM_CHAT_ID;
const tgBase=String(process.env.TELEGRAM_API_BASE||'https://api.telegram.org').replace(/\/$/,'');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

if(!file||!token||!chat){
  console.log('Xianyu QR: falta el fichero de sesión o Telegram; no se intenta.');
  process.exit(2);
}

async function tg(method,body){
  const isForm=body instanceof FormData;
  const r=await fetch(`${tgBase}/bot${token}/${method}`,{
    method:'POST',
    headers:isForm?undefined:{'content-type':'application/json'},
    body:isForm?body:JSON.stringify({chat_id:chat,...body}),
    signal:AbortSignal.timeout(20000)
  });
  const data=await r.json().catch(()=>({}));
  if(!data.ok)throw new Error(`Telegram ${method}: ${data.description||r.status}`);
  return data.result;
}

async function sendQr(png,caption){
  const fd=new FormData();
  fd.append('chat_id',chat);
  fd.append('caption',caption);
  fd.append('photo',new Blob([png],{type:'image/png'}),'xianyu-qr.png');
  return tg('sendPhoto',fd);
}

let previous={};
try{previous=readState(file);}catch{}
const ua=previous?.headers?.['User-Agent']||previous?.env?.navigator?.userAgent||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage','--no-sandbox']});
let ok=false;
let sent=null;
try{
  const context=await browser.newContext({userAgent:ua,locale:'zh-CN',timezoneId:'Asia/Shanghai',viewport:{width:1280,height:800},deviceScaleFactor:2});
  const page=await context.newPage();
  let sessionValid=false;
  page.on('response',async r=>{
    if(!/mtop\.taobao\.idlemessage\.pc\.loginuser\.get|mtop\.idle\.web\.user\.page\.nav/.test(r.url()))return;
    const t=await r.text().catch(()=>'');
    if(/SUCCESS::/.test(t))sessionValid=true;
  });

  const findQr=async()=>{
    for(let i=0;i<20;i++){
      for(const f of page.frames()){
        if(!/passport\.goofish\.com/.test(f.url()))continue;
        const cands=f.locator('[class*="qrcode"] canvas, [class*="qrcode"] img, canvas');
        const n=await cands.count();
        for(let k=0;k<n;k++){
          const el=cands.nth(k);
          const box=await el.boundingBox().catch(()=>null);
          if(box&&box.width>=100&&box.height>=100)return el;
        }
      }
      await sleep(1000);
    }
    return null;
  };

  await page.goto('https://www.goofish.com/',{waitUntil:'domcontentloaded',timeout:45000});
  await sleep(4000);
  // Si no aparece solo, abrir el login desde el botón de la cabecera.
  if(!(await findQr().catch(()=>null))){
    await page.getByText('登录',{exact:true}).first().click({timeout:5000}).catch(()=>{});
  }
  const deadline=Date.now()+waitMin*60e3;
  let attempts=0;
  while(Date.now()<deadline&&!ok&&attempts<3){
    const qr=await findQr();
    if(!qr){console.log('Xianyu QR: no se encontró el código QR en la página.');break;}
    const png=await qr.screenshot();
    attempts++;
    const mins=Math.max(1,Math.round((deadline-Date.now())/60e3));
    sent=await sendQr(png,`🔑 Xianyu necesita renovar la sesión.\nAbre la app de Xianyu (闲鱼) → 扫一扫 (arriba a la izquierda) y escanea este código. Válido unos ${mins} min.\nSi no es buen momento, ignóralo: el bot sigue buscando y te lo volverá a pedir más adelante.`);
    console.log(`Xianyu QR: código enviado a Telegram (intento ${attempts}).`);
    // Cada QR caduca en ~2 min: se espera y, si caduca, se envía uno nuevo.
    const qrDeadline=Math.min(deadline,Date.now()+110e3);
    while(Date.now()<qrDeadline){
      await sleep(3000);
      const cookies=await context.cookies();
      const unb=cookies.find(c=>c.name==='unb'&&c.value&&/goofish/.test(c.domain));
      if(unb){
        await page.goto('https://www.goofish.com/',{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
        await sleep(5000);
        if(sessionValid||unb){ok=true;break;}
      }
    }
    if(!ok){
      await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{});
      await sleep(3000);
      await page.getByText('登录',{exact:true}).first().click({timeout:5000}).catch(()=>{});
    }
  }
  if(ok){
    const fresh=await context.storageState();
    const merged=mergeState(previous,fresh);
    merged.headers={...(previous.headers||{}),'User-Agent':ua};
    fs.writeFileSync(file,JSON.stringify(merged,null,2),{mode:0o600});
    console.log('Xianyu QR: sesión renovada ·',JSON.stringify(cookieSummary(fresh.cookies)));
    await tg('sendMessage',{text:'✅ Sesión de Xianyu renovada. ¡Gracias!'}).catch(()=>{});
  }else{
    console.log('Xianyu QR: no se escaneó a tiempo; se seguirá con la sesión actual.');
    if(sent?.message_id){
      await tg('editMessageCaption',{message_id:sent.message_id,caption:'⌛ Código caducado. El bot te enviará otro más adelante; mientras tanto sigue buscando con normalidad.'}).catch(()=>{});
    }
  }
}catch(e){
  console.log('Xianyu QR: error',e?.message||e);
}finally{
  await browser.close().catch(()=>{});
}
process.exit(ok?0:3);
