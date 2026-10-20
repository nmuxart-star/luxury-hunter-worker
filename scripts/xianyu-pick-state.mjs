// Elige la sesión de Xianyu más fresca entre varias candidatas (la del repo,
// subida tras un login manual, y la renovada automáticamente en la ejecución
// anterior) según la caducidad de la cookie unb.
// Uso: node scripts/xianyu-pick-state.mjs <salida.json> <candidata1.json> [candidata2.json...]
import fs from 'node:fs';
import {readState} from './xianyu-session.mjs';

const [out,...candidates]=process.argv.slice(2);
let best=null;
for(const file of candidates){
  if(!file||!fs.existsSync(file))continue;
  try{
    const state=readState(file);
    const unb=(state.cookies||[]).find(c=>c.name==='unb');
    const exp=Number(unb?.expires)||0;
    if(!best||exp>best.exp)best={file,exp};
  }catch{}
}
if(!best){
  console.log('Xianyu: no hay ninguna sesión válida que elegir.');
  process.exit(3);
}
fs.copyFileSync(best.file,out);
console.log(`Xianyu: usando ${best.file} (unb hasta ${best.exp?new Date(best.exp*1000).toISOString().slice(0,16):'desconocido'})`);
