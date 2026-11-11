// Pausa obligatoria entre una ejecución del bot y la siguiente (regla de Nil, 11-11-2026,
// para que Xianyu deje de pedir verificaciones). Se ejecuta ANTES de abrir ningún navegador,
// así que durante la pausa no se hace ninguna visita a Goofish.
// RUN_GAP_MINUTES (30 por defecto, 0 = sin pausa): minutos mínimos desde la última actividad
// registrada del bot. Un lanzamiento manual que fuerza todo (workflow_dispatch sin auto_chain)
// no espera: lo ha pedido Nil a propósito.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const gapMin=Number(process.env.RUN_GAP_MINUTES??30);
const manual=process.env.GITHUB_EVENT_NAME==='workflow_dispatch'&&process.env.LH_AUTO_CHAIN!=='1';
if(!(gapMin>0)){console.log('Pausa entre ejecuciones: desactivada.');process.exit(0);}
if(manual){console.log('Pausa entre ejecuciones: lanzamiento manual, no se espera.');process.exit(0);}

const dbFile=path.join(process.cwd(),'data','luxury-hunter.sqlite3');
if(!fs.existsSync(dbFile)){console.log('Pausa entre ejecuciones: sin estado anterior, no se espera.');process.exit(0);}

let last=0,hardUntil=0;
try{
  const db=new DatabaseSync(dbFile,{readOnly:true});
  const row=db.prepare("SELECT MAX(COALESCE(finished_at,started_at)) AS t FROM task_runs").get();
  last=Date.parse(row?.t||'')||0;
  // Bloqueo de red por «tráfico inusual» (4 h): no se abre nada hasta que acabe, y se reanuda con algo de margen.
  try{
    const hb=db.prepare("SELECT value_json FROM app_settings WHERE key='xianyu_hard_block'").get();
    const st=hb?JSON.parse(hb.value_json):null;
    const ignoreBefore=Date.parse(String(process.env.XIANYU_RISK_PAUSE_IGNORE_BEFORE||'').trim());
    const startedAt=Date.parse(st?.at||'');
    if(st&&!(Number.isFinite(ignoreBefore)&&Number.isFinite(startedAt)&&startedAt<=ignoreBefore))hardUntil=Number(st.until)||0;
  }catch{}
  db.close();
}catch(e){console.log('Pausa entre ejecuciones: no se pudo leer el historial ('+e.message+'), no se espera.');process.exit(0);}

const sleepMs=ms=>new Promise(r=>setTimeout(r,ms));
if(hardUntil>Date.now()){
  // Margen aleatorio de 5-20 min para no reanudar justo al segundo en que acaba la parada.
  const wait=hardUntil-Date.now()+(5+Math.random()*15)*60e3;
  console.log(`Xianyu parado por bloqueo de red: espero ${Math.ceil(wait/60000)} min (hasta que acabe la parada) sin tocar Goofish.`);
  await sleepMs(wait);
  last=0;   // tras una parada larga no hace falta más pausa de ejecuciones
  console.log('Fin de la parada; se reanuda.');
}
const ms=last+gapMin*60e3-Date.now();
if(!(ms>0)){console.log(`Pausa entre ejecuciones: ya pasaron ${gapMin} min desde la última actividad.`);process.exit(0);}
const wait=Math.min(ms,gapMin*60e3);
console.log(`Pausa entre ejecuciones: espero ${Math.ceil(wait/60000)} min antes de tocar Xianyu (mínimo ${gapMin} min entre ejecuciones).`);
await sleepMs(wait);
