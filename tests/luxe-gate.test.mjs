import test from 'node:test';
import assert from 'node:assert/strict';
import {luxeVerdict,tooCheapVerdict} from '../scripts/luxe-gate.mjs';

test('Luxe: el margen exigido es el 30 % (antes bastaba el 20 %) y el riesgo alto nunca entra',()=>{
  assert.equal(luxeVerdict({price:600,netLow:250,landed:700}).ok,true);          // 36 %
  assert.equal(luxeVerdict({price:600,netLow:210,landed:700}).ok,true);          // 30 %: justo en el mínimo
  assert.equal(luxeVerdict({price:600,netLow:175,landed:700}).ok,false);         // 25 %: antes entraba como aviso suave
  assert.equal(luxeVerdict({risk:'HIGH',price:600,netLow:400,landed:700}).ok,false);
  assert.equal(luxeVerdict({price:600}).ok,false);                                // sin margen ni Resumen
});
test('Luxe: el Resumen es una segunda opinión; sin pronóstico solo entra si el Resumen lo respalda',()=>{
  const s={target:640,n:12,margin:30};
  assert.equal(luxeVerdict({price:600,netLow:250,landed:700,summary:s}).ok,true);
  assert.equal(luxeVerdict({price:700,netLow:250,landed:700,summary:s}).ok,false);          // por encima del máximo del Resumen
  assert.equal(luxeVerdict({price:700,netLow:250,landed:700,summary:{...s,n:3}}).ok,true);  // pocas fichas: no se usa
  assert.equal(luxeVerdict({price:600,noRefs:true,summary:s}).ok,true);
  assert.equal(luxeVerdict({price:700,noRefs:true,summary:s}).ok,false);
  assert.equal(luxeVerdict({price:600,noRefs:true}).ok,false);
  assert.equal(luxeVerdict({price:600,noRefs:true,summary:null}).why.includes('Resumen'),true);
});
test('demasiado barato: suelo de Miu Miu y proporción sobre el Resumen',()=>{
  const floors=[{re:/缪缪|miu\s?miu|miumiu/i,min:450,label:'Miu Miu'}];
  assert.ok(tooCheapVerdict({title:'【正品代购】Miu Miu/缪缪 Wander黑金褶皱腋下包 礼盒 保卡',price:317,brandFloors:floors}));
  assert.ok(tooCheapVerdict({title:'MIUMIU 腋下包',price:303,brandFloors:floors}));
  assert.equal(tooCheapVerdict({title:'MIU MIU/缪缪 Wander 小羊皮',price:601,brandFloors:floors}),null);   // los buenos de 600-800 €
  assert.equal(tooCheapVerdict({title:'Louis Vuitton Speedy',price:150,brandFloors:floors,summaryRef:1000,summaryN:30}).term,'150<300');
  assert.equal(tooCheapVerdict({title:'Louis Vuitton Speedy',price:350,brandFloors:floors,summaryRef:1000,summaryN:30}),null);
  assert.equal(tooCheapVerdict({title:'Louis Vuitton Speedy',price:150,summaryRef:1000,summaryN:3}),null);   // pocas fichas
  assert.equal(tooCheapVerdict({title:'x',price:0}),null);
});
