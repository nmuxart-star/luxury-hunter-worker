// Abre Goofish con la sesión del bot en una ventana real (pantalla virtual del
// servidor) para que Nil resuelva A MANO la verificación por escritorio remoto.
// No intenta resolver nada: solo carga la búsqueda, espera a que la verificación
// desaparezca y guarda las cookies resultantes.
// Uso: node scripts/xianyu-remote-captcha.mjs <state.json> [minutos]
// Escribe en $GITHUB_OUTPUT: result=ok|timeout|error y risk=seen|none
import fs from 'node:fs';
import {chromium} from 'playwright';
import {readState,cookieSummary,isLoggedIn,mergeState} from './xianyu-session.mjs';

const file=process.argv[2];
const minutes=Math.min(25,Math.max(2,Number(process.argv[3])||15));
const SEARCH_API='h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/';
const RISK_RE=/FAIL_SYS_USER_VALIDATE|RGV587|FAIL_SYS_ILLEGAL_ACCESS|punish|baxia|_____tmd_____/i;
const out=(k,v)=>{if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`${k}=${v}\n`);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

if(!file||!fs.existsSync(file)){console.error('Falta el fichero de sesión.');out('result','error');process.exit(3);}

const previous=readState(file);
console.log('Sesión antes:',JSON.stringify(cookieSummary(previous.cookies)));
const browser=await chromium.launch({
  headless:false,
  args:['--no-sandbox','--disable-dev-shm-usage','--window-position=0,0','--window-size=1280,800']
});
let result='timeout',risk='none';
try{
  const context=await browser.newContext({
    storageState:{cookies:previous.cookies||[],origins:previous.origins||[]},
    userAgent:previous?.env?.userAgent||previous?.environment?.userAgent||undefined,
    locale:'zh-CN',
    timezoneId:'Asia/Shanghai',
    viewport:{width:1260,height:700}
  });
  const page=await context.newPage();
  let gotResults=false;
  page.on('response',async r=>{
    if(!r.url().includes(SEARCH_API)||r.request().method()!=='POST')return;
    const t=await r.text().catch(()=>'');
    if(/RGV587|USER_VALIDATE/.test(t))risk='seen';
    else if(/"resultList":\[\s*\{/.test(t))gotResults=true;
  });
  const riskNow=async()=>RISK_RE.test(page.url())||
    await page.locator('div.baxia-dialog-mask').isVisible().catch(()=>false)||
    await page.locator('#nc_1_n1z, .nc-container, iframe[src*="punish"]').first().isVisible().catch(()=>false);

  const search='https://www.goofish.com/search?q='+encodeURIComponent('欧米茄 超霸');
  await page.goto(search,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
  console.log('Ventana abierta; esperando hasta',minutes,'min a que se resuelva la verificación.');

  const deadline=Date.now()+minutes*60e3;
  let clearFor=0,lastReload=Date.now();
  while(Date.now()<deadline){
    await sleep(2000);
    const r=await riskNow();
    if(r)risk='seen';
    if(!r&&gotResults){clearFor+=2;if(clearFor>=10){result='ok';break;}}
    else clearFor=0;
    // Resuelta la verificación pero sin lista: se vuelve a cargar la búsqueda (como mucho cada 30 s).
    if(risk==='seen'&&!r&&!gotResults&&Date.now()-lastReload>30e3){
      lastReload=Date.now();
      await page.goto(search,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});
    }
  }
  const fresh=await context.storageState();
  console.log('Sesión después:',JSON.stringify(cookieSummary(fresh.cookies)));
  if(result==='ok'&&isLoggedIn(fresh.cookies)){
    fs.writeFileSync(file,JSON.stringify(mergeState(previous,fresh),null,2));
  }else if(result==='ok'){
    result='timeout';
  }
}catch(e){
  console.error('Error:',e?.message||String(e));
  result='error';
}finally{
  await browser.close().catch(()=>{});
}
console.log(`Resultado: ${result} · verificación: ${risk}`);
out('result',result);
out('risk',risk);
