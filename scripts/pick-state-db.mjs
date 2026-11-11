// Elige la copia más reciente de la base de datos del bot entre la guardada en el propio servidor ($HOME/.lh-state)
// y la recuperada del artefacto de GitHub. Así, si GitHub falla al guardar el estado, no se pierde (avisos ya enviados,
// gasto de IA, ritmo...). Uso: node scripts/pick-state-db.mjs <copia-local> <actual> <salida>
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const [local,current,out]=process.argv.slice(2);
function stamp(file){
  if(!file||!fs.existsSync(file))return -1;
  try{
    const db=new DatabaseSync(file,{readOnly:true});
    const r=db.prepare("SELECT MAX(COALESCE(finished_at,started_at)) AS t FROM task_runs").get();
    db.close();
    return Date.parse(r?.t||'')||0;
  }catch{return -1;}
}
const a=stamp(local),b=stamp(current);
if(a<0){console.log('Estado: no hay copia local utilizable; se usa el del artefacto.');process.exit(0);}
if(a>b){
  fs.mkdirSync(new URL('.',`file://${process.cwd()}/${out}`).pathname,{recursive:true});
  fs.copyFileSync(local,out);
  console.log(`Estado: la copia local del servidor es más reciente (${new Date(a).toISOString()} > ${b>0?new Date(b).toISOString():'sin artefacto'}); se usa esa.`);
}else console.log(`Estado: el artefacto (${new Date(b).toISOString()}) es igual o más reciente que la copia local; se usa el artefacto.`);
