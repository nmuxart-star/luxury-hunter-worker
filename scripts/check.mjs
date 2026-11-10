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
const setting=name=>String(process.env[name]??env[name]??'').trim();
const checks=[
  ['Node >= 24', Number(process.versions.node.split('.')[0]) >= 24, process.versions.node],
  ['.env exists', fs.existsSync(envFile), envFile],
  ['Xianyu (modo directo / Mac)', true, 'sin conector externo'],
  ['bunjang-cli local binary', fs.existsSync(path.join(root,'node_modules','.bin','bunjang-cli')), path.join(root,'node_modules','.bin','bunjang-cli')]
];
console.log('\nLUXURY HUNTER v1.4.3 - CHECK\n');
for(const [name,ok,detail] of checks) console.log(`${ok?'OK ':'ERR'}  ${name}  ${detail}`);
console.log('\nGemini:', env.GEMINI_API_KEY ? 'configured' : 'not configured (search still works; AI analysis will not)');
console.log(`\nNote: Xianyu se busca en modo directo o desde el Chrome del Mac. If Bunjang reports a missing Playwright browser, run: npm run browsers:install`);

console.log(`SMTP: ${env.SMTP_HOST && (env.EMAIL_FROM || env.SMTP_USER) ? 'configured' : 'not configured (email alerts will not send)'}`);
