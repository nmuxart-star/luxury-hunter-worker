// Prueba real: busca en Xianyu, abre la ficha del primer anuncio y lo envía
// a Telegram con fotos, enlace a la app y botones. No usa IA.
// Uso (GitHub Actions): node scripts/telegram-listing-check.mjs "<búsqueda>" <minEur> <maxEur>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base='http://127.0.0.1:8217';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const [query='迪奥 戴妃包',minEur='700',maxEur='1700']=process.argv.slice(2);
const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'8217',DISABLE_SCHEDULER:'1',EXTRA_SOURCES:'off',TELEGRAM_POLL:'off',OPENAI_API_KEY:'',SMTP_HOST:''},stdio:['ignore','inherit','inherit']});
const post=async(u,b)=>{const r=await fetch(base+u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return r.json();};
let code=1;
try{
  for(let i=0;i<60;i++){try{if((await fetch(base+'/api/status')).ok)break;}catch{}await sleep(1000);}
  const s=await post('/api/search/global',{product:query,sources:['xianyu'],xianyu_queries:[query],minEur:Number(minEur),maxEur:Number(maxEur)});
  const first=(s.items||[])[0];
  console.log('Xianyu:',JSON.stringify(s.status?.xianyu?.perQuery||[]));
  if(!first)throw new Error('sin resultados');
  const d=await post('/api/xianyu/detail',{listingIds:[first.id]});
  console.log('Ficha:',JSON.stringify(d.items?.[0]||{}).slice(0,200));
  const t=await post('/api/telegram/test-listing',{listingId:first.id});
  console.log('Telegram:',JSON.stringify(t));
  code=t.sent?0:1;
}catch(e){console.log('Error:',e.message);}
finally{child.kill('SIGKILL');}
process.exit(code);
