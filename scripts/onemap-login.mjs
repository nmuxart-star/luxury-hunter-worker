// El usuario introduce sus credenciales directamente en una ventana de One Map.
// Se guarda únicamente la sesión de fromjapan.co.jp, fuera de Git.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline/promises';
import {spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
import {ONEMAP_MEMBER_URL,isOneMapMemberPage,oneMapMemberId,oneMapOnlyStorageState} from './onemap-session.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir=path.join(root,'.onemap');
const stateFile=path.join(dir,'storage-state.json');
fs.mkdirSync(dir,{recursive:true,mode:0o700});
fs.chmodSync(dir,0o700);

const context=await chromium.launchPersistentContext(path.join(dir,'profile'),{
  headless:false,viewport:{width:1280,height:860},locale:'en-US'
});
try{
  const page=context.pages()[0]||await context.newPage();
  await page.goto(ONEMAP_MEMBER_URL,{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(() => /Member ID\s*:/.test(document.body?.innerText||''),null,{timeout:12000}).catch(()=>{});
  let body=await page.locator('body').innerText({timeout:15000});
  if(!isOneMapMemberPage(page.url(),body)){
    console.log('Inicia sesión en la ventana de One Map. Completa tú la contraseña y cualquier verificación.');
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    try{await rl.question('Cuando veas tu cuenta, vuelve al terminal y pulsa Enter... ')}
    finally{rl.close()}
    await page.goto(ONEMAP_MEMBER_URL,{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForFunction(() => /Member ID\s*:/.test(document.body?.innerText||''),null,{timeout:12000}).catch(()=>{});
    body=await page.locator('body').innerText({timeout:15000});
  }
  if(!isOneMapMemberPage(page.url(),body)){
    const current=new URL(page.url());
    console.error(`One Map: página de comprobación ${current.hostname}${current.pathname}; My Account=${/\bMy Account\b/i.test(body)}; Member ID=${!!oneMapMemberId(body)}.`);
    throw new Error('No se pudo confirmar el acceso al área privada de One Map.');
  }
  const memberId=oneMapMemberId(body);
  const expectedMemberId=String(process.env.ONEMAP_EXPECTED_MEMBER_ID||'').trim();
  if(expectedMemberId&&memberId!==expectedMemberId){
    throw new Error('La sesión pertenece a una cuenta distinta de la que está abierta en Chrome.');
  }
  const state=oneMapOnlyStorageState(await context.storageState());
  const encoded=Buffer.from(JSON.stringify(state)).toString('base64');
  if(Buffer.byteLength(encoded)>48*1024){
    throw new Error('La sesión supera el límite de 48 KB de GitHub Actions Secrets.');
  }
  fs.writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});
  fs.chmodSync(stateFile,0o600);
  const check=spawnSync(process.execPath,['scripts/onemap-session-check.mjs',stateFile],{
    cwd:root,stdio:'inherit',env:{...process.env,ONEMAP_HEADED:'1'}
  });
  if(check.status!==0)throw new Error('La sesión guardada no funcionó en un navegador nuevo.');
  console.log(`Sesión local de One Map guardada para la cuenta ${memberId}.`);
  console.log('La sesión permanece en .onemap/storage-state.json y no se ha enviado a GitHub.');
}catch(e){
  console.error(`One Map: ${e.message}`);
  process.exitCode=1;
}finally{
  await context.close();
}
