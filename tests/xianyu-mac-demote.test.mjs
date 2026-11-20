import test from 'node:test';import assert from 'node:assert/strict';
import {noteMacVerification,macDemoteActive,expireMacDemote,DEMOTE_DEFAULTS} from '../scripts/xianyu-mac-demote.mjs';
const H=3600e3,M=60e3;
test('3 verificaciones en menos de 3 h degradan el Mac',()=>{
  let s=noteMacVerification(null,0);s=noteMacVerification(s,60*M);assert.equal(macDemoteActive(s,60*M),false);
  s=noteMacVerification(s,150*M);assert.equal(macDemoteActive(s,150*M),true);
});
test('3 verificaciones repartidas en más de 3 h no degradan',()=>{
  let s=noteMacVerification(null,0);s=noteMacVerification(s,2*H);s=noteMacVerification(s,4*H);
  assert.equal(macDemoteActive(s,4*H),false);assert.equal(s.events.length,2);
});
test('la misma verificación en varias búsquedas seguidas cuenta una vez',()=>{
  let s=noteMacVerification(null,0);s=noteMacVerification(s,2*M);s=noteMacVerification(s,5*M);
  assert.equal(s.events.length,1);
});
test('caduca solo: 2 h de espera + 4 h en la nube desde la tercera verificación',()=>{
  let s=noteMacVerification(null,0);s=noteMacVerification(s,30*M);s=noteMacVerification(s,60*M);
  const t0=60*M;
  assert.equal(macDemoteActive(s,t0+5.9*H),true);
  assert.equal(macDemoteActive(s,t0+6.01*H),false);
  assert.equal(expireMacDemote(s,t0+7*H).demote,null);
  assert.notEqual(expireMacDemote(s,t0+1*H).demote,null);
});
test('tras caducar, nuevas verificaciones vuelven a contar desde cero',()=>{
  let s=noteMacVerification(null,0);s=noteMacVerification(s,30*M);s=noteMacVerification(s,60*M);
  s=expireMacDemote(s,10*H);assert.equal(s.demote,null);
  s=noteMacVerification(s,10*H);assert.equal(macDemoteActive(s,10*H),false);
});
test('ajustes por entorno',()=>{
  assert.equal(DEMOTE_DEFAULTS.verifs,3);assert.equal(DEMOTE_DEFAULTS.switchMs,2*H);assert.equal(DEMOTE_DEFAULTS.recoverMs,4*H);
});
