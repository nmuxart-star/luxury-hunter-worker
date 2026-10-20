// Inicio de sesión guiado en Xianyu (Goofish).
// 1. Abre una ventana de Chromium en goofish.com (perfil propio en .xianyu-profile,
//    así la próxima vez suele bastar con un clic o un escaneo).
// 2. Inicias sesión tú (QR con la app de Xianyu/Taobao). El script espera.
// 3. Guarda la sesión para el conector local y la cifra en cloud/xianyu-state.enc
//    (openssl te pide la contraseña; debe coincidir con el secreto de GitHub
//    XIANYU_STATE_PASSWORD).
// Uso: npm run xianyu:login
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {readState,cookieSummary,isLoggedIn,mergeState,visitGoofish} from './xianyu-session.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const localState=process.env.XIANYU_LOCAL_STATE||path.join(process.env.HOME,'ai-goofish-monitor-wangdaguo','state','Nil.json');
const encOut=path.join(root,'cloud','xianyu-state.enc');

const profileDir=path.join(root,'.xianyu-profile');
const context=await chromium.launchPersistentContext(profileDir,{
  headless:false,
  viewport:{width:1280,height:860},
  locale:'zh-CN'
});
const page=context.pages()[0]||await context.newPage();
await page.goto('https://www.goofish.com/',{waitUntil:'domcontentloaded'}).catch(()=>{});
console.log('\nSe ha abierto una ventana de Chromium en goofish.com.');
console.log('Inicia sesión (botón 登录, escanea el QR con la app de Xianyu o Taobao).');
console.log('Esperando hasta 10 minutos...\n');

let cookies=[];
const deadline=Date.now()+10*60*1000;
while(Date.now()<deadline){
  cookies=await context.cookies('https://www.goofish.com');
  if(isLoggedIn(cookies))break;
  await new Promise(r=>setTimeout(r,3000));
}
if(!isLoggedIn(cookies)){
  console.error('No se detectó el inicio de sesión. Vuelve a ejecutar npm run xianyu:login.');
  await context.close();
  process.exit(1);
}

console.log('Sesión detectada. Renovando cookies...');
await visitGoofish(context,{waitMs:4000});
const fresh=await context.storageState();
await context.close();
console.log('Cookies:',JSON.stringify(cookieSummary(fresh.cookies)));

let previous={};
try{previous=readState(localState);}catch{}
fs.mkdirSync(path.dirname(localState),{recursive:true});
fs.writeFileSync(localState,JSON.stringify(mergeState(previous,fresh),null,2),{mode:0o600});
console.log(`OK: sesión local guardada en ${localState}`);

console.log('\nAhora se cifra para la nube. Escribe la contraseña de XIANYU_STATE_PASSWORD');
console.log('(la misma que tienes en GitHub; si no la recuerdas, inventa una nueva y luego');
console.log('actualiza el secreto con: gh secret set XIANYU_STATE_PASSWORD --repo nmuxart-star/luxury-hunter-worker).\n');
const enc=spawnSync('openssl',['enc','-aes-256-cbc','-salt','-pbkdf2','-in',localState,'-out',encOut],{stdio:'inherit'});
if(enc.status!==0){
  console.error('No se pudo cifrar la sesión.');
  process.exit(1);
}
fs.chmodSync(encOut,0o600);
console.log(`\nOK: sesión cifrada en ${encOut}. Avisa a Claude para subirla al repo.`);
