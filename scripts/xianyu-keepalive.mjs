// Renueva la sesión de Xianyu visitando Goofish con el state guardado y
// reescribe el fichero con las cookies actualizadas.
// Uso: node scripts/xianyu-keepalive.mjs <state.json>
// Salida: escribe XIANYU_SESSION_STATUS=ok|expired|risk_control|missing|error en
// $GITHUB_ENV (si existe). Código 0 si la sesión es válida, 3 si no lo es.
import fs from 'node:fs';
import {chromium} from 'playwright';
import {readState,cookieSummary,isLoggedIn,mergeState,visitGoofish} from './xianyu-session.mjs';

const file=process.argv[2];
function report(status,detail){
  console.log(`Xianyu session: ${status}${detail?` · ${detail}`:''}`);
  if(process.env.GITHUB_ENV){
    fs.appendFileSync(process.env.GITHUB_ENV,`XIANYU_SESSION_STATUS=${status}\n`);
  }
}

if(!file||!fs.existsSync(file)){
  report('missing','no hay fichero de sesión');
  process.exit(3);
}

let browser;
try{
  const previous=readState(file);
  console.log('Antes :',JSON.stringify(cookieSummary(previous.cookies)));
  browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage','--no-sandbox']});
  const context=await browser.newContext({
    storageState:{cookies:previous.cookies||[],origins:previous.origins||[]},
    userAgent:previous?.env?.userAgent||previous?.environment?.userAgent||undefined,
    locale:'zh-CN',
    timezoneId:'Asia/Shanghai'
  });
  const {riskControl,sessionValid}=await visitGoofish(context);
  const fresh=await context.storageState();
  console.log('Después:',JSON.stringify(cookieSummary(fresh.cookies)));
  console.log('Goofish reconoce la sesión:',sessionValid===null?'no se sabe':sessionValid?'sí':'NO (Session过期)');
  if(isLoggedIn(fresh.cookies)){
    // Se guardan siempre las cookies renovadas: aunque la sesión haya
    // caducado en el servidor, siguen sirviendo para buscar.
    fs.writeFileSync(file,JSON.stringify(mergeState(previous,fresh),null,2));
  }
  if(sessionValid===false){
    report('expired','Goofish dice que la sesión ha caducado (npm run xianyu:login para renovarla)');
    process.exitCode=3;
  }else if(isLoggedIn(fresh.cookies)){
    report(riskControl?'risk_control':'ok',riskControl?'sesión válida pero Goofish pidió verificación anti-bot':'cookies renovadas');
  }else{
    report('expired','hay que volver a iniciar sesión: npm run xianyu:login');
    process.exitCode=3;
  }
}catch(e){
  report('error',e?.message||String(e));
  process.exitCode=3;
}finally{
  await browser?.close().catch(()=>{});
}
