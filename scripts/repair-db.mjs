// Repara la base de datos del bot si algún índice quedó estropeado (pasó el 12-11-2026: el servidor se cortaba a
// medias de una escritura y la copia guardada quedaba con índices incoherentes → «database disk image is malformed»).
// Reconstruye solo las tablas afectadas, quitando las filas duplicadas que rompen la clave única. Si la base no tiene
// arreglo, sale con código 2 y el flujo usa una copia anterior.
// Uso: node scripts/repair-db.mjs <base.sqlite3>
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const file=process.argv[2];
if(!file||!fs.existsSync(file)){console.log('Reparación: no hay base de datos que revisar.');process.exit(0);}
const db=new DatabaseSync(file);
const check=()=>{try{return db.prepare('PRAGMA integrity_check(200)').all().map(r=>Object.values(r)[0]);}catch(e){return ['ERROR '+e.message];}};
let msgs=check();
if(msgs.length===1&&msgs[0]==='ok'){console.log('Base de datos: íntegra.');db.close();process.exit(0);}
console.log(`Base de datos con ${msgs.length} aviso(s): ${msgs.slice(0,3).join(' | ')}`);
const tables=new Set();
let hopeless=false;
for(const m of msgs){
  const ix=m.match(/index (\S+)/);
  if(ix){const row=db.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?").get(ix[1]);if(row)tables.add(row.tbl_name);else hopeless=true;}
  else hopeless=true;     // errores de páginas / estructura: no se arreglan reconstruyendo tablas
}
if(hopeless||!tables.size){console.log('Base de datos: daño que no se puede reparar con una reconstrucción.');db.close();process.exit(2);}
for(const T of tables){
  const t=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(T);
  const idx=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(T);
  const before=db.prepare(`SELECT COUNT(*) c FROM "${T}" NOT INDEXED`).get().c;
  db.exec('BEGIN');
  try{
    for(const i of idx)db.exec(`DROP INDEX "${i.name}"`);
    db.exec(`ALTER TABLE "${T}" RENAME TO "${T}__old"`);
    db.exec(t.sql);
    db.exec(`INSERT OR IGNORE INTO "${T}" SELECT * FROM "${T}__old" NOT INDEXED ORDER BY rowid`);
    db.exec(`DROP TABLE "${T}__old"`);
    for(const i of idx)db.exec(i.sql);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');console.log(`Reconstrucción de ${T} falló: ${e.message}`);db.close();process.exit(2);}
  const after=db.prepare(`SELECT COUNT(*) c FROM "${T}"`).get().c;
  console.log(`Tabla ${T} reconstruida: ${before} → ${after} filas (${before-after} duplicadas quitadas).`);
}
msgs=check();
if(msgs.length===1&&msgs[0]==='ok'){console.log('Base de datos reparada.');db.close();process.exit(0);}
console.log('Tras la reparación siguen avisos:',msgs.slice(0,3).join(' | '));
db.close();process.exit(2);
