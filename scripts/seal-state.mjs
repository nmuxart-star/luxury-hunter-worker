// Guarda una copia COHERENTE de la base de datos del bot. Abrirla recupera cualquier escritura que se quedara a medias
// (si el servidor se cortó a la fuerza) y VACUUM INTO escribe un fichero nuevo y limpio. Copiar el fichero tal cual
// podía guardar una base estropeada. Uso: node scripts/seal-state.mjs <origen> <destino>
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const [src,dest]=process.argv.slice(2);
if(!src||!dest||!fs.existsSync(src)){console.error('seal-state: falta el origen.');process.exit(1);}
try{
  const db=new DatabaseSync(src);
  const msgs=db.prepare('PRAGMA integrity_check(20)').all().map(r=>Object.values(r)[0]);
  if(!(msgs.length===1&&msgs[0]==='ok')){console.error('seal-state: la base tiene avisos de integridad:',msgs.slice(0,2).join(' | '));db.close();process.exit(3);}
  fs.rmSync(dest,{force:true});
  db.exec(`VACUUM INTO '${dest.replace(/'/g,"''")}'`);
  db.close();
  console.log(`Estado sellado en ${dest} (${Math.round(fs.statSync(dest).size/1024)} KB).`);
}catch(e){console.error('seal-state falló:',e.message);process.exit(1);}
