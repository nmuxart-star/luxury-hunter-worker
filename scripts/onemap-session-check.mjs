import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {ONEMAP_MEMBER_URL,isOneMapMemberPage,oneMapMemberId,oneMapOnlyStorageState} from './onemap-session.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stateFile=process.argv[2]||process.env.ONEMAP_STORAGE_STATE_FILE||path.join(root,'.onemap','storage-state.json');
let state;
try{
  state=oneMapOnlyStorageState(JSON.parse(fs.readFileSync(stateFile,'utf8')));
}catch(e){
  console.error(`One Map: archivo de sesión no válido (${e.message}).`);
  process.exit(2);
}

let browser;
try{
  const headed=process.env.ONEMAP_HEADED==='1'||
    (process.env.ONEMAP_HEADED!=='0'&&process.platform==='darwin');
  browser=await chromium.launch({
    headless:!headed
  });
  const context=await browser.newContext({storageState:state,locale:'en-US'});
  const page=await context.newPage();
  const response=await page.goto(ONEMAP_MEMBER_URL,{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(() => /Member ID\s*:/.test(document.body?.innerText||''),null,{timeout:12000}).catch(()=>{});
  const body=await page.locator('body').innerText({timeout:15000});
  if(!isOneMapMemberPage(page.url(),body)){
    const current=new URL(page.url());
    console.error(`One Map: comprobación en ${current.hostname}${current.pathname} (HTTP ${response?.status()||'?'}, My Account=${/\bMy Account\b/i.test(body)}, Member ID=${!!oneMapMemberId(body)}).`);
    const redirectedToLogin=/\/member\/(?:login|signin|sign-in)(?:\/|$)/i.test(new URL(page.url()).pathname);
    console.error(redirectedToLogin
      ?'One Map: la sesión ha caducado y la página pide iniciar sesión.'
      :'One Map: no se pudo confirmar el acceso al área privada.');
    process.exitCode=redirectedToLogin?2:1;
  }else{
    console.log(`One Map: sesión válida para la cuenta ${oneMapMemberId(body)}.`);
  }
}catch(e){
  console.error(`One Map: no se pudo verificar la sesión (${e.message}).`);
  process.exitCode=1;
}finally{
  await browser?.close().catch(()=>{});
}
