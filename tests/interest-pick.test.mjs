import test from 'node:test';
import assert from 'node:assert/strict';
import {picksByInterest,capByInterest} from '../scripts/interest-pick.mjs';

test('picksByInterest: solo las tareas de intervalo largo; el Radar nunca',()=>{
  assert.equal(picksByInterest({task_name:'Dior Saddle',interval_minutes:180}),true);
  assert.equal(picksByInterest({task_name:'Hermes Kelly',interval_minutes:360}),true);
  assert.equal(picksByInterest({task_name:'Lady Dior',interval_minutes:60}),false);
  assert.equal(picksByInterest({task_name:'Radar oportunidades',interval_minutes:360}),false);
  assert.equal(picksByInterest({task_name:'X',interval_minutes:240},0),false);   // apagado
  assert.equal(picksByInterest(null),false);
  assert.equal(picksByInterest({task_name:'X'}),false);
});

test('capByInterest: se queda con los primeros (ya ordenados) y no quita lo pendiente de verificar',()=>{
  const it=(id,v=false)=>({id,_needsVerification:v});
  const {kept,dropped}=capByInterest([it(1),it(2,true),it(3),it(4),it(5)],2);
  assert.deepEqual(kept.map(x=>x.id),[1,2,3]);     // 2 normales + el de verificar
  assert.deepEqual(dropped.map(x=>x.id),[4,5]);
  assert.deepEqual(capByInterest([it(1),it(2)],10).dropped,[]);
  assert.deepEqual(capByInterest([],5),{kept:[],dropped:[]});
  assert.equal(capByInterest([it(1),it(2)],0).kept.length,1);   // como mínimo 1
});

import {pageIsSaturated,mergeUniqueById} from '../scripts/interest-pick.mjs';
test('pageIsSaturated: página llena y todo de las últimas 24 h → hay más dentro del margen',()=>{
  const now=Date.parse('2026-11-14T12:00:00Z');
  const mk=(n,horasAtras)=>Array.from({length:n},(_,i)=>({id:String(i),publishedAt:new Date(now-horasAtras(i)*3600e3).toISOString()}));
  assert.equal(pageIsSaturated(mk(30,i=>1+i*0.5),{now}),true);          // 30 anuncios, el más viejo de 15,5 h
  assert.equal(pageIsSaturated(mk(30,i=>i===29?30:2),{now}),false);     // uno de 30 h: el margen de 24 h ya se agotó
  assert.equal(pageIsSaturated(mk(20,i=>1+i*0.1),{now}),false);         // página no llena
  assert.equal(pageIsSaturated(mk(30,i=>1),{now,maxAgeHours:0.5}),false);
  assert.equal(pageIsSaturated([],{now}),false);
  assert.equal(pageIsSaturated(Array.from({length:30},(_,i)=>({id:String(i)})),{now}),false);   // sin fechas
});
test('mergeUniqueById: junta las dos páginas sin repetir anuncios',()=>{
  const m=mergeUniqueById([{id:'1'},{id:'2'}],[{id:'2'},{id:'3'}]);
  assert.deepEqual(m.map(x=>x.id),['1','2','3']);
  assert.deepEqual(mergeUniqueById(null,[{id:'9'}]).length,1);
});
