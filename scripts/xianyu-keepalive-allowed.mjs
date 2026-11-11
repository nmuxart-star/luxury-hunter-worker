// ¿Puede el servidor visitar Goofish ahora (renovar la sesión) sin romper la regla de una sola IP?
// Con XIANYU_VIA_MAC=calendar: solo en los días de la nube (XIANYU_CLOUD_DAYS; por defecto todos) y cuando la última búsqueda salió de la nube,
// y nunca durante una parada por bloqueo de red. Con otros modos, siempre. Código de salida 0 = sí, 1 = no.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

if(String(process.env.XIANYU_VIA_MAC||'prefer').toLowerCase()!=='calendar'){console.log('Renovación de sesión: permitida (modo no calendario).');process.exit(0);}
const day=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Madrid',weekday:'short'}).format(new Date()).toLowerCase().slice(0,3);
const raw=String(process.env.XIANYU_CLOUD_DAYS||'all').toLowerCase().trim();
const days=raw==='all'||raw==='*'?[day]:raw.split(',').map(x=>x.trim().slice(0,3)).filter(Boolean);
if(!days.includes(day)){console.log(`Renovación de sesión: no (hoy es ${day}; la nube solo busca ${days.join(', ')}).`);process.exit(1);}
let route=null,hard=0;
try{
  const file=path.join(process.cwd(),'data','luxury-hunter.sqlite3');
  if(fs.existsSync(file)){
    const db=new DatabaseSync(file,{readOnly:true});
    const get=k=>{const r=db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(k);try{return r?JSON.parse(r.value_json):null;}catch{return null;}};
    route=get('xianyu_ip_route')?.route||null;
    hard=Number(get('xianyu_hard_block')?.until)||0;
    db.close();
  }
}catch{}
if(hard>Date.now()){console.log('Renovación de sesión: no (parada por bloqueo de red).');process.exit(1);}
if(route!=='cloud'){console.log(`Renovación de sesión: no (la última búsqueda salió de ${route||'ninguna parte'}, no de la nube).`);process.exit(1);}
console.log('Renovación de sesión: permitida (fin de semana y la nube es la IP activa).');
