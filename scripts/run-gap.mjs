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

let last=0;
try{
  const db=new DatabaseSync(dbFile,{readOnly:true});
  const row=db.prepare("SELECT MAX(COALESCE(finished_at,started_at)) AS t FROM task_runs").get();
  db.close();
  last=Date.parse(row?.t||'')||0;
}catch(e){console.log('Pausa entre ejecuciones: no se pudo leer el historial ('+e.message+'), no se espera.');process.exit(0);}

const ms=last+gapMin*60e3-Date.now();
if(!(ms>0)){console.log(`Pausa entre ejecuciones: ya pasaron ${gapMin} min desde la última actividad.`);process.exit(0);}
const wait=Math.min(ms,gapMin*60e3);
console.log(`Pausa entre ejecuciones: espero ${Math.ceil(wait/60000)} min antes de tocar Xianyu (mínimo ${gapMin} min entre ejecuciones).`);
await new Promise(r=>setTimeout(r,wait));
