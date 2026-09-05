import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(root,'.env');
const env={};
if(fs.existsSync(envFile)) {
  for(const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/)) {
    if(!line.includes('=') || line.trim().startsWith('#')) continue;
    const i=line.indexOf('=');
    const k=line.slice(0,i).trim();
    let v=line.slice(i+1).trim();
    if(v.includes('$HOME')) v=v.replaceAll('$HOME',process.env.HOME||'');
    env[k]=v;
  }
}
const base=(env.XIANYU_BASE_URL||'http://127.0.0.1:8000').replace(/\/$/,'');
let xianyuLive=false;
let xianyuDetail=base;
try {
  const c=new AbortController();
  const t=setTimeout(()=>c.abort(),3000);
  const r=await fetch(base+'/health',{signal:c.signal});
  clearTimeout(t);
  xianyuLive=r.ok;
  if(!r.ok) xianyuDetail+=` (HTTP ${r.status})`;
} catch(e) { xianyuDetail+=` (${e.message})`; }
const checks=[
  ['Node >= 24', Number(process.versions.node.split('.')[0]) >= 24, process.versions.node],
  ['.env exists', fs.existsSync(envFile), envFile],
  ['Xianyu live connector', xianyuLive, xianyuDetail],
  ['bunjang-cli local binary', fs.existsSync(path.join(root,'node_modules','.bin','bunjang-cli')), path.join(root,'node_modules','.bin','bunjang-cli')]
];
console.log('\nLUXURY HUNTER v1.4.3 - CHECK\n');
for(const [name,ok,detail] of checks) console.log(`${ok?'OK ':'ERR'}  ${name}  ${detail}`);
console.log('\nGemini:', env.GEMINI_API_KEY ? 'configured' : 'not configured (search still works; AI analysis will not)');
console.log('\nNote: Xianyu must be running on port 8000 during live searches. If Bunjang reports a missing Playwright browser, run: npm run browsers:install');

console.log(`SMTP: ${env.SMTP_HOST && (env.EMAIL_FROM || env.SMTP_USER) ? 'configured' : 'not configured (email alerts will not send)'}`);
